#!/usr/bin/env node
// spotify-auth.js — 一次性 Spotify OAuth 授权
// 设计见 docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md
//
// 用法: node scripts/spotify-auth.js

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 直接定义常量 (脚本独立跑, cwd 不一定是 server/, 不复用 spotify.js 的常量)
const REDIRECT_URI = 'http://127.0.0.1:3001/callback';
const CALLBACK_PORT = 3001;
const SCOPES = 'user-top-read user-library-read';

// 解析项目根 (scripts/ 的父目录)
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(path.dirname(__filename));
const TOKEN_FILE = path.join(PROJECT_ROOT, 'state', 'spotify-token.json');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('✗ 没拿到 SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET');
  console.error('  请先:');
  console.error('  1. 上 https://developer.spotify.com/dashboard 创建 App');
  console.error('  2. Redirect URI 填: http://127.0.0.1:3001/callback');
  console.error('  3. 拿到 Client ID + Secret, 填到 .env');
  console.error('  4. set -a; source .env; set +a');
  console.error('  5. 重跑这个脚本');
  process.exit(1);
}

const stateToken = crypto.randomBytes(16).toString('base64url');

const authUrl = `https://accounts.spotify.com/authorize?` + new URLSearchParams({
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state: stateToken,
}).toString();

// 起 callback HTTP 服务
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.writeHead(404).end('not found');
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  const stateReturned = url.searchParams.get('state');

  if (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`授权失败: ${err}\n你可以关掉这个标签页, 然后重跑 spotify-auth.js`);
    console.error(`✗ Spotify 回的 error: ${err}`);
    server.close();
    process.exit(1);
  }

  if (stateReturned !== stateToken) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('state 不匹配, 可能 CSRF 攻击。重跑脚本。');
    console.error('✗ state mismatch');
    server.close();
    process.exit(1);
  }

  // 换 token
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`HTTP ${tokenRes.status}: ${txt.slice(0, 200)}`);
    }
    const j = await tokenRes.json();

    const tokenObj = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in * 1000),
      scope: j.scope,
    };

    await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
    await fs.writeFile(TOKEN_FILE, JSON.stringify(tokenObj, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('✓ Spotify 已授权, 可以关掉这个标签页, 回终端看看。');

    console.log('');
    console.log('✓ 授权成功');
    console.log(`  access_token (1h): ${j.access_token.slice(0, 12)}...`);
    console.log(`  refresh_token: ${j.refresh_token.slice(0, 12)}...`);
    console.log(`  scope: ${j.scope}`);
    console.log(`  写入: ${TOKEN_FILE}`);

    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`换 token 失败: ${e.message}`);
    console.error(`✗ 换 token 失败: ${e.message}`);
    server.close();
    process.exit(1);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${CALLBACK_PORT} 被占用。先释放再重跑。`);
    console.error(`  查谁: lsof -nP -iTCP:${CALLBACK_PORT} -sTCP:LISTEN`);
    process.exit(1);
  }
  throw e;
});

server.listen(CALLBACK_PORT, '127.0.0.1', () => {
  console.log(`▸ Callback 服务起在 http://127.0.0.1:${CALLBACK_PORT}/callback`);
  console.log(`▸ 打开浏览器, 跳到 Spotify 授权页...`);
  console.log('');
  console.log(`  如果浏览器没自动开, 手动开这个链接:`);
  console.log(`  ${authUrl}`);
  console.log('');

  // mac open 命令; Linux/Windows 用户得自己手动开 (上面已经 print 链接)
  spawn('open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
});
