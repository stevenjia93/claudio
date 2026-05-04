// netease.js — 网易云音乐适配器
// 跑在本地的 NeteaseCloudMusicApi (默认 :3000)

const NCM_BASE = process.env.NCM_BASE || 'http://localhost:3000';

export const id = 'netease';
export const name = '网易云音乐';

export async function search(query, limit = 5) {
  const url = `${NCM_BASE}/search?keywords=${encodeURIComponent(query)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ncm search 挂了: ${r.status}`);
  const data = await r.json();
  const songs = data?.result?.songs || [];
  return songs.map(s => ({
    source: 'netease',
    id: s.id,
    name: s.name,
    artist: s.artists?.map(a => a.name).join(' / ') || '',
    album: s.album?.name || '',
    picUrl: s.album?.picUrl || s.album?.artist?.img1v1Url || '',
    duration: s.duration
  }));
}

export async function songUrl(id) {
  const url = `${NCM_BASE}/song/url?id=${id}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ncm song/url 挂了: ${r.status}`);
  const data = await r.json();
  return data?.data?.[0]?.url || null;     // null = 要 VIP / 下架
}

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

export async function songDetail(id) {
  const url = `${NCM_BASE}/song/detail?ids=${id}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    const s = data?.songs?.[0];
    if (!s) return null;
    return {
      picUrl: s.al?.picUrl || '',
      album: s.al?.name || ''
    };
  } catch {
    return null;
  }
}

function extractArtistHint(query) {
  const dashed = query.split(/\s*[-–—]\s*/);
  if (dashed.length >= 2) return dashed[dashed.length - 1].trim().toLowerCase();
  const tokens = query.trim().split(/\s+/);
  if (tokens.length >= 2) return tokens.slice(1).join(' ').toLowerCase();
  return '';
}

// 一句 query 拿到可播的第一条 — artist 匹配的优先
export async function findPlayable(query) {
  const candidates = await search(query, 5);
  const hint = extractArtistHint(query);
  const ranked = hint
    ? [
        ...candidates.filter(c => (c.artist || '').toLowerCase().includes(hint)),
        ...candidates.filter(c => !(c.artist || '').toLowerCase().includes(hint))
      ]
    : candidates;
  for (const c of ranked) {
    const url = await songUrl(c.id);
    if (url) {
      if (!c.picUrl) {
        const d = await songDetail(c.id);
        if (d?.picUrl) c.picUrl = d.picUrl;
      }
      return { ...c, url };
    }
  }
  return null;
}
