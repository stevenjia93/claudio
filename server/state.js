// state.js — 状态 · 记忆
// v1 用 JSON 够用，v2 想分析听歌习惯再换 SQLite
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = path.resolve('../state/state.json');

const DEFAULT_STATE = {
  messages: [],   // {role, content, ts}
  plays: [],      // {song, artist, url, ts, source: 'claude'|'direct'}
  queue: [],      // 待播放，[{song, artist, url}]
  nowPlaying: null,
  plan: null,     // 早报/晚报内容，v2 用
  prefs: {}       // 用户临时偏好，v2 用
};

let state = null;
let saveTimer = null;

export async function load() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    state = structuredClone(DEFAULT_STATE);
    await save();
  }
  return state;
}

// 防抖保存,避免疯狂写盘
export function save() {
  clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = setTimeout(async () => {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      resolve();
    }, 200);
  });
}

export function get() {
  if (!state) throw new Error('state 还没 load()');
  return state;
}

export function appendMessage(role, content) {
  state.messages.push({ role, content, ts: Date.now() });
  // 只留最近 200 条防膨胀
  if (state.messages.length > 200) state.messages = state.messages.slice(-200);
  save();
}

export function appendPlay(entry) {
  state.plays.push({ ...entry, ts: Date.now() });
  if (state.plays.length > 500) state.plays = state.plays.slice(-500);
  save();
}

export function setQueue(queue) {
  state.queue = queue;
  save();
}

export function pushQueue(items) {
  state.queue.push(...items);
  save();
}

export function popQueue() {
  const next = state.queue.shift();
  save();
  return next;
}

export function setNowPlaying(np) {
  state.nowPlaying = np;
  save();
}
