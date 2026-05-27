// tts.js — 语音管线
// Fish Audio 没接上,先用 ElevenLabs(英式 RP 念十四行诗那种质感)
// 缓存: 相同文本只调一次 API,存成 mp3,省钱

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'IRHApOXLvnW57QJPQH2P';
const VOICE_ID_ZH = process.env.ELEVENLABS_VOICE_ID_ZH || '9lHjugDhwqoxA5MhX0az';
const MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
// turbo_v2_5 是速度/质量/价格平衡点;想更好音质改成 eleven_multilingual_v2
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

const CACHE_DIR = path.resolve('../tts_cache');

// 进程内轻缓存,避免同一段文本同时被多次请求
const inflight = new Map();

/**
 * 生成 TTS 音频,返回可公开访问的 URL 路径
 * @param {string} text
 * @param {object} [opts] - { lang: 'en'|'zh' } 选 voice; 默认 en
 * @returns {Promise<string|null>} '/tts/<hash>.mp3' 或 null(配置不全/失败)
 */
export async function synthesize(text, opts = {}) {
  if (!API_KEY) {
    return null;  // 没配 key,前端会 fallback 到浏览器 TTS
  }
  if (!text || !text.trim()) return null;

  const voiceId = opts.lang === 'zh' ? VOICE_ID_ZH : VOICE_ID;

  const hash = crypto.createHash('sha1').update(`${voiceId}:${MODEL}:${text}`).digest('hex');
  const fileName = `${hash}.mp3`;
  const filePath = path.join(CACHE_DIR, fileName);
  const urlPath = `/tts/${fileName}`;

  // 1) 磁盘缓存命中,直接返回
  try {
    await fs.access(filePath);
    return urlPath;
  } catch { /* 不存在,继续 */ }

  // 2) 并发去重
  if (inflight.has(hash)) return inflight.get(hash);

  const task = doSynth(text, filePath, urlPath, voiceId).finally(() => {
    inflight.delete(hash);
  });
  inflight.set(hash, task);
  return task;
}

async function doSynth(text, filePath, urlPath, voiceId) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'content-type': 'application/json',
      accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      voice_settings: {
        stability: 0.45,          // 低 = 更有表现力,高 = 更稳定
        similarity_boost: 0.75,
        style: 0.35,              // 十四行诗那种有情绪的感觉
        use_speaker_boost: true
      }
    }),
    agent
  });

  if (!r.ok) {
    const err = await r.text();
    console.warn(`[tts] ElevenLabs ${r.status}: ${err.slice(0, 200)}`);
    return null;
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(filePath, buf);
  return urlPath;
}

/**
 * 启动时打印一下配置状态
 */
export function report() {
  if (!API_KEY) {
    console.log('[tts] 未配 ELEVENLABS_API_KEY,将 fallback 到浏览器原生 TTS');
    return;
  }
  console.log(`[tts] ElevenLabs 就绪 · voice(en)=${VOICE_ID} · voice(zh)=${VOICE_ID_ZH} · model=${MODEL}`);
}

/**
 * 给外部(server.js)暴露缓存目录,方便做 static serving
 */
export function cacheDir() {
  return CACHE_DIR;
}
