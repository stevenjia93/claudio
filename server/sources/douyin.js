// douyin.js — 汽水音乐 / 抖音音乐 (占位 · 还没实现)
//
// 难点: 没有官方公开 API。可选的脏路子:
//   ① 抓 https://www.qishui.com 网页 → 解析 __NEXT_DATA__ JSON
//   ② mobile 抖音 H5 接口, 需要 mssdk 签名 (变得快)
//   ③ Resso (海外版) 还有公开 API, 但国内没用
//
// 长期只能跟着 Bytedance 接口走, 比另两家不稳。
// 接入前先看 https://github.com/iv-org/yt-dlp 有没有 douyin extractor 可以借鉴。

export const id = 'douyin';
export const name = '汽水音乐';

export async function search(query, limit = 5) {
  throw new Error('[douyin] 还没接入。看 server/sources/douyin.js 顶部的注释');
}

export async function songUrl(id) {
  throw new Error('[douyin] 还没接入');
}

export async function lyric(id) {
  return '';
}

export async function songDetail(id) {
  return null;
}

export async function findPlayable(query) {
  return null;
}
