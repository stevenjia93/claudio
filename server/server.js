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
import { assemble } from './context.js';

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
  ws.send(JSON.stringify({ type: 'hello', nowPlaying: s.nowPlaying, queue: s.queue }));
  ws.on('close', () => clients.delete(ws));
});

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

// ——— 把 Claude 说的歌名转成可播队列 ———
async function resolvePlayList(playNames) {
  const resolved = [];
  for (const name of playNames) {
    try {
      const hit = await music.findPlayable(name);
      if (hit) {
        resolved.push({
          song: hit.name,
          artist: hit.artist,
          album: hit.album,
          url: hit.url,
          duration: hit.duration,
          id: hit.id
        });
      } else {
        console.warn(`[music] 没找到能播的: ${name}`);
      }
    } catch (e) {
      console.warn(`[music] 解析失败 "${name}":`, e.message);
    }
  }
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

    const items = await resolvePlayList(brain.play);
    state.pushQueue(items);
    items.forEach(it => state.appendPlay({ ...it, source: 'claude' }));

    state.appendMessage('assistant', brain.say);

    // 4) TTS 合成(如果配了 ElevenLabs)— 不等完成就先响应,慢了就 fallback
    //    但 WS 广播时我们想带上 audio_url,所以这里 await
    //    ElevenLabs turbo 大概 1-3s,可接受
    let audioUrl = null;
    if (brain.say) {
      try {
        audioUrl = await tts.synthesize(brain.say);
      } catch (e) {
        console.warn('[tts] 合成挂了:', e.message);
      }
    }

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

app.get('/api/next', (req, res) => {
  const next = state.popQueue();
  if (!next) return res.json(null);
  state.setNowPlaying(next);
  broadcast({ type: 'now_playing', nowPlaying: next, queue: state.get().queue });
  res.json(next);
});

app.post('/api/playing', (req, res) => {
  const { song } = req.body || {};
  state.setNowPlaying(song);
  broadcast({ type: 'now_playing', nowPlaying: song, queue: state.get().queue });
  res.json({ ok: true });
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
