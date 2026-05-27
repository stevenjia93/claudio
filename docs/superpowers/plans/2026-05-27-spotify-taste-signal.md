# Spotify 听歌信号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Spotify Top Artists (3 期限) + Liked Songs (200 首) 同步到本地 JSON, 在 Claude prompt 里加一节"我的 Spotify 听歌信号"作为自动口味画像。

**Architecture:** 一次性 CLI 脚本 (`scripts/spotify-auth.js`) 走 Spotify OAuth Code Flow 拿 refresh token, 写到 `state/spotify-token.json`。新模块 `server/taste-sources/spotify.js` 自动刷 token 并拉 API 数据, 写 `user/spotify-listening.json`。`server.js` 启动时异步 (不阻塞) 调 `refreshIfStale()` (24h TTL)。`context.js` 的 `assemble()` 多读一个 JSON, 拼成 prompt 一节。

**Tech Stack:** Node.js 内置 `http` (callback server), `fetch` (Spotify API), `fs/promises` (token & data 文件), `crypto.randomBytes` (OAuth state), `child_process` (mac `open` 命令开浏览器).

**项目无自动化测试套件** (沿用项目"手测"惯例). 每个任务以"启服务/脚本手测 + commit"替代"跑测试"。

**Spec:** `docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md`

---

## 文件清单

| 文件 | 类型 | 责任 |
|---|---|---|
| `scripts/spotify-auth.js` | 新 | 一次性 OAuth CLI: 起 callback HTTP → 开浏览器 → 换 token → 写文件 |
| `server/taste-sources/spotify.js` | 新 | API 客户端: load/save token, refreshAccessToken, fetchTopArtists, fetchLikedSongs, refresh, refreshIfStale |
| `server/server.js` | 改 (~5 行) | 启动时异步调 `spotifyTaste.refreshIfStale()` |
| `server/context.js` | 改 (~30 行) | 加 `formatSpotifyBlock` 函数 + `assemble()` 多读 spotify-listening.json |
| `.env.example` | 改 (~5 行) | 加 SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET 字段 |
| `README.md` | 改 (~30 行) | 加"接入 Spotify 听歌数据"一节 |
| `state/spotify-token.json` | 运行时 | 由 spotify-auth.js 生成; gitignored 因为 state/ 整体被 ignore |
| `user/spotify-listening.json` | 运行时 | 由 refresh() 生成; **要不要 gitignore 用户自己决定**; spec 没说必须 ignore, 不在本 plan 范围 |

## 启动手测环境

每个任务结束前的手测流程:

```bash
# 1. 进项目根
cd /Users/zejia/Claudes/claudio

# 2. 加载 .env 到 shell (后续命令需要环境变量)
set -a; source .env; set +a

# 3. 按任务"手测"小节指引操作
```

启服务用现有 `./start.sh` (会同时拉 NCM API + claudio @ :8080)。手测不必每次都启全套, 视任务而定。

---

## Task 1: scaffolding — .env.example + 目录结构

**Files:**
- Modify: `.env.example`
- Create (空目录占位): `scripts/.gitkeep`, `server/taste-sources/.gitkeep`

**目的:** 把 SPOTIFY_CLIENT_ID/SECRET 字段加进 `.env.example`, 让用户知道要填什么; 创建后续任务用到的目录。

- [ ] **Step 1: 改 .env.example 加 Spotify 字段**

在 `.env.example` 末尾 (现有"音源"块之后) 追加:

```
# —————— 口味信号 (Spotify) ——————
# 把你 Spotify 的 Top Artists + Liked Songs 同步成本地 JSON
# 喂给 Claude 当口味画像。不用 Spotify 就留空。
#
# 怎么配:
#   1. https://developer.spotify.com/dashboard 创建 App
#   2. Redirect URI 必须填: http://127.0.0.1:3001/callback
#      (Spotify 现在不接受 localhost, 必须 127.0.0.1)
#   3. 拿 Client ID + Client Secret 填到下面
#   4. 跑一次: node scripts/spotify-auth.js
# SPOTIFY_CLIENT_ID=
# SPOTIFY_CLIENT_SECRET=
```

- [ ] **Step 2: 建空目录 (用 .gitkeep)**

```bash
cd /Users/zejia/Claudes/claudio
mkdir -p scripts server/taste-sources
touch scripts/.gitkeep server/taste-sources/.gitkeep
```

- [ ] **Step 3: 手测**

```bash
cd /Users/zejia/Claudes/claudio
grep -c SPOTIFY_CLIENT_ID .env.example
# 期望: 1
ls scripts server/taste-sources
# 期望: 各有一个 .gitkeep
```

- [ ] **Step 4: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add .env.example scripts/.gitkeep server/taste-sources/.gitkeep
git commit -m "spotify: scaffold .env + 目录 (scripts/ + server/taste-sources/)"
```

---

## Task 2: scripts/spotify-auth.js — 一次性 OAuth CLI

**Files:**
- Create: `scripts/spotify-auth.js`
- Modify: `server/taste-sources/spotify.js` (constants only, 提前抽出来共用)

**目的:** 用户跑一次 `node scripts/spotify-auth.js`, 起 callback server, 开浏览器到 Spotify 授权页, 换 token, 写到 `state/spotify-token.json`。

- [ ] **Step 1: 先建 server/taste-sources/spotify.js 占位 (后续 Task 3-4 填实现)**

新建 `server/taste-sources/spotify.js`, 写入:

```js
// spotify.js — Spotify 听歌数据同步
// 详细设计见 docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md

import path from 'node:path';

// 常量: scripts/spotify-auth.js 和本模块共用
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
```

注: `path.resolve('../state/...')` 假设运行时 cwd 是 `server/`, 跟现有 `state.js` / `context.js` 一致。后续 spotify-auth.js 单独跑时需要自行处理 cwd (Task 2 Step 2 会处理)。

- [ ] **Step 2: 写 scripts/spotify-auth.js**

新建 `scripts/spotify-auth.js`, 完整内容:

```js
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
```

- [ ] **Step 3: 手测 — 没 client id 的报错路径**

```bash
cd /Users/zejia/Claudes/claudio
# 临时把环境变量清掉
env -u SPOTIFY_CLIENT_ID -u SPOTIFY_CLIENT_SECRET node scripts/spotify-auth.js; echo "exit=$?"
```

期望输出含 `✗ 没拿到 SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET` 和 `exit=1`。

- [ ] **Step 4: 手测 — 完整跑通 (需要用户互动)**

**⚠ 这一步需要人在浏览器交互, 实现者 subagent 跑到这里就必须把任务交回给人**。如果是 subagent, 它只需要:

1. 确认 .env 里 `SPOTIFY_CLIENT_ID` 和 `SPOTIFY_CLIENT_SECRET` 都不为空 (`grep -c "^SPOTIFY_CLIENT_ID=." /Users/zejia/Claudes/claudio/.env` 期望 1)
2. **不要真跑 `node scripts/spotify-auth.js`** (会卡在等浏览器回调)
3. 在报告里写 "已让 user 在 Step 4 手动跑 spotify-auth.js"

完整人工流程 (user 跑):

```bash
cd /Users/zejia/Claudes/claudio
set -a; source .env; set +a
node scripts/spotify-auth.js
```

期望:
- 终端打印 `▸ Callback 服务起在 http://127.0.0.1:3001/callback`
- 自动开浏览器到 Spotify 授权页 (含 "user-top-read", "user-library-read" 权限)
- 用户点同意
- 浏览器跳回 `127.0.0.1:3001/callback?code=...&state=...`, 显示 `✓ Spotify 已授权`
- 终端打印 `✓ 授权成功` + token 文件路径
- 进程退出 (exit 0)
- 文件 `state/spotify-token.json` 存在, 含 `access_token` `refresh_token` `expires_at` `scope` 四字段

人工验证完成后, 进 Step 5。

- [ ] **Step 5: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add scripts/spotify-auth.js server/taste-sources/spotify.js
git commit -m "spotify: 一次性 OAuth CLI + spotify.js 常量骨架"
```

---

## Task 3: server/taste-sources/spotify.js — token 管理 (loadToken / saveToken / refreshAccessToken)

**Files:**
- Modify: `server/taste-sources/spotify.js`

**目的:** 写读 token 文件的工具 + access_token 自动刷新逻辑。

- [ ] **Step 1: 实现 loadToken / saveToken / refreshAccessToken**

打开 `server/taste-sources/spotify.js`, 替换为下面完整内容 (保留 Task 2 Step 1 的常量, 加新代码):

```js
// spotify.js — Spotify 听歌数据同步
// 详细设计见 docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md

import fs from 'node:fs/promises';
import path from 'node:path';

// 常量
export const REDIRECT_URI = 'http://127.0.0.1:3001/callback';
export const CALLBACK_PORT = 3001;
export const SCOPES = 'user-top-read user-library-read';

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

// 占位, Task 4 实现
export async function refreshIfStale() {
  throw new Error('not implemented yet (Task 4)');
}

export async function refresh() {
  throw new Error('not implemented yet (Task 4)');
}
```

注意: 这一步把 `getValidAccessToken` 内部函数也写好了, Task 4 直接用。

- [ ] **Step 2: 手测 — 导出 + token 文件读取**

```bash
cd /Users/zejia/Claudes/claudio/server
set -a; source ../.env; set +a
node -e "
import('./taste-sources/spotify.js').then(async m => {
  // exports
  console.log('exports:', Object.keys(m).filter(k => !k.startsWith('__')));
  // Token file path
  console.log('token file path:', m.TOKEN_FILE);
});
"
```

期望输出含: `exports: [ 'REDIRECT_URI', 'CALLBACK_PORT', 'SCOPES', 'TOKEN_FILE', 'LISTENING_FILE', 'refreshIfStale', 'refresh' ]` 和 token 文件绝对路径以 `/state/spotify-token.json` 结尾。

- [ ] **Step 3: 手测 — refreshAccessToken 路径 (需 user 已跑过 Task 2 Step 4)**

仅当 `state/spotify-token.json` 已存在时跑。手动测 access_token 自动刷新:

```bash
cd /Users/zejia/Claudes/claudio/server
set -a; source ../.env; set +a
node -e "
import('./taste-sources/spotify.js').then(async m => {
  const fs = await import('node:fs/promises');
  // 看现有 token expires_at
  const tok = JSON.parse(await fs.readFile(m.TOKEN_FILE, 'utf8'));
  console.log('current expires_at:', new Date(tok.expires_at).toISOString());
  console.log('now:', new Date().toISOString());
  // 强制 expire (临时把 expires_at 设为过去)
  tok.expires_at = 1;
  await fs.writeFile(m.TOKEN_FILE, JSON.stringify(tok, null, 2));
  console.log('manually expired, calling internal getValidAccessToken via load+refresh...');
  // 现在重新 load — 调底层 (getValidAccessToken 不导出, 间接验证: 用 require + module internals 不雅, 改用直接断言 refresh_token 仍能换出新 access_token)
  const Buffer = (await import('node:buffer')).Buffer;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }).toString(),
  });
  console.log('refresh HTTP:', r.status);
  const j = await r.json();
  console.log('got new access_token:', (j.access_token || 'NONE').slice(0, 12) + '...');
  console.log('rotated refresh_token?', !!j.refresh_token);
});
"
```

期望:
- `refresh HTTP: 200`
- `got new access_token: <12 字符>...`
- Spotify 也许会 rotate refresh_token, 也许不会, 都正常

如果 user 没跑过 Task 2 Step 4 (token 文件不存在), 跳过这一步, 标 "skip-need-user-auth"。

- [ ] **Step 4: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add server/taste-sources/spotify.js
git commit -m "spotify: token 管理 (load/save/refreshAccessToken)"
```

---

## Task 4: server/taste-sources/spotify.js — 数据拉取 (refresh + refreshIfStale)

**Files:**
- Modify: `server/taste-sources/spotify.js`

**目的:** 实现 Spotify API 数据拉取 + 24h TTL 缓存逻辑。

- [ ] **Step 1: 在 spotify.js 中替换 refresh / refreshIfStale 两个 stub, 同时加 fetch 辅助函数**

打开 `server/taste-sources/spotify.js`, 把末尾两个 `throw new Error('not implemented yet (Task 4)')` 占位实现替换为下面完整逻辑:

```js
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

export async function refresh() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('no token, 请先跑 scripts/spotify-auth.js');
  }

  // 并行拉所有数据 (4 个 top + 一系列 paginated tracks)
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

export async function refreshIfStale(maxAgeMs = 24 * 60 * 60 * 1000) {
  // 没 token: 不报错, 返回标记
  const tok = await loadToken();
  if (!tok) return 'no-auth';

  // 文件存在且足够新 -> 跳过
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
```

注: 整个 spotify.js 现在应该是 Task 2 Step 1 + Task 3 Step 1 + Task 4 Step 1 三段的合并。如果实现起来需要确认完整内容, 看下面 "完整文件参考" (脚注式)。

- [ ] **Step 2: 手测 — refresh 实际跑通**

需要 user 已经跑过 Task 2 Step 4。如果没, 跳过, 标 "skip-need-user-auth"。

```bash
cd /Users/zejia/Claudes/claudio/server
set -a; source ../.env; set +a

# 清掉旧 listening 文件 (如果有) 强制 refresh
rm -f /Users/zejia/Claudes/claudio/user/spotify-listening.json

node -e "
import('./taste-sources/spotify.js').then(async m => {
  console.log('calling refreshIfStale...');
  const r = await m.refreshIfStale();
  console.log('result:', r);
  if (r === 'refreshed') {
    const fs = await import('node:fs/promises');
    const data = JSON.parse(await fs.readFile(m.LISTENING_FILE, 'utf8'));
    console.log('syncedAt:', data.syncedAt);
    console.log('short_term count:', data.artists.short_term.length);
    console.log('medium_term count:', data.artists.medium_term.length);
    console.log('long_term count:', data.artists.long_term.length);
    console.log('liked count:', data.liked.length);
    console.log('first short_term artist:', data.artists.short_term[0]?.name);
    console.log('first liked:', data.liked[0]?.name, '-', data.liked[0]?.artist);
  }
});
"
```

期望:
- `result: refreshed`
- `short_term count: 30` (或更少, 如果你 Spotify 听歌少)
- `medium_term count: 30`
- `long_term count: 30`
- `liked count: 200` (或更少)
- 第一个 artist 名 + 第一首 liked song 都有具体值

- [ ] **Step 3: 手测 — 立即重跑 (期望 cached)**

紧跟上一步, 不删 listening 文件, 再跑一次:

```bash
node -e "
import('./taste-sources/spotify.js').then(async m => {
  const r = await m.refreshIfStale();
  console.log('result:', r);
});
"
```

期望: `result: cached` (文件 mtime < 24h)。

- [ ] **Step 4: 手测 — 假装过期 (期望 refreshed)**

```bash
touch -d "2 days ago" /Users/zejia/Claudes/claudio/user/spotify-listening.json
node -e "
import('./taste-sources/spotify.js').then(async m => {
  const r = await m.refreshIfStale();
  console.log('result:', r);
});
"
```

期望: `result: refreshed`。

- [ ] **Step 5: 手测 — 没 token 路径**

```bash
# 临时备份 token
mv /Users/zejia/Claudes/claudio/state/spotify-token.json{,.bak}
node -e "
import('./taste-sources/spotify.js').then(async m => {
  const r = await m.refreshIfStale();
  console.log('result:', r);
});
"
# 恢复
mv /Users/zejia/Claudes/claudio/state/spotify-token.json{.bak,}
```

期望: `result: no-auth` (不报错)。

- [ ] **Step 6: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add server/taste-sources/spotify.js
git commit -m "spotify: refresh() + refreshIfStale() — 拉 Top Artists + Liked Songs"
```

---

## Task 5: server.js — 启动时异步触发 refreshIfStale

**Files:**
- Modify: `server/server.js`

**目的:** 服务启动时, 不阻塞主流程, 异步刷一次 Spotify 数据。

- [ ] **Step 1: 加 import + 启动钩子**

打开 `server/server.js`, 找到 `// ——— 启动 ———` 那一段 (现在是 `await state.load();` 紧跟 import os 那块)。

在 `import { route } from './router.js';` 这一行**之后**新加一行 import:

```js
import * as spotifyTaste from './taste-sources/spotify.js';
```

然后在 `await state.load();` 这一行**之后**, `import os from 'node:os';` 之前, 插入:

```js
// 后台异步刷 Spotify 听歌信号 (24h TTL, 不阻塞启动)
spotifyTaste.refreshIfStale().then(result => {
  if (result === 'refreshed') console.log('[spotify] 听歌信号已刷新');
  else if (result === 'cached') console.log('[spotify] 听歌信号缓存 (< 24h)');
  else if (result === 'no-auth') console.log('[spotify] 没授权, 跳过 (要的话跑 scripts/spotify-auth.js)');
  else if (result === 'failed') {} // refresh 内部已 warn 过, 不重复
}).catch(e => {
  console.warn('[spotify] refresh 异步挂了 (不影响启动):', e.message);
});
```

- [ ] **Step 2: 手测 — 启动 server 看日志**

```bash
cd /Users/zejia/Claudes/claudio/server
MOCK_CLAUDE=1 node server.js &
SERVER_PID=$!
sleep 3
# 看日志: 应该出现 spotify 一行
ps aux | grep "node server" | grep -v grep | head -1
# 杀
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
```

实际日志在 stdout, 用 `node server.js 2>&1 | grep spotify` 也行。期望见到 `[spotify] 听歌信号缓存 (< 24h)` (因为 Task 4 刚刷过, < 24h)。

- [ ] **Step 3: 手测 — 没 token 路径**

```bash
mv /Users/zejia/Claudes/claudio/state/spotify-token.json{,.bak}
cd /Users/zejia/Claudes/claudio/server
MOCK_CLAUDE=1 timeout 5 node server.js 2>&1 | grep -i spotify
mv /Users/zejia/Claudes/claudio/state/spotify-token.json{.bak,}
```

期望: 看到 `[spotify] 没授权, 跳过` 这一行。

注: macOS 默认没有 `timeout` 命令, 如果没有就用:
```bash
cd /Users/zejia/Claudes/claudio/server
MOCK_CLAUDE=1 node server.js 2>&1 | head -20 &
PID=$!
sleep 5
kill $PID 2>/dev/null
wait $PID 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add server/server.js
git commit -m "server: 启动时异步刷 Spotify 听歌信号"
```

---

## Task 6: context.js — assemble() 加 formatSpotifyBlock

**Files:**
- Modify: `server/context.js`

**目的:** Claude 调用前, 把 `user/spotify-listening.json` 内容拼成 prompt 一节, 喂给 Claude。

- [ ] **Step 1: 在 context.js 加 formatSpotifyBlock 函数**

打开 `server/context.js`。在文件末尾 (`export async function assembleIntro` 函数之**前**) 加:

```js
// ————————————————————————————————————————
// Spotify 听歌信号格式化
// ————————————————————————————————————————
function formatSpotifyBlock(rawJson) {
  if (!rawJson) return '';
  let data;
  try { data = JSON.parse(rawJson); } catch { return ''; }

  const top = data.artists || {};
  const liked = (data.liked || []).slice(0, 150);
  const lines = (arr) => (arr || []).map(a => a.name).join(' / ');

  // 空数据不出整节
  if (!liked.length && !lines(top.short_term)) return '';

  const synced = data.syncedAt
    ? new Date(data.syncedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '?';

  return `
# 我的 Spotify 听歌信号 (自动同步 · ${synced})

## Top Artists
- 最近 4 周: ${lines(top.short_term)}
- 最近 6 个月: ${lines(top.medium_term)}
- 长期 (多年): ${lines(top.long_term)}

## Liked Songs (最近收藏 ${liked.length} 首)
${liked.map(t => `- ${t.name} - ${t.artist}`).join('\n')}`;
}
```

- [ ] **Step 2: 在 assemble() 内多读 spotify-listening.json 并插入 prompt**

在 `assemble()` 函数内, 找到读 `playlists.json` 那一行:

```js
const playlistsRaw = await readOr(path.resolve('../user/playlists.json'), '{}');
```

紧接其**后**加一行 (跟 playlists 形式一致, 路径用 LISTENING_FILE 一样的语义):

```js
const spotifyRaw = await readOr(path.resolve('../user/spotify-listening.json'), '');
const spotifyBlock = formatSpotifyBlock(spotifyRaw);
```

然后在 prompt 模板里, 找到这一段:

```js
# 我爱的歌单 (JSON)
${playlistsRaw}

---
# 现在
```

替换为:

```js
# 我爱的歌单 (JSON)
${playlistsRaw}
${spotifyBlock}
---
# 现在
```

(注意: `${spotifyBlock}` 自己开头有换行了, 所以 `${playlistsRaw}` 后面跟 `${spotifyBlock}` 中间不加空行也对; spotifyBlock 为空时就什么都不输出)

- [ ] **Step 3: 手测 — assemble 输出含 Spotify 节**

需要 `user/spotify-listening.json` 文件已存在 (Task 4 跑通过)。

```bash
cd /Users/zejia/Claudes/claudio/server
set -a; source ../.env; set +a
node -e "
import('./state.js').then(async s => { await s.load(); });
setTimeout(async () => {
  const ctx = await import('./context.js');
  const prompt = await ctx.assemble('随便测试一下');
  // 看 Spotify 一节
  const idx = prompt.indexOf('Spotify 听歌信号');
  if (idx < 0) { console.log('MISS: prompt 里没找到 Spotify 节'); console.log(prompt.slice(0, 400)); process.exit(1); }
  console.log('OK: 找到 Spotify 节, 节选 800 字符:');
  console.log(prompt.slice(idx, idx + 800));
}, 500);
"
```

期望:
- `OK: 找到 Spotify 节, 节选 800 字符:` 之后是 Top Artists / Liked Songs 真实内容。

- [ ] **Step 4: 手测 — listening 文件不存在时 prompt 不出 Spotify 节**

```bash
mv /Users/zejia/Claudes/claudio/user/spotify-listening.json{,.bak}
cd /Users/zejia/Claudes/claudio/server
node -e "
import('./state.js').then(async s => { await s.load(); });
setTimeout(async () => {
  const ctx = await import('./context.js');
  const prompt = await ctx.assemble('test');
  const idx = prompt.indexOf('Spotify 听歌信号');
  console.log(idx < 0 ? 'OK: 没 Spotify 节 (符合预期)' : 'BUG: 不该有 Spotify 节但出现了');
}, 500);
"
mv /Users/zejia/Claudes/claudio/user/spotify-listening.json{.bak,}
```

期望: `OK: 没 Spotify 节 (符合预期)`。

- [ ] **Step 5: 手测 — 端到端 (跟 Claude 真聊一次, 看输出受 Spotify 影响)**

可选, 主观验证。需要真 ANTHROPIC_API_KEY (不能 MOCK_CLAUDE)。

```bash
cd /Users/zejia/Claudes/claudio
./start.sh
# 浏览器开 http://localhost:8080
# 输入: "推几首歌"
# 看 Claude 推的歌有没有出现你 Spotify Top Artists 里的人或类似风格
# Ctrl+C 退出
```

主观验证, 不严格断言。如果 Claude 推的歌跟你 Spotify 风格完全不沾边, 才标 BUG 详查。

- [ ] **Step 6: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add server/context.js
git commit -m "context: assemble() 注入 Spotify 听歌信号节"
```

---

## Task 7: README 更新

**Files:**
- Modify: `README.md`

**目的:** 给用户提供"接 Spotify"完整步骤文档。

- [ ] **Step 1: 在 README 里加新一节**

在 `README.md` 的 `## 多音源接入（怎么解锁 VIP）` 大节**之后** (这一大节结尾的 `### 国内网络` 子节之后, `## 调教 Claudio` 之前) 插入:

```markdown
---

## 接入 Spotify 听歌数据（作为口味信号）

不让 Spotify 放歌（DRM 拿不到流），而是把你 Spotify 的 Top Artists + Liked Songs 同步成本地 JSON, 喂给 Claude 当口味画像。多年累积的听歌数据 → Claude 推的更贴你。

### 1. 注册 Spotify Developer App

1. 上 https://developer.spotify.com/dashboard, 用你 Spotify 账号登录
2. 点 **Create App**
3. App name 随便 (`claudio-personal`)
4. **Redirect URI 必须填**: `http://127.0.0.1:3001/callback` (Spotify 不接受 `localhost`)
5. 拿到 Client ID + Client Secret

### 2. 填 .env

```ini
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

### 3. 一次性授权

```bash
cd claudio
set -a; source .env; set +a
node scripts/spotify-auth.js
```

脚本会:
- 起本地 callback 服务 :3001
- 开浏览器到 Spotify 授权页 (只要 `user-top-read` + `user-library-read`)
- 你点同意 → 浏览器跳回本地 → 终端显示 ✓ → 退出

`state/spotify-token.json` 生成, 内含 refresh_token (永久有效, 除非 revoke)。

### 4. 数据怎么进 prompt

之后每次 `./start.sh`:
- 服务启动看 `user/spotify-listening.json` mtime
- 超 24h 或没文件 → 后台异步从 Spotify 拉一次 (Top Artists 3 期 × 30 + Liked Songs × 200)
- prompt 里多一节 `# 我的 Spotify 听歌信号` 给 Claude 看

启动日志会有这两种之一:
```
[spotify] 听歌信号已刷新
[spotify] 听歌信号缓存 (< 24h)
```

### 故障排查

| 问题 | 解决 |
|---|---|
| 启动日志 `[spotify] 没授权` | 跑 `node scripts/spotify-auth.js` |
| 启动日志 `refresh 失败` | 看完整 warning, 通常是网络或 Spotify 短暂挂; 不影响其它源 |
| 启动日志 `refresh_token invalid_grant, 请重跑 scripts/spotify-auth.js` | refresh_token 被 revoke (在 Spotify Dashboard 撤销 app, 或长期没用), 重跑 auth 脚本 |
| 跑 spotify-auth.js 报 `端口 3001 被占用` | `lsof -nP -iTCP:3001 -sTCP:LISTEN` 查谁占的, 释放再跑 |

### Phase 2 备忘

将来可以加 YouTube Music (yt-dlp 扒 Liked Songs)、Apple Music (要 $99/年 Developer 账号), 或者手动导出 (QQ / 汽水) 的解析器。各自单独 spec, 数据 merge 到同一份 `user/spotify-listening.json` (或改名 `user/listening-history.json`)。
```

注意: README 不必额外加 `MUSIC_SOURCES` / `NCM_BASE` 之类的修改 — Spotify 不是播放源, 跟现有"音源"那部分解耦。

- [ ] **Step 2: 手测 — 看渲染**

```bash
cd /Users/zejia/Claudes/claudio
grep -c "Spotify 听歌数据" README.md
# 期望: ≥1
```

肉眼也过一遍, 中文段落别串行。

- [ ] **Step 3: Commit**

```bash
cd /Users/zejia/Claudes/claudio
git add README.md
git commit -m "docs: README 加接入 Spotify 听歌数据一节"
```

---

## Task 8: 端到端验证 + 走 spec 手测清单

**Files:** 无新改, 走 spec 末尾的"手测清单"逐项过。

- [ ] **Step 1: 逐项过手测清单**

打开 `docs/superpowers/specs/2026-05-27-spotify-taste-signal-design.md`, 找"手测清单"小节, 每条勾选。这里把清单复制一份方便记录:

```
[ ] .env 没填 client id/secret → spotify-auth.js 报错友好退出
[ ] 填了 client id/secret → spotify-auth.js 自动开浏览器, 授权后写 token 文件成功
[ ] state/spotify-token.json 存在, server 启动后日志 "听歌信号已刷新"
[ ] user/spotify-listening.json 生成, JSON 合法, 三期 artists + liked 都有内容
[ ] 立即重启 server → 日志 "听歌信号缓存 (< 24h)", 不重新拉
[ ] 手动 `touch -d "2 days ago" user/spotify-listening.json` 后重启 → "已刷新"
[ ] 在 chat 里输自然语言 → Claude 返回的歌单合理, 跟你 Spotify Top Artists 有重叠 (主观验证)
[ ] (验证 prompt 实际内容) 临时 console.log 出 prompt, 确认 Spotify 一节存在且数据正确
[ ] 拿掉 state/spotify-token.json → 重启 server → "没授权, 跳过", 不崩
[ ] 改 state/spotify-token.json 的 refresh_token 成乱码 → 重启 → 日志提示重跑 auth
[ ] Spotify Dashboard 里 revoke 这个 app → 下次 refresh 时备份+删 token 文件
```

最后两条要"破坏"实验, 跑完记得恢复:

```bash
# revoke 测试不容易复现, 也可以 skip 它 (跟前一条 "改 refresh_token 成乱码" 等价)
```

- [ ] **Step 2: 修发现的 bug**

如果发现问题, 针对性修, commit 格式:

```bash
git add <修过的文件>
git commit -m "fix: <问题描述>"
```

没问题就 skip 这一步。

---

## 完成检查

- [ ] 所有 8 个任务勾完
- [ ] `git log --oneline 403c385..HEAD` 看一下提交链路清晰
- [ ] `git status` 干净 (`.env`, `state/spotify-token.json`, `user/spotify-listening.json` 都不该出现在 status 里 — 前两个 gitignored, 最后一个 user 没说要 ignore, 但 spec 也没说要 track, 这里默认让它进 git 是可疑的; **建议把 `user/spotify-listening.json` 加进 .gitignore** — 这条 nice-to-have 是 Step 3, 可选)
- [ ] 手测清单全过

可选 Step 3 (推荐): `user/spotify-listening.json` 包含具体听歌内容, 算半隐私数据, 不应该 commit。加到 .gitignore:

```bash
cd /Users/zejia/Claudes/claudio
echo "" >> .gitignore
echo "# 个人听歌数据 (从 Spotify 同步)" >> .gitignore
echo "user/spotify-listening.json" >> .gitignore
git add .gitignore
git commit -m "gitignore: user/spotify-listening.json (个人听歌数据)"
```
