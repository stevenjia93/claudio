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

/**
 * 组装完整的 prompt,交给 claude.js 去 spawn
 * @param {string} userInput 本次用户说的话
 * @param {object} opts 额外上下文
 */
export async function assemble(userInput, opts = {}) {
  // ① 系统提示词
  const persona = await readOr(
    path.resolve('../prompts/dj-persona.md'),
    '你是 Claudio,一个私人 AI 电台 DJ。'
  );

  // ② 用户语料
  const taste = await readOr(path.resolve('../user/taste.md'));
  const routines = await readOr(path.resolve('../user/routines.md'));
  const playlistsRaw = await readOr(path.resolve('../user/playlists.json'), '{}');

  // ③ 环境注入
  const now = new Date();
  const env = {
    now: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    dayOfWeek: ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()],
    hour: now.getHours(),
    // v2: weather, calendar 接进来
    ...opts.env
  };

  // ④ 已检索记忆: 最近 10 次播放 + 最近 6 条对话
  const s = state.get();
  const recentPlays = s.plays.slice(-10).map(p => `  · ${p.song} - ${p.artist}`).join('\n');
  const recentMessages = s.messages.slice(-6)
    .map(m => `  ${m.role === 'user' ? '我' : 'Claudio'}: ${m.content.slice(0, 120)}`)
    .join('\n');

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

---
# 现在
${env.now} (${env.dayOfWeek},${env.hour} 点)

# 最近播放过
${recentPlays || '(还没播过)'}

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

play 数组里每首写成 "歌名 - 歌手" 的格式,3 到 5 首。
如果我只是闲聊没让你放歌,play 可以是空数组 []。`;

  return prompt;
}
