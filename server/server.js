// server.js — Claudio 主入口
// HTTP: POST /api/chat · GET /api/now /api/next /api/taste /api/plan/today · WS /stream
// 静态: /pwa/* 和 /tts/*.mp3(ElevenLabs 缓存)

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';

import * as state from './state.js';
import * as music from './music.js';
import * as claude from './claude.js';
import * as tts from './tts.js';
import { route } from './router.js';
import { assemble, assembleIntro } from './context.js';

const DJ_AUTO_INTRO = process.env.DJ_AUTO_INTRO !== '0' && process.env.DJ_AUTO_INTRO !== 'false';

const PORT = process.env.PORT || 8080;
const MOCK_CLAUDE = process.env.MOCK_CLAUDE === '1';

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('../pwa')));
app.use('/tts', express.static(tts.cacheDir()));  // 真人声音频直接静态伺服

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

// ——— WebSocket 广播 ———
const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  const s = state.get();
  ws.send(JSON.stringify({
    type: 'hello',
    nowPlaying: s.nowPlaying,
    queue: s.queue,
    feedback: s.feedback || { liked: [], disliked: [] }
  }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ——— 把 Claude 说的歌名转成可播队列 (并行)———
async function resolvePlayList(playNames) {
  const results = await Promise.allSettled(
    playNames.map(name => music.findPlayable(name))
  );
  const resolved = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[music] 解析失败 "${playNames[i]}":`, r.reason?.message);
    } else if (!r.value) {
      console.warn(`[music] 没找到能播的: ${playNames[i]}`);
    } else {
      const hit = r.value;
      resolved.push({
        source: hit.source,
        song: hit.name,
        artist: hit.artist,
        album: hit.album,
        picUrl: hit.picUrl,
        url: hit.url,
        duration: hit.duration,
        id: hit.id
      });
    }
  });
  return resolved;
}

// ——— API: 聊天 ———
app.post('/api/chat', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text 必填' });

  state.appendMessage('user', text);
  const decision = route(text);

  try {
    // 1) 控制命令
    if (decision.kind === 'control') {
      broadcast({ type: 'control', cmd: decision.payload.cmd });
      state.appendMessage('assistant', `[${decision.payload.cmd}]`);
      return res.json({ kind: 'control', cmd: decision.payload.cmd });
    }

    // 2) 直连放歌
    if (decision.kind === 'play_direct') {
      const items = await resolvePlayList([decision.payload.query]);
      state.pushQueue(items);
      items.forEach(it => state.appendPlay({ ...it, source: 'direct' }));
      broadcast({ type: 'queue_update', queue: state.get().queue });
      state.appendMessage('assistant', `已加入队列: ${items.map(i => i.song).join(', ')}`);
      return res.json({ kind: 'play_direct', added: items });
    }

    // 3) 自然语言: 走 Claude 大脑
    const prompt = await assemble(decision.payload.text);
    const brain = MOCK_CLAUDE ? await claude.mockInvoke(prompt) : await claude.invoke(prompt);

    state.appendMessage('assistant', brain.say);

    // 歌曲解析和 TTS 合成同时跑,谁慢谁就是瓶颈,不再串行
    const itemsP = resolvePlayList(brain.play);
    const audioP = brain.say
      ? tts.synthesize(brain.say).catch(e => {
          console.warn('[tts] 合成挂了:', e.message);
          return null;
        })
      : Promise.resolve(null);
    const [items, audioUrl] = await Promise.all([itemsP, audioP]);
    state.pushQueue(items);
    items.forEach(it => state.appendPlay({ ...it, source: 'claude' }));

    broadcast({
      type: 'dj_broadcast',
      say: brain.say,
      reason: brain.reason,
      segue: brain.segue,
      audio_url: audioUrl,       // 有值 → 前端播这个;null → 前端 fallback 浏览器 TTS
      queue: state.get().queue
    });

    res.json({ kind: 'chat', ...brain, resolved: items, audio_url: audioUrl });
  } catch (e) {
    console.error('[chat] 出错:', e);
    res.status(500).json({ error: e.message });
  }
});

// ——— API: 当前播放 ———
app.get('/api/now', (req, res) => {
  res.json(state.get().nowPlaying);
});

app.get('/api/next', async (req, res) => {
  const next = state.popQueue();
  if (!next) return res.json(null);
  const lastPlayed = state.get().nowPlaying;

  // DJ 间奏判定: 每 djBreakAt 首歌 (随机 2-4) 插一段
  const s = state.get();
  s.playsSinceDjBreak = (s.playsSinceDjBreak || 0) + 1;
  const shouldIntro = DJ_AUTO_INTRO
    && lastPlayed
    && s.playsSinceDjBreak >= (s.djBreakAt || 2);

  let djIntro = null;
  if (shouldIntro) {
    s.playsSinceDjBreak = 0;
    s.djBreakAt = 2 + Math.floor(Math.random() * 3);   // 下次 2/3/4 首
    try {
      const prompt = await assembleIntro({ nextSong: next, lastPlayed, queue: s.queue });
      const brain = await claude.invokeIntro(prompt);
      if (brain.say) {
        state.appendMessage('assistant', brain.say);
        let audioUrl = null;
        try { audioUrl = await tts.synthesize(brain.say); } catch (e) {
          console.warn('[dj-intro tts]', e.message);
        }
        djIntro = { say: brain.say, audio_url: audioUrl };
      }
    } catch (e) {
      console.warn('[dj-intro]', e.message);
    }
  }

  state.setNowPlaying(next);

  // 先发 dj_intro (如果有), 再发 now_playing — 客户端能拿到 intro 边说边放
  if (djIntro) {
    broadcast({ type: 'dj_intro', ...djIntro });
  }
  broadcast({ type: 'now_playing', nowPlaying: next, queue: state.get().queue });
  res.json(next);
});

app.post('/api/playing', (req, res) => {
  const { song } = req.body || {};
  state.setNowPlaying(song);
  broadcast({ type: 'now_playing', nowPlaying: song, queue: state.get().queue });
  res.json({ ok: true });
});

// ——— API: 歌词 ———
// 新路径带 source: /api/lyric/:source/:id
app.get('/api/lyric/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!id) return res.status(400).json({ error: 'id 必填' });
  try {
    const lrc = await music.lyric(id, source);
    res.json({ id, source, lyric: lrc || '' });
  } catch (e) {
    console.warn(`[lyric · ${source}] ${id}:`, e.message);
    res.json({ id, source, lyric: '' });
  }
});

// 旧路径(没带 source) → 默认主源
app.get('/api/lyric/:id', async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'id 必填' });
  try {
    const lrc = await music.lyric(id);
    res.json({ id, lyric: lrc || '' });
  } catch (e) {
    console.warn('[lyric]', e.message);
    res.json({ id, lyric: '' });
  }
});

// ——— API: YT Music 流代理 ———
// 浏览器不能直拉 YouTube,这里 pipe play-dl 的 stream
app.get('/api/proxy/yt/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const ytmusic = music.sources.ytmusic;
    const { stream, type } = await ytmusic.streamAudio(videoId);
    res.setHeader('Content-Type', type === 'webm' ? 'audio/webm' : 'audio/mp4');
    res.setHeader('Cache-Control', 'no-store');
    stream.pipe(res);
    stream.on('error', e => {
      console.warn(`[yt proxy] stream ${videoId}:`, e.message);
      try { res.end(); } catch {}
    });
    req.on('close', () => {
      try { stream.destroy(); } catch {}
    });
  } catch (e) {
    console.warn(`[yt proxy] ${videoId}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ——— API: 看哪些音源在跑 ———
app.get('/api/sources', (req, res) => {
  res.json(music.listSources());
});

// ——— API: like / dislike / clear 反馈 ———
app.post('/api/feedback', (req, res) => {
  const { action, song } = req.body || {};
  if (!['like', 'dislike', 'clear'].includes(action)) {
    return res.status(400).json({ error: 'action 要是 like / dislike / clear' });
  }
  if (!song || !song.song) return res.status(400).json({ error: 'song 必填' });
  state.addFeedback(action, song);
  broadcast({ type: 'feedback', action, song, feedback: state.get().feedback });
  res.json({ ok: true });
});

// ——— API: 队列管理 (重排 / 删除) ———
app.delete('/api/queue/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const removed = state.removeFromQueue(idx);
  if (!removed) return res.status(404).json({ error: 'index 越界' });
  broadcast({ type: 'queue_update', queue: state.get().queue });
  res.json({ ok: true, removed });
});

app.put('/api/queue', (req, res) => {
  const { queue } = req.body || {};
  if (!Array.isArray(queue)) return res.status(400).json({ error: 'queue 必须是数组' });
  state.setQueue(queue);
  broadcast({ type: 'queue_update', queue });
  res.json({ ok: true });
});

// 立即播 (从 query 现搜): 喜欢里双击 / 历史里双击都走这个
app.post('/api/play-now', async (req, res) => {
  const { song, artist } = req.body || {};
  if (!song) return res.status(400).json({ error: 'song 必填' });
  const query = `${song} ${artist || ''}`.trim();
  try {
    const hit = await music.findPlayable(query);
    if (!hit?.url) return res.status(404).json({ error: '没找到能播的' });
    const item = {
      source: hit.source, song: hit.name, artist: hit.artist,
      album: hit.album, picUrl: hit.picUrl, url: hit.url,
      duration: hit.duration, id: hit.id
    };
    state.setNowPlaying(item);
    state.appendPlay({ ...item, source: 'replay' });
    broadcast({ type: 'now_playing', nowPlaying: item, queue: state.get().queue });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 已播过列表
app.get('/api/history', (req, res) => {
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
  const plays = state.get().plays || [];
  // 倒序 + 去重 (同一首歌只留最新一次)
  const seen = new Set();
  const out = [];
  for (let i = plays.length - 1; i >= 0 && out.length < limit; i--) {
    const p = plays[i];
    const key = `${(p.song || '').toLowerCase()}|${(p.artist || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  res.json(out);
});

// 重听历史里某首 (插队立即播)
app.post('/api/history/replay', (req, res) => {
  const { song } = req.body || {};
  if (!song?.url) return res.status(400).json({ error: 'song.url 必填' });
  state.setNowPlaying(song);
  state.appendPlay({ ...song, source: song.source || 'replay' });
  broadcast({ type: 'now_playing', nowPlaying: song, queue: state.get().queue });
  res.json(song);
});

// 立即跳到队列里的某首播放 (插队)
app.post('/api/queue/play/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const removed = state.removeFromQueue(idx);
  if (!removed) return res.status(404).json({ error: 'index 越界' });
  state.setNowPlaying(removed);
  state.appendPlay({ ...removed, source: removed.source || 'queue' });
  broadcast({ type: 'now_playing', nowPlaying: removed, queue: state.get().queue });
  res.json(removed);
});

app.get('/api/taste', async (req, res) => {
  const taste = await fs.readFile(path.resolve('../user/taste.md'), 'utf8').catch(() => '');
  const routines = await fs.readFile(path.resolve('../user/routines.md'), 'utf8').catch(() => '');
  res.json({ taste, routines });
});

app.get('/api/plan/today', (req, res) => {
  res.json(state.get().plan);
});

// ——— 启动 ———
await state.load();

// 找局域网 IP,启动时打出来,手机要用
import os from 'node:os';
function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log(`\n🎙  Claudio @ http://localhost:${PORT}`);
  if (ip) console.log(`   局域网: http://${ip}:${PORT}  ← 手机同 WiFi 打开这个`);
  console.log(`   WebSocket: ws://localhost:${PORT}/stream`);
  if (MOCK_CLAUDE) console.log('   ⚠  MOCK_CLAUDE=1,没调真 claude');
  tts.report();
  console.log(`   网易云 API 假定在 ${process.env.NCM_BASE || 'http://localhost:3000'}\n`);
});
