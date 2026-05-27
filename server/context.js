// context.js — 提示词组装盒子
// 对应施工图第三层:每次触发把这 6 片粘成 prompt
//   ① 系统提示词   prompts/dj-persona.md
//   ② 用户语料     user/*.md
//   ③ 环境注入     weather · calendar · now
//   ④ 已检索记忆   state.db · plays
//   ⑤ 用户输入/工具结果
//   ⑥ 执行轨迹     scheduler · webhook

import fs from 'node:fs/promises';
import path from 'node:path';
import * as state from './state.js';

async function readOr(filepath, fallback = '') {
  try { return await fs.readFile(filepath, 'utf8'); }
  catch { return fallback; }
}

// 双语 DJ persona 配置: 切 persona 文件 + 间奏报幕的语种约束
const DJ_LANG_CFG = {
  en: {
    personaFile: 'dj-persona.md',
    introLengthHint: '30-90 字英文 (不是 90 词!), 像真电台 DJ 报幕一样',
    introSayHint: 'your line here, 30-90 英文字, spoken cadence',
    fallbackPersona: '你是 Claudio,一个私人 AI 电台 DJ。',
  },
  zh: {
    personaFile: 'dj-persona-zh.md',
    introLengthHint: '30-90 字中文, 一两句话, 留白; 不要"接下来这首"那种播音腔',
    introSayHint: '一句中文, 30-90 字, 像台北午夜电台念的节奏',
    fallbackPersona: '你是 Claudio,一个台湾午夜电台女声 DJ。',
  },
};

/**
 * 组装完整的 prompt,交给 claude.js 去 spawn
 * @param {string} userInput 本次用户说的话
 * @param {object} opts 额外上下文
 */
export async function assemble(userInput, opts = {}) {
  // ① 系统提示词 — 按当前 djLanguage 选 persona
  const langCfg = DJ_LANG_CFG[state.get().djLanguage] || DJ_LANG_CFG.en;
  const persona = await readOr(
    path.resolve(`../prompts/${langCfg.personaFile}`),
    langCfg.fallbackPersona
  );

  // ② 用户语料
  const taste = await readOr(path.resolve('../user/taste.md'));
  const routines = await readOr(path.resolve('../user/routines.md'));
  const playlistsRaw = await readOr(path.resolve('../user/playlists.json'), '{}');
  const spotifyRaw = await readOr(path.resolve('../user/spotify-listening.json'), '');
  const spotifyBlock = formatSpotifyBlock(spotifyRaw);

  // ③ 环境注入
  const now = new Date();
  const env = {
    now: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    dayOfWeek: ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()],
    hour: now.getHours(),
    // v2: weather, calendar 接进来
    ...opts.env
  };

  // ④ 已检索记忆: 最近 10 次播放 + 最近 6 条对话 + 用户反馈 (♥/✕)
  const s = state.get();
  const recentPlays = s.plays.slice(-10).map(p => `  · ${p.song} - ${p.artist}`).join('\n');
  const recentMessages = s.messages.slice(-6)
    .map(m => `  ${m.role === 'user' ? '我' : 'Claudio'}: ${m.content.slice(0, 120)}`)
    .join('\n');

  const fb = s.feedback || { liked: [], disliked: [] };
  const liked = fb.liked.slice(-15).map(f => `  ♥ ${f.song} - ${f.artist}`).join('\n');
  const disliked = fb.disliked.slice(-15).map(f => `  ✕ ${f.song} - ${f.artist}`).join('\n');

  // ⑤ 用户输入 在下面单独放
  // ⑥ 执行轨迹 v2 再加

  const prompt = `${persona}

---
# 关于我的品味
${taste}

# 我的作息
${routines}

# 我爱的歌单 (JSON)
${playlistsRaw}
${spotifyBlock}
---
# 现在
${env.now} (${env.dayOfWeek},${env.hour} 点)

# 最近播放过
${recentPlays || '(还没播过)'}

# 我标记过喜欢的 (多推类似的)
${liked || '(还没标过)'}

# 我标记过不喜欢的 (避开 / 别再推)
${disliked || '(还没标过)'}

# 最近几句对话
${recentMessages || '(这是第一句)'}

---
# 我现在说
${userInput}

---
# 你必须以下面这个严格的 JSON 回复,不要带 markdown 代码块,不要多写一个字:
{
  "say": "你作为 DJ 要说的一段话,自然口语,50-150 字",
  "play": ["歌名 - 歌手", "歌名 - 歌手", "..."],
  "reason": "你为什么挑这几首 (给我复盘用,简短)",
  "segue": "播完这批歌后过渡到下一段的引子 (一句话)"
}

play 数组里每首写成 "歌名 - 歌手" 的格式,**6 到 10 首**,要一口气把队列填够 25-40 分钟,
顺序也要讲究: 开场暖,中段走起来,收尾留白或为下一段铺路。
如果我只是闲聊没让你放歌,play 可以是空数组 []。`;

  return prompt;
}

// ————————————————————————————————————————
// Spotify 听歌信号格式化
// ————————————————————————————————————————
function formatSpotifyBlock(rawJson) {
  if (!rawJson) return '';
  let data;
  try { data = JSON.parse(rawJson); } catch { return ''; }

  const top = data.artists || {};
  const liked = (data.liked || []).slice(0, 150);
  const lines = (arr) => (arr || []).map(a => a.name).join(' / ');

  // 空数据不出整节
  if (!liked.length && !lines(top.short_term)) return '';

  const synced = data.syncedAt
    ? new Date(data.syncedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '?';

  return `
# 我的 Spotify 听歌信号 (自动同步 · ${synced})

## Top Artists
- 最近 4 周: ${lines(top.short_term)}
- 最近 6 个月: ${lines(top.medium_term)}
- 长期 (多年): ${lines(top.long_term)}

## Liked Songs (最近收藏 ${liked.length} 首)
${liked.map(t => `- ${t.name} - ${t.artist}`).join('\n')}`;
}

/**
 * 间奏报幕: 一首歌结束, 切到下一首前,
 * 让 DJ 说一段简短的过渡词。10-25 秒能念完, 不重新选歌。
 */
export async function assembleIntro({ nextSong, lastPlayed, queue }) {
  const langCfg = DJ_LANG_CFG[state.get().djLanguage] || DJ_LANG_CFG.en;
  const persona = await readOr(
    path.resolve(`../prompts/${langCfg.personaFile}`),
    langCfg.fallbackPersona
  );
  const upcoming = (queue || []).slice(0, 3)
    .map(s => `  · ${s.song} - ${s.artist}`).join('\n');

  return `${persona}

---
# 现在的情况
刚刚播完: ${lastPlayed ? `${lastPlayed.song} - ${lastPlayed.artist}` : '(开场)'}
即将播放: ${nextSong.song} - ${nextSong.artist}
之后队列:
${upcoming || '(没了)'}

---
# 你这次的任务 — 间奏报幕 (不是新一批选歌)
作为 DJ, 在这两首歌之间说一段非常短的过渡词。
约束:
- ${langCfg.introLengthHint}
- 一两句话就够,不要列歌单不要长抒情
- 提到下一首是什么 (歌名 + 歌手), 给个 5-10 字的钩子让人继续听
- 别重复刚才的歌, 也别预告 3 首之后的事
- 风格跟 dj-persona 保持一致

# 输出 — 严格 JSON
{
  "say": "${langCfg.introSayHint}"
}`;
}
