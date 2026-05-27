# Claudio · 个人 AI 电台

私人 DJ：读懂你的口味 → 跨平台搜歌 → 像 FM 88.7 一样在歌之间报幕。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PWA :8080  (浏览器/手机)                        │
│                                ↕                                         │
│                       Node 服务器 (:8080)                                │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐                │
│  │  Claude  │ElevenLabs│  网易云  │ QQ 音乐  │YouTube M │                │
│  │  (大脑)  │ (DJ嗓)   │  :3000   │ 直连HTTP │  yt-dlp  │                │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘                │
│                                ↕                                         │
│                       state.json (口味/历史/喜欢)                        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 它能干什么

### 听
- **多源自动 fallback**：网易云 → QQ → YouTube Music 顺序问，谁先给出能播的就用谁
- **专辑封面 + 同步歌词**：边播边滚，词/曲/编曲那种元信息自动滤掉
- **可拖动进度条 + 双击歌词跳转**：像 Apple Music 那样
- **歌词手动滚 + 4s 自动归位**：你想往前看几行歌词，停 4 秒自动回到当下播放行
- **DJ 边说边放**：开场报幕时，下一首已经在响，DJ 嗓在 22% 音量的歌上配音，说完渐回 100%
- **DJ 间奏**：每 2-4 首之间，Claude 自动生成一句过渡词 + ElevenLabs 真人嗓念，跟真电台节奏一致

### 选
- **6-10 首一批**：Claude 一次推一整套 25-40 分钟的 set，开场暖、中段走、收尾留白
- **`play 稻香 周杰伦` 直连**：搜歌时 artist 名匹配优先，避开翻奏占原唱位
- **♡ 喜欢 / 🖤 不喜欢**：标记后写到 state，下次 prompt 注入"多推这种 / 避开那种"
- **不喜欢自动切下一首**：点 dislike → 自动 next，不让你重复手动两步

### 管
- **三合一 tabs**：待播 / 已播 / 喜欢，一个面板切换
- **队列拖拽重排 + ✕ 删除**：随便整理顺序
- **队列双击 → 立即插队播**：跳到那一首
- **已播 / 喜欢双击 → 立即重听**（搜出新链接，跳过队列）

### 看
- **Discord 玻璃卡片**：背景 backdrop-blur
- **白色细格子 + 鼠标聚光**：鼠标周围 170px 内格子变亮
- **流星划过**：星空山景背景上 6-18 秒一颗
- **鼠标水波纹**：拖动时柔和的白色羽化光晕
- **整体响应式**：手机/桌面都自适应

---

## 跑起来

### 方式 A: Docker (推荐, 一行命令)

```bash
# 1. 拷贝 .env.example 然后填好 API keys
curl -O https://raw.githubusercontent.com/stevenjia93/claudio/main/.env.example
mv .env.example .env
nano .env

# 2. 一行命令拉起来
docker run -d \
  --name claudio \
  -p 8080:8080 \
  --env-file .env \
  -v claudio-state:/app/state \
  -v claudio-tts:/app/tts_cache \
  ghcr.io/stevenjia93/claudio:latest

# 3. 浏览器开 http://localhost:8080
```

或者用 `docker-compose`（更清晰，容易关停）：

```bash
curl -O https://raw.githubusercontent.com/stevenjia93/claudio/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/stevenjia93/claudio/main/.env.example
mv .env.example .env && nano .env
docker compose up -d
```

镜像支持 `linux/amd64` 和 `linux/arm64`（Mac M 系列原生）。看日志 `docker logs -f claudio`，关停 `docker compose down` 或 `docker rm -f claudio`。

**Docker 里的 YouTube Music**：容器拿不到你 Chrome 的 cookie。两个办法：
- 手贴：`.env` 里写 `YT_COOKIE=YSC=xxx; VISITOR_INFO1_LIVE=xxx;...`（从浏览器 F12 拷）
- 文件挂载：在 host 跑一次 `yt-dlp --cookies-from-browser chrome --cookies cookies.txt`，然后 docker run 加 `-v $(pwd)/cookies.txt:/cookies.txt:ro`，`.env` 里设 `YT_COOKIES_FILE=/cookies.txt`

---

### 方式 B: Mac 本地原生

#### 1. 装基础工具

```bash
# 没装 Homebrew 先装: https://brew.sh
brew install node git yt-dlp     # yt-dlp 是 YouTube Music 用的
node -v                          # 确认 >= 20
```

#### 2. 拿到 API keys

| Key | 必填 | 哪儿拿 | 用途 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **是** | https://console.anthropic.com → API keys | Claude 大脑 |
| `ELEVENLABS_API_KEY` | 推荐 | https://elevenlabs.io → Profile → API key | DJ 真人嗓（不填就用浏览器机器嗓） |
| `ELEVENLABS_VOICE_ID` | 配合上面 | Voice Library 里挑一个，复制 Voice ID | |

#### 3. 装依赖

```bash
unzip claudio.zip
cd claudio/server
npm install        # 会自动装 play-dl 作为 YT Music fallback
```

#### 4. 配 .env

```bash
cd ..
cp .env.example .env
nano .env
```

最少填这几个：

```ini
ANTHROPIC_API_KEY=sk-ant-api03-...

# DJ 真人嗓 (强烈推荐, 不填会用机器嗓)
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=IRHApOXLvnW57QJPQH2P

# 启用哪些音源 (左到右优先级, 主源拿不到自动 fallback)
MUSIC_SOURCES=netease,qq,ytmusic
```

#### 5. 起音源 server

**网易云**（必跑，开新终端）：
```bash
npx NeteaseCloudMusicApi
# 看到 "server running @ http://localhost:3000" 就行
```

**QQ 音乐**：直接打 QQ 接口，不需要本地代理 server，但 VIP 曲要 cookie（看下面）

**YouTube Music**：用 `yt-dlp` + 浏览器 cookie，不需要起 server

#### 6. 起 Claudio

```bash
cd claudio/server
set -a; source ../.env; set +a    # 把 .env 加载进 shell
node server.js
```

启动日志：
```
[music] 启用音源 (优先级): netease → qq → ytmusic
🎙  Claudio @ http://localhost:8080
   局域网: http://192.168.x.x:8080
   WebSocket: ws://localhost:8080/stream
[tts] ElevenLabs 就绪
```

打开 <http://localhost:8080> ，在底下输入框敲一句话试试。

#### 之后每天怎么启动

第一次跑过之后，依赖都装好了、`.env` 也填好了，**用一行命令拉起全套**：

```bash
./start.sh
```

`start.sh` 会自动：
1. 检查 `.env` 在不在
2. 没装依赖就 `npm install`
3. NeteaseCloudMusicApi 没跑就后台起一个（日志 `/tmp/claudio-ncm.log`）
4. 加载 `.env` 然后 `node server/server.js`

`Ctrl+C` 退就行。Netease 那个后台进程下次还能复用，不用重启。

---

## 多音源接入（怎么解锁 VIP）

### 网易云 VIP

```bash
# 跑着 NeteaseCloudMusicApi 时,另一个终端
curl "http://localhost:3000/login/qr/key?timestamp=$(date +%s)"
# 拿 unikey, 然后:
curl "http://localhost:3000/login/qr/create?key=YOUR_UNIKEY&qrimg=true&timestamp=$(date +%s)"
# 把返回的 base64 二维码图片打开, 手机网易云 APP 扫码
curl "http://localhost:3000/login/qr/check?key=YOUR_UNIKEY&timestamp=$(date +%s)"
# 看到 code=803 就是登录成功
```

登录态会跟 NeteaseCloudMusicApi 进程绑定，重启它要重登。

### QQ 音乐 VIP（推荐有 VIP 的话）

QQ 音乐的接口现在所有曲（哪怕免费）都需要 cookie 才能拿播放链接。如果你有 QQ 音乐 VIP，登录态贴进来就能解锁全曲库：

1. **Chrome 打开 https://y.qq.com，确认你 VIP 账号已登录**
2. **F12 → Application → Cookies → 选 `https://y.qq.com`**
3. **找两个 cookie 值**：
   - `uin` — 数字，就是你的 QQ 号
   - `qm_keyst` — 很长一串字母数字
4. **填到 `.env`**：
   ```ini
   QQ_UIN=2147483647
   QQ_QM_KEYST=粘贴整段
   ```
   或者直接整段 cookie 头贴：
   ```ini
   QQ_COOKIE=uin=...; qm_keyst=...; pgv_pvid=...; (其他字段都行)
   ```
5. 重启 `node server.js`

没 cookie 的话 QQ 源也能搜歌、也能拿歌词，**只是拿不到播放链接**。会自动 fallback 到 YT Music。

### YouTube Music

YT Music 不需要本地 API server，直接用 `yt-dlp` 子进程。**但 YouTube 反爬越来越严，需要登录态。** 推荐借浏览器现成的 cookie：

```ini
# .env
YT_COOKIES_FROM_BROWSER=chrome    # 或 safari / firefox / edge / brave
```

这样 yt-dlp 会自动从 Chrome 的 cookie 数据库里抽 YouTube 登录态。前提：你 Chrome 已经登录了 YouTube 账号。

不想用浏览器 cookie 也可以手贴：
```ini
YT_COOKIE=YSC=xxx; VISITOR_INFO1_LIVE=xxx; (从浏览器 F12 拷)
```

### 国内网络

YT Music / Anthropic API 都需要走代理：

```ini
HTTPS_PROXY=http://127.0.0.1:7890    # v2rayN 默认 10808, Clash 默认 7890
HTTP_PROXY=http://127.0.0.1:7890
```

`claude.js` 会自动认这两个变量，走 https-proxy-agent。yt-dlp 也会自动认。

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

---

## 调教 Claudio

四个文件，改了立刻生效（不用重启）：

| 文件 | 干嘛的 |
|---|---|
| `user/taste.md` | 你的音乐口味 — 爱什么、烦什么、什么场景听什么 |
| `user/routines.md` | 你的作息 — Claudio 会结合时间挑歌 |
| `user/playlists.json` | 锚点歌单 — 给 Claudio 当参考 |
| `prompts/dj-persona.md` | DJ 人设 — 调他怎么说话 |

`state.json` 也是 Claude 的输入：
- `feedback.liked / disliked` — 你点过 ♡ 和 🖤 的歌，prompt 里会注入 "多推类似的 / 避开"
- `plays[-10:]` — 最近 10 次播放，避免重复
- `messages[-6:]` — 最近 6 条对话上下文

---

## 怎么跟 Claudio 说话

**底下输入框**：
- `play 周杰伦 稻香` → 直连搜歌（按音源优先级 fallback），加进队列
- `next` / `pause` / `play` / `stop` → 控制
- 自然语言 → 走 Claude 大脑，挑 6-10 首 + 说一段开场白
  - "今晚有点闷，给我来点发呆的"
  - "something melancholic for a rainy afternoon"
  - "周一下午写代码，专注但不困"

**鼠标 / 触摸**：

| 操作 | 效果 |
|---|---|
| 点 ▶ / ⏸ | 播放 / 暂停（不会丢当前歌，跟 Next 不同） |
| 点 ⏭ | 下一首 |
| 点 ♡ | 标记喜欢；再点取消 |
| 点 🖤 (心碎) | 标记不喜欢 + 自动切下一首 |
| 拖进度条 | seek，hover 时变粗 + 出白色发光圆点 |
| 双击歌词某行 | 跳到那一行的时间戳 |
| 手动滚歌词 | 静止 4s 自动回到当下行 |
| 拖队列项 | 重排顺序 |
| 点队列 ✕ | 从队列移除 |
| 双击队列项 | 立即插队播 |
| 双击"已播"项 | 重听（重新搜直链） |
| 双击"喜欢"项 | 立即播（不入队） |

---

## 目录结构

```
claudio/
├── server/                       Node 本地大脑
│   ├── server.js                 入口 + HTTP/WS
│   ├── claude.js                 Anthropic API 适配器 (支持代理)
│   ├── music.js                  多音源调度器 + fallback
│   ├── sources/                  各音源适配器 (同接口)
│   │   ├── netease.js            网易云 (走 NeteaseCloudMusicApi :3000)
│   │   ├── qq.js                 QQ 音乐 (直连 c.y.qq.com / u.y.qq.com)
│   │   ├── ytmusic.js            YT Music (yt-dlp + 流代理)
│   │   └── douyin.js             汽水音乐 (占位, 没好的公开 API)
│   ├── tts.js                    ElevenLabs 语音合成 + 缓存
│   ├── router.js                 意图分流 (control / play / chat)
│   ├── context.js                组装 prompt (主对话 / 间奏报幕)
│   └── state.js                  状态持久化 (JSON)
├── pwa/                          播放器前端
│   ├── index.html
│   ├── app.js                    播放 + 歌词 + 队列 + 反馈 + 鼠标动效
│   ├── style.css                 Discord 玻璃 × 风景图 × 流星
│   └── manifest.json
├── prompts/dj-persona.md         DJ 人设 (BBC Radio 3 风)
├── user/                         你的个人语料
│   ├── taste.md
│   ├── routines.md
│   └── playlists.json
└── .env                          密钥 (自己创建,不上 git)
```

运行时自动生成：
```
state/state.json                  播放历史 + 队列 + 反馈 + DJ 间奏节奏
tts_cache/<hash>.mp3              真人嗓缓存 (相同文本不重合成)
```

---

## 手机也能用

Mac 跑着 server，手机连同一个 WiFi：

1. 启动日志里那个 **局域网** 地址（`http://192.168.x.x:8080`），手机浏览器打开
2. iOS Safari → 分享 → "添加到主屏幕" → 装成 PWA
3. Mac 系统设置 → 网络 → WiFi → 详细信息 → TCP/IP，看 IP 地址。一般能直接通，不用管防火墙

---

## 配置开关速查

```ini
# —— 必填 ——
ANTHROPIC_API_KEY=

# —— DJ 嗓 (推荐) ——
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=

# —— 音源开关 ——
MUSIC_SOURCES=netease,qq,ytmusic   # 优先级,左到右,逗号分隔
NCM_BASE=http://localhost:3000     # 网易云 API 地址
QQ_UIN=                            # QQ 音乐 VIP 解锁
QQ_QM_KEYST=
QQ_COOKIE=                         # 或者整段 cookie 头一贴 (覆盖 uin+qm_keyst)
YT_COOKIES_FROM_BROWSER=chrome     # YT 借浏览器登录态
YT_COOKIE=                         # 或手贴 cookie
YT_DLP_BIN=yt-dlp                  # 自定义 yt-dlp 路径

# —— DJ 间奏 ——
DJ_AUTO_INTRO=1                    # 设 0 关闭 "每 2-4 首一段过渡词"

# —— 模型 ——
CLAUDIO_MODEL=claude-sonnet-4-5-20250929    # 默认就够用

# —— 网络 (国内必填) ——
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
```
