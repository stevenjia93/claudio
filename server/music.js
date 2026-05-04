// music.js — 多音源调度器 + fallback 链
//
// 配置:
//   MUSIC_SOURCES=netease,qq,ytmusic    # 优先级,左到右,逗号分隔
//                                        # 默认 netease (向后兼容)
//
// 一次 findPlayable 会按优先级问每个源, 谁先给出 playable 就用谁。
// search() / lyric() / songUrl() 默认用主源(第一个),也可以传第二参指定。

import * as netease from './sources/netease.js';
import * as qq from './sources/qq.js';
import * as ytmusic from './sources/ytmusic.js';
import * as douyin from './sources/douyin.js';

export const sources = { netease, qq, ytmusic, douyin };

// 解析优先级
function parseOrder() {
  const raw = (process.env.MUSIC_SOURCES || 'netease').split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s && sources[s]);
  return raw.length ? raw : ['netease'];
}
const ORDER = parseOrder();
const PRIMARY = ORDER[0];

console.log(`[music] 启用音源 (优先级): ${ORDER.join(' → ')}`);

// —— 默认指主源 ——

export async function search(query, limit = 5, sourceKey = PRIMARY) {
  return sources[sourceKey].search(query, limit);
}

export async function songUrl(id, sourceKey = PRIMARY) {
  return sources[sourceKey].songUrl(id);
}

export async function lyric(id, sourceKey = PRIMARY) {
  if (!sources[sourceKey]) return '';
  return sources[sourceKey].lyric(id);
}

export async function songDetail(id, sourceKey = PRIMARY) {
  return sources[sourceKey].songDetail(id);
}

/**
 * 一句 query → 第一个能播的命中。
 * 主源拿不到 → 按 ORDER 依次回落。
 * 占位源会扔 "还没接入",自动跳过。
 */
export async function findPlayable(query) {
  for (const name of ORDER) {
    try {
      const hit = await sources[name].findPlayable(query);
      if (hit) {
        if (name !== PRIMARY) {
          console.log(`[music] "${query}" 主源 ${PRIMARY} 没拿到, fallback 到 ${name}`);
        }
        return hit;
      }
    } catch (e) {
      // 占位源 / 未配置的源会抛, 静默跳过
      const msg = e?.message || String(e);
      if (!/还没接入|需要 npm install|ENOTFOUND|ECONNREFUSED/.test(msg)) {
        console.warn(`[music · ${name}] ${query}:`, msg);
      }
    }
  }
  return null;
}

export function listSources() {
  return Object.entries(sources).map(([key, m]) => ({
    key, name: m.name, primary: key === PRIMARY, enabled: ORDER.includes(key)
  }));
}
