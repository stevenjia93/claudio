// spotify.js — Spotify 听歌数据同步
// 详细设计见 docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md

import path from 'node:path';

// 常量: scripts/spotify-auth.js 和本模块共用语义
export const REDIRECT_URI = 'http://127.0.0.1:3001/callback';
export const CALLBACK_PORT = 3001;
export const SCOPES = 'user-top-read user-library-read';

export const TOKEN_FILE = path.resolve('../state/spotify-token.json');
export const LISTENING_FILE = path.resolve('../user/spotify-listening.json');

// 接口下面任务再填
export async function refreshIfStale() {
  throw new Error('not implemented yet (Task 4)');
}

export async function refresh() {
  throw new Error('not implemented yet (Task 4)');
}
