// spotify.js — Spotify 听歌数据同步
// 详细设计见 docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md

import fs from 'node:fs/promises';
import path from 'node:path';

// 常量: scripts/spotify-auth.js 里也手动定义了同样的值
// (那边是独立 CLI, cwd 不一定是 server/, 没法直接 import)
// 改动这里时记得同步那边
export const REDIRECT_URI = 'http://127.0.0.1:3001/callback';
export const CALLBACK_PORT = 3001;
export const SCOPES = 'user-top-read user-library-read';

// path.resolve('../...') 跟 server/state.js + context.js 一致:
// 假设运行时 cwd 是 server/ (start.sh 进 server/ 再 exec node server.js).
// 如果将来从别处启动 server, 这一套 path 都要改, 不只是 spotify.js
export const TOKEN_FILE = path.resolve('../state/spotify-token.json');
export const LISTENING_FILE = path.resolve('../user/spotify-listening.json');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ————— Token 管理 —————

async function loadToken() {
  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveToken(tokenObj) {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenObj, null, 2));
}

// 用 refresh_token 换新 access_token
// Spotify 偶尔会 rotate refresh_token, 偶尔不会; 都要兼容
async function refreshAccessToken(refreshToken) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('SPOTIFY_CLIENT_ID/SECRET 没设, 没法 refresh');
  }
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!r.ok) {
    const txt = await r.text();
    if (r.status === 400 && txt.includes('invalid_grant')) {
      // refresh_token 被 revoke, 备份 + 删 token 文件, 让上层日志提示
      try {
        await fs.rename(TOKEN_FILE, `${TOKEN_FILE}.broken`);
      } catch {}
      throw new Error('refresh_token invalid_grant, 请重跑 scripts/spotify-auth.js');
    }
    throw new Error(`refresh HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }

  const j = await r.json();
  // Spotify 不一定回 refresh_token; 缺省时保留旧值
  const newToken = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || refreshToken,
    expires_at: Date.now() + (j.expires_in * 1000),
    scope: j.scope,
  };
  await saveToken(newToken);
  return newToken;
}

// 拿一个保证还没过期的 access_token (内部用)
// 过期 < 60s 就提前刷, 防 race
async function getValidAccessToken() {
  const tok = await loadToken();
  if (!tok) return null;
  if (tok.expires_at > Date.now() + 60_000) {
    return tok.access_token;
  }
  const refreshed = await refreshAccessToken(tok.refresh_token);
  return refreshed.access_token;
}

// ————— API 拉取 —————

async function spotifyGet(accessToken, urlPath) {
  const r = await fetch(`https://api.spotify.com${urlPath}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Spotify API ${r.status} @ ${urlPath}: ${txt.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchTopArtists(accessToken, timeRange) {
  const data = await spotifyGet(
    accessToken,
    `/v1/me/top/artists?time_range=${timeRange}&limit=30`
  );
  return (data.items || []).map(a => ({
    name: a.name,
    id: a.id,
    genres: a.genres || [],
  }));
}

async function fetchLikedSongs(accessToken, maxTotal = 200) {
  const out = [];
  const limit = 50;
  for (let offset = 0; offset < maxTotal; offset += limit) {
    const data = await spotifyGet(
      accessToken,
      `/v1/me/tracks?limit=${limit}&offset=${offset}`
    );
    const items = data.items || [];
    for (const it of items) {
      const t = it.track;
      if (!t) continue;
      out.push({
        name: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        addedAt: it.added_at,
      });
    }
    if (items.length < limit) break;   // 没更多了
    if (out.length >= maxTotal) break;
  }
  return out.slice(0, maxTotal);
}

// ————— 主入口 —————

// refresh(): 无条件重拉所有数据, 写 LISTENING_FILE。失败抛错, 不写文件。
// 调用者若关心 invalid_grant 等具体错误, 自己 catch。
export async function refresh() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('no token, 请先跑 scripts/spotify-auth.js');
  }

  // 并行拉所有数据 (3 个 top + 4 页 tracks)
  const [shortArtists, mediumArtists, longArtists, liked] = await Promise.all([
    fetchTopArtists(accessToken, 'short_term'),
    fetchTopArtists(accessToken, 'medium_term'),
    fetchTopArtists(accessToken, 'long_term'),
    fetchLikedSongs(accessToken, 200),
  ]);

  const data = {
    syncedAt: new Date().toISOString(),
    artists: {
      short_term: shortArtists,
      medium_term: mediumArtists,
      long_term: longArtists,
    },
    liked,
  };

  await fs.mkdir(path.dirname(LISTENING_FILE), { recursive: true });
  await fs.writeFile(LISTENING_FILE, JSON.stringify(data, null, 2));
  return data;
}

// refreshIfStale(maxAgeMs): 看 LISTENING_FILE mtime; 超时或缺文件才调 refresh()
// 返回: 'refreshed' | 'cached' | 'no-auth' | 'failed'
// 不抛, 失败用 console.warn 上报后返回 'failed'
export async function refreshIfStale(maxAgeMs = 24 * 60 * 60 * 1000) {
  const tok = await loadToken();
  if (!tok) return 'no-auth';

  // 文件存在且足够新 → 跳过
  try {
    const stat = await fs.stat(LISTENING_FILE);
    if (Date.now() - stat.mtimeMs < maxAgeMs) {
      return 'cached';
    }
  } catch {
    // 文件不存在, 落到 refresh
  }

  try {
    await refresh();
    return 'refreshed';
  } catch (e) {
    console.warn('[spotify] refresh 失败 (不影响主服务):', e.message);
    return 'failed';
  }
}
