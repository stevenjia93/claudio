# Spotify 听歌信号 设计文档

日期: 2026-05-27
范围: Claudio 个人电台 — 加 Spotify 作为"自动口味信号"输入到 Claude prompt

## 背景与目标

现在 Claudio 选歌的口味输入靠手写 `user/taste.md` + `user/routines.md` + `user/playlists.json` + 运行时 feedback (♥/✕)。这些是用户主动维护的, 信号干净但覆盖窄。

用户在 Spotify 累积多年听歌数据 (Top Artists、Liked Songs), 这是体量大、信号强的隐性口味画像。这个 spec 把 Spotify 数据接进来作为额外的**只读输入信号**, 喂给 Claude 当 prompt 上下文。

**Apple Music / QQ Music / 汽水音乐 / YouTube Music 不在本 spec 范围**。理由:
- Apple Music: 要 $99/年 Apple Developer 账号 + JWT 签名
- QQ Music: 没官方 API
- 汽水音乐: 没官方 API
- YouTube Music: 没官方个人数据 API, 只能 yt-dlp 扒 Liked Songs 歌单

将来可作为 Phase 2/3 单独 spec。

## 非目标

- **不加 Spotify 作为播放源** — Spotify 全曲流有 DRM, 拿不到原始 URL 走 audio.src。播放仍由现有 netease / ytmusic 承担。
- **不做实时 push 同步** — 用户在 Spotify 上听一首新歌, claudio 不会立刻知道。24h 窗口内的新签息延迟可接受。
- **不让 Claude 自动改写 taste.md** — 听歌数据走独立文件 + prompt 独立小节, 跟手写的 taste.md 解耦。让用户能透明看到 Claude 看到了什么。

## 关键设计决策

**只读信号 + 独立文件**: 数据存 `user/spotify-listening.json`, prompt 加新一节, `user/taste.md` 不动。备选方案 (让 Claude 自动 merge 进 taste.md) 被否决: 调试不方便, 用户审阅成本高, 加新源时 (YT/Apple) 又得重新设计 merge 策略。

**一次性 CLI OAuth 脚本**: `scripts/spotify-auth.js` 起临时 HTTP 服务接 callback, 用户跑一次, 写 token, 退出。备选方案 (把 OAuth 集成到 PWA 加"连 Spotify"按钮) 被否决: 个人本地 app, 一辈子授权一次, 不值得加 UI/路由。

**启动时检查 + 24h 后台刷新**: 服务每次启动看 `user/spotify-listening.json` mtime, 超 24h 异步触发 refresh (不阻塞启动)。备选 (cron / 用户手动 sync) 被否决: cron 需要服务 24/7 跑, 手动 sync 用户经常忘。

**Spotify 数据维度**: 只拉 Top Artists (3 期限 × 30 个) + Liked Songs (200 首)。备选 (Top Tracks / Recently Played) 被否决: Top Tracks 跟 Top Artists 信号重叠; Recently Played 噪音大, 一首循环就刷屏。

## 数据流总览

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. 一次性 OAuth: node scripts/spotify-auth.js                     │
│    起 localhost:3001/callback → 浏览器 Spotify 授权 →             │
│    code → token → 写 state/spotify-token.json                     │
├──────────────────────────────────────────────────────────────────┤
│ 2. server.js 启动: 异步调 taste-sources/spotify.refreshIfStale() │
│    a. 读 state/spotify-token.json (没有就 noop)                   │
│    b. 看 user/spotify-listening.json 的 mtime                     │
│    c. > 24h 或文件不存在 → refresh()                              │
│       - 若 token expires_at < now, 先用 refresh_token 换新        │
│       - 拉 Top Artists × 3 期 + Liked Songs (4 页 50/页)           │
│       - 写 user/spotify-listening.json                            │
│    d. token refresh 失败 (revoke) → 备份 + 删 token 文件 + 提示   │
├──────────────────────────────────────────────────────────────────┤
│ 3. assemble() 每次组装 prompt 多读 user/spotify-listening.json    │
│    formatSpotifyBlock() 拼成 prompt 一节, 加在 playlists 之后     │
│    没有文件 → 整节不输出, 不占 token                              │
└──────────────────────────────────────────────────────────────────┘
```

## 新增 / 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/spotify-auth.js` | 新 | 一次性 OAuth 脚本 |
| `server/taste-sources/spotify.js` | 新 | API 客户端 + token 刷新 + 数据同步 |
| `state/spotify-token.json` | 新 (runtime) | access_token / refresh_token / expires_at; gitignored 通过 state/ 整体规则 |
| `user/spotify-listening.json` | 新 (runtime) | 同步下来的 artists + liked, 人可读 JSON |
| `server/server.js` | 改 | 启动时异步触发 refreshIfStale |
| `server/context.js` | 改 | assemble() 多读 spotify-listening.json + formatSpotifyBlock |
| `.env.example` | 改 | 加 SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET |
| `README.md` | 改 | 加"接入 Spotify 听歌数据"一节 |

## OAuth 流程 (scripts/spotify-auth.js)

### 用户一次性准备

1. 上 https://developer.spotify.com/dashboard 点 Create App
2. App name 随便 (例如 "claudio-personal")
3. Redirect URI 填 `http://127.0.0.1:3001/callback` (Spotify 不接受 `localhost`)
4. 拿到 Client ID + Client Secret, 填到 `.env`:
   ```
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ```

### 脚本流程

```
node scripts/spotify-auth.js

▸ 检查 .env 里 SPOTIFY_CLIENT_ID/SECRET 在不在
▸ 起 callback 服务 http://127.0.0.1:3001/callback (必须 127.0.0.1, Spotify 不接受 localhost)
▸ 自动 open 浏览器 (Mac `open` 命令) https://accounts.spotify.com/authorize?
     client_id=...
     response_type=code
     redirect_uri=http://127.0.0.1:3001/callback
     scope=user-top-read user-library-read
     state=<随机 16 字节 base64>

(等浏览器回调)

▸ Spotify 回 GET /callback?code=...&state=...
   - 校验 state 防 CSRF
   - POST https://accounts.spotify.com/api/token (Basic auth: client_id:client_secret)
     grant_type=authorization_code, code, redirect_uri
   - 拿到 access_token + refresh_token + expires_in
▸ 写 state/spotify-token.json:
   {
     "access_token": "BQ...",
     "refresh_token": "AQ...",
     "expires_at": <now + expires_in*1000 ms>,
     "scope": "user-top-read user-library-read"
   }
✓ 完成, 脚本退出
```

### Scope

只要 `user-top-read user-library-read` 两个, 不要 playback / modify / 邮箱等敏感权限。Spotify 授权页只会显示这两条, 信任成本低。

### 错误处理

- 没填 SPOTIFY_CLIENT_ID/SECRET → 提前退出 + 打印准备步骤指引
- 用户拒绝授权 (Spotify 回 `error=access_denied`) → 友好报错退出, 不写文件
- state mismatch → 拒绝 + 提示重跑 (防 CSRF)
- 端口 3001 被占 → 提示用户先释放, 不自动换端口 (跟 Dashboard 注册的 URI 必须一致)
- token 交换 HTTP 失败 → 打印响应体, 退出

## 数据同步模块 (server/taste-sources/spotify.js)

### 对外接口

```js
// 主入口 — server.js 启动时调
export async function refreshIfStale(maxAgeMs = 24 * 60 * 60 * 1000)
//   1. 看 user/spotify-listening.json 的 fs.stat().mtime
//   2. 不存在或 (now - mtime) > maxAgeMs → 调 refresh()
//   3. 否则 noop, 返回 'cached'
//   异步返回 Promise<'refreshed'|'cached'|'no-auth'|'failed'>
//   不抛, 内部 catch 后日志

// 手动入口 — 给 CLI sync 脚本将来用 (本 spec 不实现独立 CLI)
export async function refresh()
//   1. 读 state/spotify-token.json
//   2. 如 expires_at < now + 60s → refreshAccessToken()
//   3. 并行拉:
//      - GET /v1/me/top/artists?time_range=short_term&limit=30
//      - GET /v1/me/top/artists?time_range=medium_term&limit=30
//      - GET /v1/me/top/artists?time_range=long_term&limit=30
//      - 4 次分页 GET /v1/me/tracks?limit=50&offset={0,50,100,150}
//   4. 写 user/spotify-listening.json
//   抛错: 任一步骤失败抛, 让上层 catch
```

### Token 刷新

```js
async function refreshAccessToken(refresh_token)
//   POST https://accounts.spotify.com/api/token
//   Basic auth: client_id:client_secret (Base64)
//   body: grant_type=refresh_token&refresh_token=...
//   响应:
//     - 永远含 access_token + expires_in
//     - 可能含新 refresh_token (Spotify 偶尔 rotate), 也可能省略
//     - 包含: 用新值; 缺省: 保留旧 refresh_token (不要清掉!)
//   写回 state/spotify-token.json (合并字段, 不整体覆盖)
//   如果 HTTP 400 + invalid_grant → refresh_token 被 revoke,
//     mv state/spotify-token.json state/spotify-token.json.broken
//     抛特殊错让上层日志"请重跑 spotify-auth.js"
```

### `user/spotify-listening.json` Schema

```json
{
  "syncedAt": "2026-05-27T09:00:00.000Z",
  "artists": {
    "short_term": [
      {
        "name": "Bon Iver",
        "id": "4LG4Bs1Gadht7TCo4cbA8s",
        "genres": ["indie folk", "indietronica"]
      }
    ],
    "medium_term": [...],
    "long_term": [...]
  },
  "liked": [
    {
      "name": "Re: Stacks",
      "artist": "Bon Iver",
      "addedAt": "2026-05-20T12:34:00.000Z"
    }
  ]
}
```

- `artists.*` 每期最多 30 个, 保留 `genres` 字段 (Spotify 给出, Claude 用得上)
- `liked` 最多 200, `artist` 是逗号分隔的 artist names (如 "Bon Iver, James Blake")
- `syncedAt` ISO 字符串, 给 prompt 显示也给 mtime 备份

### 速率限制

Spotify 限速 ~180 req/min, 单次 refresh 最多 7 次请求, 不近边。

### 失败处理

- 单个 API 4xx/5xx → 整次 refresh 抛错, 不写文件, 旧数据继续用
- token 刷新 invalid_grant → 备份旧 token 文件 + 删, 日志提示用户重跑 auth
- 网络断 → 抛 timeout, 一样旧数据继续用
- `refreshIfStale` 内部 catch 所有错只打 warn 日志, 不影响 server 启动

## Prompt 集成 (server/context.js)

### 位置

`assemble()` 现有 prompt 结构:
```
${persona}
---
# 关于我的品味        ← taste.md
# 我的作息             ← routines.md
# 我爱的歌单 (JSON)   ← playlists.json
${spotifyBlock}        ← 新增, 静态品味画像紧挨在一起
---
# 现在                  ← env
# 最近播放过
# 我标记过喜欢的
# 我标记过不喜欢的
# 最近几句对话
---
# 我现在说              ← userInput
```

### formatSpotifyBlock 函数

```js
function formatSpotifyBlock(rawJson) {
  if (!rawJson) return '';
  let data;
  try { data = JSON.parse(rawJson); } catch { return ''; }

  const top = data.artists || {};
  const liked = (data.liked || []).slice(0, 150);

  const lines = (arr) => (arr || []).map(a => a.name).join(' / ');

  const synced = data.syncedAt
    ? new Date(data.syncedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '?';

  if (!liked.length && !lines(top.short_term)) return '';   // 空数据不输出

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

### Token 预算

- Top Artists 3 行 × ~30 名 = ~300 tokens
- Liked 150 首 × 一行 = ~1500-2000 tokens
- 总计 ~2000 tokens, 当前 prompt 通常 ~1500-3000, 加完仍在 sonnet 4.6 的合理范围 (上下文限制 200k, 不会超)

### 文件缺失 / 空数据

`formatSpotifyBlock` 任一异常 / 解析失败 / 数据为空 都返回空字符串, prompt 整节不出现, 跟没接 Spotify 一样。不输出"空占位"。

## 服务器启动集成 (server/server.js)

在现有 `await state.load();` 之后, `server.listen(...)` 之前, 加:

```js
import * as spotifyTaste from './taste-sources/spotify.js';
spotifyTaste.refreshIfStale().then(result => {
  if (result === 'refreshed') console.log('[spotify] 听歌信号已刷新');
  else if (result === 'cached') console.log('[spotify] 听歌信号缓存 (< 24h)');
  else if (result === 'no-auth') console.log('[spotify] 没授权, 跳过');
}).catch(e => {
  console.warn('[spotify] 后台刷新挂了 (不影响启动):', e.message);
});
```

异步, 不 await。错失败不影响主服务。

## 错误处理 / 边角

| 场景 | 行为 |
|---|---|
| 没跑过 spotify-auth | `state/spotify-token.json` 不存在 → refreshIfStale 返 `no-auth`, 不报错 |
| token expired (1h) | refreshAccessToken 自动换新, 用户无感 |
| refresh_token 被 revoke | 备份旧文件 + 日志提示, 主服务继续跑 (用旧 listening.json) |
| Spotify API 暂时挂 | refresh 抛错, 主服务继续 (用旧 listening.json) |
| user/spotify-listening.json 不存在 | prompt 不出 Spotify 节, Claude 退化到只用手写 taste.md |
| 数据格式 JSON 解析失败 | formatSpotifyBlock 返空, 同上 |
| 用户改了 .env 里 SPOTIFY_CLIENT_ID 但忘记跑 auth | 老 token 仍能用 (refresh_token 跟 client_id 绑定), 直到 token 真过期才崩 — 这是 Spotify 行为, 不在 spec 范围 |

## 手测清单

实施完逐项过:

- [ ] `.env` 没填 client id/secret → 跑 spotify-auth.js 报错友好退出
- [ ] 填了 client id/secret → spotify-auth.js 自动开浏览器, 授权后写 token 文件成功
- [ ] state/spotify-token.json 存在, server 启动后日志 "听歌信号已刷新"
- [ ] user/spotify-listening.json 生成, JSON 合法, 三期 artists + liked 都有内容
- [ ] 立即重启 server → 日志 "听歌信号缓存 (< 24h)", 不重新拉
- [ ] 手动 `touch -d "2 days ago" user/spotify-listening.json` 后重启 → "已刷新"
- [ ] 在 chat 里输自然语言 → Claude 返回的歌单合理, 跟你 Spotify Top Artists 有重叠 (主观验证)
- [ ] (验证 prompt 实际内容) 临时 console.log 出 prompt, 确认 Spotify 一节存在且数据正确
- [ ] 拿掉 state/spotify-token.json → 重启 server → "没授权, 跳过", 不崩
- [ ] 改 state/spotify-token.json 的 refresh_token 成乱码 → 重启 → 日志提示重跑 auth
- [ ] Spotify Dashboard 里 revoke 这个 app → 下次 refresh 时备份+删 token 文件

## 范围外 (将来可考虑)

- Phase 2: YouTube Music Liked Songs 扒 (yt-dlp + `LM` playlist) → merge 到同 schema
- Phase 3: Apple Music MusicKit 接入 ($99/年闸门)
- Phase 4: 手动导出文件解析 (QQ / 汽水)
- 自动化测试套件 (本 spec 沿用项目"手测"惯例)
- Spotify 数据 → taste.md 自动 merge (本 spec 显式否决了)
- 实时 webhook / push 同步 (Spotify 不暴露)
- 多用户 (claudio 单用户本地 app, 不在范围)
