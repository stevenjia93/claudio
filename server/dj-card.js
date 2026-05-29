// dj-card.js — 个人介绍卡内容生成器
//
// 拿 user/taste.md + user/spotify-listening.json 给 Claude, 让它写 tagline +
// 3 行 description + 7-10 个流派 tag. 按 SHA1(taste + spotify) 缓存到
// state/dj-card-cache.json, 输入没变就直接复用, 不每次开浮层就烧一次 API.
//
// 后续 (Phase 2) 加 Last.fm 数据时, 也是 merge 进 prompt + 更新 hash key.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const TASTE_FILE   = path.resolve('../user/taste.md');
const SPOTIFY_FILE = path.resolve('../user/spotify-listening.json');
const CACHE_FILE   = path.resolve('../state/dj-card-cache.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.CLAUDIO_MODEL || 'claude-sonnet-4-5-20250929';
const PROXY   = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent   = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

async function readOr(filepath, fallback = '') {
  try { return await fs.readFile(filepath, 'utf8'); }
  catch { return fallback; }
}

function hashInputs(...contents) {
  const h = crypto.createHash('sha1');
  for (const c of contents) h.update(c || '');
  return h.digest('hex');
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveCache(data) {
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch { /* 缓存写不进, 算了 */ }
}

function buildPrompt(taste, spotify) {
  const top = spotify?.artists || {};
  const shortNames  = (top.short_term  || []).map(a => a.name).slice(0, 15).join(', ');
  const mediumNames = (top.medium_term || []).map(a => a.name).slice(0, 15).join(', ');
  const longNames   = (top.long_term   || []).map(a => a.name).slice(0, 15).join(', ');
  const likedSample = (spotify?.liked || []).slice(0, 30)
    .map(t => `${t.name} - ${t.artist}`).join('\n');

  return `你在为一个个人 AI 电台主持人 Claudio 生成"个人介绍卡片"内容. 这张卡片会在用户点 Claudio 名字时弹出来, 应该让 ta 觉得 "Claudio 真的懂我".

# 用户手写的口味档案 (taste.md)
${taste || '(用户还没写)'}

# 用户最近 4 周 Spotify Top Artists
${shortNames || '(数据少)'}

# 用户最近 6 个月 Spotify Top Artists
${mediumNames || '(数据少)'}

# 用户长期 Spotify Top Artists
${longNames || '(数据少)'}

# 用户 Spotify Liked Songs 样本 (最近 30 首)
${likedSample || '(没 liked)'}

---

# 输出 — 严格 JSON, 不要 markdown 围栏

{
  "tagline": "...",
  "description": ["...", "...", "..."],
  "genres": ["...", "...", "..."]
}

# 字段约束

- **tagline**: 一行短句, 6-15 字, 中英都行. 像 "一开机我就打碟" / "Your taste is showing" 这种 catch phrase. 不要陈词滥调, 不要 "热爱音乐" 这种空话
- **description**: 数组 3 行. 第 1 行陈述身份 — **必须写 "你的"**, 不要写具体人名 (不知道用户是谁). 例如 "你的私人 DJ, 会打碟的 taste.md 🎧". 第 2 行讲 Claudio 怎么工作 (像 "Your mood is my prompt"). 第 3 行 attitude / 立场 (像 "I hate algorithm. I have taste"). 每行 10-25 字
- **genres**: 数组 7-10 个. 反映用户**实际**听啥, 不要笼统的 "pop" "rock". 全小写 + 短横线, 例如 "jazz-hiphop", "indie-folk", "post-punk", "shibuya-kei", "lofi". 中文流派也行, 例如 "90s 华语"

# 风格指南

- taste.md 是底座, Spotify 是补充 — 二者冲突时信 taste.md (用户嘴上说不爱 EDM 但 Spotify 显示听了不少, 那就尊重嘴上)
- description 里允许引用一两个具体艺人名字 (从 taste.md 里挑), 让卡片看着真懂这个人
- description 不要太完美 / 太营销, 有点小幽默或自嘲感`;
}

async function callClaude(prompt) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY 没设');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
    agent,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`API ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  return extractJson(text);
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
}

function fallback() {
  return {
    tagline: '一开机我就打碟',
    description: [
      '你的私人 DJ, 会打碟的 taste.md 🎧',
      'Your mood is my prompt.',
      'I hate algorithm. I have taste.',
    ],
    genres: ['ambient', 'indie-folk', 'jazz-hiphop', 'post-punk', 'neo-classical', 'lofi', '90s 华语'],
  };
}

export async function getCard() {
  const taste = await readOr(TASTE_FILE);
  const spotifyRaw = await readOr(SPOTIFY_FILE);
  let spotify = null;
  try { spotify = JSON.parse(spotifyRaw); } catch {}

  const hash = hashInputs(taste, spotifyRaw);
  const cached = await loadCache();
  let generated;

  if (cached && cached.hash === hash && cached.result) {
    generated = cached.result;
  } else {
    try {
      const prompt = buildPrompt(taste, spotify);
      generated = (await callClaude(prompt)) || fallback();
    } catch (e) {
      console.warn('[dj-card] Claude 生成失败, 用 fallback:', e.message);
      generated = fallback();
    }
    await saveCache({
      hash,
      result: generated,
      generatedAt: new Date().toISOString(),
    });
  }

  // 顺手附上 Spotify 的"最近沉迷" / "长期挚爱" 给前端直接渲染, 不进缓存
  // (这俩本身就是 spotify-listening.json 的子集, 跟着它实时变)
  return {
    ...generated,
    topShort: (spotify?.artists?.short_term || []).slice(0, 6).map(a => a.name),
    topLong:  (spotify?.artists?.long_term  || []).slice(0, 6).map(a => a.name),
  };
}
