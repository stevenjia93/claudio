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
import * as state from './state.js';

const TASTE_FILE   = path.resolve('../user/taste.md');
const SPOTIFY_FILE = path.resolve('../user/spotify-listening.json');
const CACHE_FILE   = path.resolve('../state/dj-card-cache.json');

// Prompt 变了就改这个数字, 旧缓存自动失效不用手动 rm
const PROMPT_VERSION = 2;

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

// 站内数据 — 聚合用户在 Claudio 里听了什么, 喜欢什么
function summarizeClaudioListening() {
  const s = state.get();

  // 按 artist 聚合次数 (字典序后取 top 10)
  const artistCount = {};
  for (const p of (s.plays || [])) {
    const a = (p.artist || '').trim();
    if (!a) continue;
    artistCount[a] = (artistCount[a] || 0) + 1;
  }
  const topArtists = Object.entries(artistCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, c]) => `${name} (${c} 次)`)
    .join(', ');

  const liked = (s.feedback?.liked || []).slice(-15)
    .map(f => `${f.song} - ${f.artist}`).join('\n');

  const totalPlays = (s.plays || []).length;
  const totalLiked = (s.feedback?.liked || []).length;

  return { topArtists, liked, totalPlays, totalLiked };
}

function buildPrompt(taste, spotify, claudio) {
  const top = spotify?.artists || {};
  const shortNames  = (top.short_term  || []).map(a => a.name).slice(0, 15).join(', ');
  const mediumNames = (top.medium_term || []).map(a => a.name).slice(0, 15).join(', ');
  const longNames   = (top.long_term   || []).map(a => a.name).slice(0, 15).join(', ');
  const likedSample = (spotify?.liked || []).slice(0, 30)
    .map(t => `${t.name} - ${t.artist}`).join('\n');

  return `你在为一个个人 AI 电台 DJ — Claudio — 写一段个人 bio. 这段 bio 会在用户点 Claudio 名字时弹出来, 应该让 ta 觉得 "这个 DJ 真的懂我".

⚠ 这是给普通人看的, 不是 README. 不要用以下技术词或营销腔: "taste.md" / "JSON" / "数据" / "算法" / "驱动" / "选品机器" / "好物分享" / "热爱音乐" / "海量" / "精选" / "智能". 像写一个真人电台主持人的 bio 那样.

# 用户口味画像 (用户自己写的)
${taste || '(用户还没填)'}

# 用户最近 4 周常听 (Spotify)
${shortNames || '(数据少)'}

# 用户最近 6 个月常听 (Spotify)
${mediumNames || '(数据少)'}

# 用户长期常听 (Spotify)
${longNames || '(数据少)'}

# 用户 Spotify 收藏夹样本
${likedSample || '(没收藏)'}

# 用户在 Claudio 里听过的
共播放 ${claudio.totalPlays} 次, ❤ 标了 ${claudio.totalLiked} 首.
最常听的艺人: ${claudio.topArtists || '(还在攒)'}
最近 ❤ 的歌:
${claudio.liked || '(还没标)'}

---

# 输出 — 严格 JSON, 不要 markdown 围栏

{
  "tagline": "...",
  "description": ["...", "...", "..."],
  "genres": ["...", "...", "..."]
}

# 字段约束

- **tagline**: 一行短句, 6-15 字, 中英都行. 像 "一开机我就打碟" / "Your taste is showing" / "深夜不睡的电台" 这种 catch phrase. 像真人主持人的"招牌口头禅", **不能用技术词**
- **description**: 数组 3 行
  - 第 1 行: 陈述身份, **必须以 "你的" 开头**, 不要写具体人名. 例如 "你的私人 DJ, 像懂你的朋友" / "你的 24/7 电台, 跟着心情走" — 不要"taste.md"这种
  - 第 2 行: 讲 Claudio 怎么工作, 用人话. 像 "你说什么, 我放什么" / "Your mood is my prompt"
  - 第 3 行: attitude / 立场. 像 "不照搬热门, 只挑对你" / "I hate algorithm. I have taste"
  - 每行 10-25 字
- **genres**: 数组 7-10 个. 反映用户**实际**听啥. 全小写 + 短横线, 例如 "jazz-hiphop", "indie-folk", "post-punk", "shibuya-kei", "lofi". 中文流派也行, 例如 "90s 华语". 不要笼统的 "pop" "rock". **不要把艺人名当流派** (例如 "taylor-swift" 是艺人不是流派, 应该是 "country-pop" 之类)

# 风格指南

- 用户的口味画像是底座, Spotify + Claudio 站内数据是补充 — 三者冲突时信用户嘴上说的
- description 可以从 taste.md 引用 1-2 个具体艺人名字让人觉得真懂 ta, 但不要 list 一长串
- 站内数据 (在 Claudio 里听过的) 跟 Spotify 数据一起看, 找重叠
- description 不要太完美 / 太营销, 有点小幽默 / 自嘲感`;
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
      '你的私人 DJ, 像懂你的朋友 🎧',
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

  const claudio = summarizeClaudioListening();
  // hash 含 PROMPT_VERSION + 站内数据 (plays 总数 + liked 总数), prompt 改了
  // 或者听新歌了都自然 invalidate 重生成. liked song 列表用其 string 长度
  // 当 proxy (差不多够区分).
  const claudioFingerprint = `${claudio.totalPlays}|${claudio.totalLiked}|${(claudio.liked || '').length}`;
  const hash = hashInputs(`v${PROMPT_VERSION}`, taste, spotifyRaw, claudioFingerprint);
  const cached = await loadCache();
  let generated;

  if (cached && cached.hash === hash && cached.result) {
    generated = cached.result;
  } else {
    try {
      const prompt = buildPrompt(taste, spotify, claudio);
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
