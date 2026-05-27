// spotify.js — Spotify 听歌数据同步
// 详细设计见 docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md

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

// refresh(): 无条件重拉所有数据, 写 LISTENING_FILE
// refreshIfStale(maxAgeMs): 看 LISTENING_FILE mtime; 超时或缺文件才调 refresh()
// 两个都在 Task 4 实现
export async function refreshIfStale() {
  throw new Error('not implemented yet (Task 4)');
}

export async function refresh() {
  throw new Error('not implemented yet (Task 4)');
}
