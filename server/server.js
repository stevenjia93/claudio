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
import * as spotifyTaste from './taste-sources/spotify.js';
import { assemble, assembleIntro } from './context.js';

const DJ_AUTO_INTRO = process.env.DJ_AUTO_INTRO !== '0' && process.env.DJ_AUTO_INTRO !== 'false';

const PORT = process.env.PORT || 8080;
const MOCK_CLAUDE = process.env.MOCK_CLAUDE === '1';

const app = express();
// 走 Cloudflare Tunnel / nginx 等反代时, 透过 X-Forwarded-* 拿到真实协议 + 客户端 IP
app.set('trust proxy', 1);
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
    feedback: s.feedback || { liked: [], disliked: [] },
    playMode: s.playMode || 'sequential',
    djLanguage: s.djLanguage || 'en'
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

// 走一次 Claude 流水线: 解析歌名 + TTS + 广播 + 返回 brain 结果
// 抽出来给 /api/chat 和 /api/queue/refresh 复用
//
// 时序设计 (避免用户干等 30s):
//   1. Claude.invoke (~5-15s)
//   2. setQueue([]) 先清队列 — 自然语言 chat = "换一批" 语义
//   3. TTS 合成 (~3-5s); 等 TTS 好就立刻广播 dj_broadcast (queue=[])
//   4. HTTP 早 return (不等歌解析)
//   5. 后台并行解析歌, 完了 pushQueue + 广播 queue_update
//
// 前端 speakThenPlay 看到队列空时不调 playNext, set pendingAutoStart;
// queue_update 到了再切到第一首新歌, 把当前歌打断.
async function runChatTurn(text) {
  state.appendMessage('user', text);
  const prompt = await assemble(text);
  const brain = MOCK_CLAUDE ? await claude.mockInvoke(prompt) : await claude.invoke(prompt);

  state.appendMessage('assistant', brain.say);

  // 自然语言 = "换一批", 清空队列 (直连命令 play_direct 走另一条路, 保持追加行为)
  state.setQueue([]);

  // TTS 是关键路径, await 它; 歌解析挪到后台 (Promise 不 await)
  const audioUrl = brain.say
    ? await tts.synthesize(brain.say, { lang: state.get().djLanguage }).catch(e => {
        console.warn('[tts] 合成挂了:', e.message);
        return null;
      })
    : null;

  // 立刻广播 DJ — 队列空, 当前歌不动 (前端会 duck, 等 queue_update 再切)
  broadcast({
    type: 'dj_broadcast',
    say: brain.say,
    reason: brain.reason,
    segue: brain.segue,
    audio_url: audioUrl,
    queue: []
  });

  // 后台并行解析所有歌, 完了 push + 广播 queue_update.
  // 故意不 await — HTTP 就早 return, 浏览器输入框立刻可用
  resolvePlayList(brain.play).then(items => {
    if (!items.length) return;
    state.pushQueue(items);
    items.forEach(it => state.appendPlay({ ...it, source: 'claude' }));
    broadcast({ type: 'queue_update', queue: state.get().queue });
  }).catch(e => {
    console.warn('[music] 后台解析挂了:', e.message);
  });

  // resolved 后台还没完, 返空数组. 前端不再依赖这个判 0-songs.
  return { kind: 'chat', ...brain, resolved: [], audio_url: audioUrl };
}

// ——— API: 聊天 ———
app.post('/api/chat', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text 必填' });

  const decision = route(text);

  try {
    // 1) 控制命令
    if (decision.kind === 'control') {
      state.appendMessage('user', text);
      broadcast({ type: 'control', cmd: decision.payload.cmd });
      state.appendMessage('assistant', `[${decision.payload.cmd}]`);
      return res.json({ kind: 'control', cmd: decision.payload.cmd });
    }

    // 2) 直连放歌
    if (decision.kind === 'play_direct') {
      state.appendMessage('user', text);
      const items = await resolvePlayList([decision.payload.query]);
      state.pushQueue(items);
      items.forEach(it => state.appendPlay({ ...it, source: 'direct' }));
      broadcast({ type: 'queue_update', queue: state.get().queue });
      state.appendMessage('assistant', `已加入队列: ${items.map(i => i.song).join(', ')}`);
      return res.json({ kind: 'play_direct', added: items });
    }

    // 3) 自然语言: 走 Claude 大脑
    const result = await runChatTurn(decision.payload.text);
    res.json(result);
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
        try { audioUrl = await tts.synthesize(brain.say, { lang: state.get().djLanguage }); } catch (e) {
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
    // Web Audio analyser 必须看到 CORS header 才能拿到真实音频数据 (否则全 0)
    res.setHeader('Access-Control-Allow-Origin', '*');
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

// ——— API: 通用音频 CORS 代理 ———
// netease 等 CDN 直链不带 CORS header → 前端 <audio crossorigin> 会拒绝播,
// Web Audio analyser 也拿不到数据. 这里中转一下加 CORS, 顺手处理 Range 让 seek 工作.
// 白名单只放音乐 CDN, 防当成开放 proxy 被滥用.
const AUDIO_PROXY_HOSTS = /\.(music\.126\.net|music\.163\.com|qq\.com|googlevideo\.com)$/i;
app.get('/api/proxy/audio', async (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== 'string' || !/^https?:\/\//.test(target)) {
    return res.status(400).json({ error: 'url 必填 (http/https)' });
  }
  let host;
  try { host = new URL(target).hostname; }
  catch { return res.status(400).json({ error: 'url 解析失败' }); }
  if (!AUDIO_PROXY_HOSTS.test(host)) {
    return res.status(403).json({ error: '不在白名单的 host: ' + host });
  }
  try {
    const upstream = await fetch(target, {
      headers: {
        // 部分音乐 CDN 看 Referer 防盗链 — 给一个常见值
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0',
        // 透传客户端 Range 让 seek 工作
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`upstream ${upstream.status}`);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const range = upstream.headers.get('content-range');
    if (range) res.setHeader('Content-Range', range);
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    if (upstream.status === 206) res.status(206);
    const { Readable } = await import('node:stream');
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.pipe(res);
    req.on('close', () => { try { nodeStream.destroy(); } catch {} });
  } catch (e) {
    console.warn(`[audio proxy] ${target.slice(0, 80)}:`, e.message);
    res.status(502).json({ error: e.message });
  }
});

// ——— API: 看哪些音源在跑 ———
// ——— API: DJ 个人介绍卡 ———
// 现在走 dj-card.js 模块, 内容由 Claude 从 taste.md + Spotify 数据反推出来.
// 服务端按文件 hash 缓存, 输入没变就直接复用. 不每次开浮层都烧 API.
import * as djCard from './dj-card.js';
app.get('/api/dj-card', async (req, res) => {
  try {
    const card = await djCard.getCard();
    res.json({
      tagline: card.tagline,
      description: card.description || [],
      genres: card.genres || [],
      topShort: card.topShort || [],
      topLong: card.topLong || [],
      listeners: clients.size,
      onAir: '24/7',
    });
  } catch (e) {
    console.warn('[dj-card]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 用户的 DJ 头像 — 扔 prompts/dj-avatar.{png,jpg,jpeg,webp} 进去自动用
app.get('/dj-avatar', async (req, res) => {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = path.resolve(`../prompts/dj-avatar.${ext}`);
    try {
      await fs.access(p);
      return res.sendFile(p);
    } catch {}
  }
  res.status(404).end();
});

app.get('/api/sources', (req, res) => {
  res.json(music.listSources());
});

// ——— API: 播放模式 ———
app.put('/api/mode', (req, res) => {
  const { mode } = req.body || {};
  try {
    state.setPlayMode(mode);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  broadcast({ type: 'mode_update', playMode: mode });
  res.json({ ok: true, mode });
});

// ——— API: DJ 语种 (en / zh) ———
// 切换语种 = 切 voice + persona, 不动当前队列 (语种是个轻操作, 不打断正在听的)
app.put('/api/dj-language', (req, res) => {
  const { language } = req.body || {};
  try {
    state.setDjLanguage(language);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  broadcast({ type: 'dj_language_update', djLanguage: language });
  res.json({ ok: true, djLanguage: language });
});

// ——— API: 换一批 (清队列 + 让 Claude 重新推) ———
app.post('/api/queue/refresh', async (req, res) => {
  // 1) 先清队列, 广播让前端立即看到队列空
  state.setQueue([]);
  broadcast({ type: 'queue_update', queue: [] });

  // 2) 走一次 chat 流水线, 固定 prompt
  try {
    const result = await runChatTurn('换一批不一样的');
    res.json(result);
  } catch (e) {
    console.error('[refresh] 出错:', e);
    res.status(500).json({ error: e.message });
  }
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

// 后台异步刷 Spotify 听歌信号 (24h TTL, 不阻塞启动)
spotifyTaste.refreshIfStale().then(result => {
  if (result === 'refreshed') console.log('[spotify] 听歌信号已刷新');
  else if (result === 'cached') console.log('[spotify] 听歌信号缓存 (< 24h)');
  else if (result === 'no-auth') console.log('[spotify] 没授权, 跳过 (要的话跑 scripts/spotify-auth.js)');
  // 'failed' 状态: refreshIfStale 内部已 console.warn, 这里不重复打
}).catch(e => {
  console.warn('[spotify] refresh 异步挂了 (不影响启动):', e.message);
});

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
