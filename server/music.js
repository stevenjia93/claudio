// music.js — 网易云音乐客户端
// 指向本地跑的 NeteaseCloudMusicApi（默认 :3000）

const NCM_BASE = process.env.NCM_BASE || 'http://localhost:3000';

/**
 * 搜歌,返回前 N 个候选
 * @param {string} query  e.g. "稻香 周杰伦" 或 "晴天"
 * @param {number} limit
 */
export async function search(query, limit = 5) {
  const url = `${NCM_BASE}/search?keywords=${encodeURIComponent(query)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ncm search 挂了: ${r.status}`);
  const data = await r.json();
  const songs = data?.result?.songs || [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artist: s.artists?.map(a => a.name).join(' / ') || '',
    album: s.album?.name || '',
    duration: s.duration
  }));
}

/**
 * 拿直链
 * 注意: VIP 歌需要登录 cookie,MVP 先拿能免费的
 */
export async function songUrl(id) {
  const url = `${NCM_BASE}/song/url?id=${id}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ncm song/url 挂了: ${r.status}`);
  const data = await r.json();
  const item = data?.data?.[0];
  return item?.url || null;  // null 说明要 VIP 或下架了
}

/**
 * 拿歌词
 */
export async function lyric(id) {
  const url = `${NCM_BASE}/lyric?id=${id}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    return data?.lrc?.lyric || '';
  } catch {
    return '';
  }
}

/**
 * 组合动作: 一句 query 拿到可播的第一条
 */
export async function findPlayable(query) {
  const candidates = await search(query, 5);
  for (const c of candidates) {
    const url = await songUrl(c.id);
    if (url) return { ...c, url };
  }
  return null;  // 都拿不到直链
}
