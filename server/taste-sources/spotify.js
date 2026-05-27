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

// refresh(): 无条件重拉所有数据, 写 LISTENING_FILE
// refreshIfStale(maxAgeMs): 看 LISTENING_FILE mtime; 超时或缺文件才调 refresh()
// 两个都在 Task 4 实现
export async function refreshIfStale() {
  throw new Error('not implemented yet (Task 4)');
}

export async function refresh() {
  throw new Error('not implemented yet (Task 4)');
}
