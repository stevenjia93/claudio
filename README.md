# Claudio · 个人 AI 电台

私人 DJ：读懂你的口味 → 跨平台搜歌 → 像 FM 88.7 一样在歌之间报幕。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PWA :8080  (浏览器/手机)                        │
│                                ↕                                         │
│                       Node 服务器 (:8080)                                │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────────┐            │
│  │  Claude  │ElevenLabs│  网易云  │YouTube M │  Spotify     │            │
│  │  (大脑)  │ (DJ嗓)   │ NCM:3000 │  yt-dlp  │ (口味画像)   │            │
│  └──────────┴──────────┴──────────┴──────────┴──────────────┘            │
│                                ↕                                         │
│             state/ (口味 cookie / Spotify token / 听歌历史)              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 它能干什么

### 听
- **多源自动 fallback**：网易云 → YouTube Music 顺序问，谁先给出能播的就用谁
- **专辑封面 + 同步歌词**：边播边滚，词/曲/编曲那种元信息自动滤掉
- **可拖动进度条 + 双击歌词跳转**：像 Apple Music 那样
- **歌词手动滚 + 4s 自动归位**：你想往前看几行歌词，停 4 秒自动回到当下播放行
- **DJ 边说边放**：开场报幕时，下一首已经在响，DJ 嗓在 22% 音量的歌上配音，说完渐回 100%
- **DJ 间奏**：每 2-4 首之间，Claude 自动生成一句过渡词 + ElevenLabs 真人嗓念，跟真电台节奏一致
- **3 种播放模式**：顺序 / 随机 / 单曲循环，主控制栏一个图标按钮切换，模式持久化到 state

### 选
- **6-10 首一批**：Claude 一次推一整套 25-40 分钟的 set，开场暖、中段走、收尾留白
- **`play 稻香 周杰伦` 直连**：搜歌时 artist 名匹配优先，避开翻奏占原唱位
- **♡ 喜欢 / 🖤 不喜欢**：标记后写到 state，下次 prompt 注入"多推这种 / 避开那种"
- **不喜欢自动切下一首 + 5s 撤回 toast**：点 dislike → 底部冒"已不喜欢: X - Y [撤回]"，误点 5 秒内可救回
- **讨厌列表暗藏入口**：tabs 行右上一个 `⋯`，点开浮层管理所有讨厌过的歌，每条 ✕ 一键撤回。**不放主 tab 栏，跟 Spotify 的 "hidden songs" 哲学一致**
- **Spotify 口味画像**（可选）：把你 Spotify 的 Top Artists（4 周/6 月/多年三期）+ Liked Songs 同步成本地 JSON 喂给 Claude，多年积累的听歌习惯都是输入

### 管
- **三合一 tabs**：待播 / 已播 / 喜欢，一个面板切换
- **队列拖拽重排 + ✕ 删除**：随便整理顺序
- **队列双击 → 立即插队播**：跳到那一首
- **已播 / 喜欢双击 → 立即重听**（搜出新链接，跳过队列）
- **"清空" / "换一批" 工具栏**：待播 tab 顶上两个按钮，清空 = 一键倒空队列；换一批 = 清空 + 让 Claude 重推一批

### 看
- **Discord 玻璃卡片**：背景 backdrop-blur
- **白色细格子 + 鼠标聚光**：鼠标周围 170px 内格子变亮
- **流星划过**：星空山景背景上 6-18 秒一颗
- **鼠标水波纹**：拖动时柔和的白色羽化光晕
- **整体响应式**：手机/桌面都自适应

---

## 跑起来 — TL;DR

最快 5 步, Mac 本地:

```bash
# 1. 装基础工具 (没装 Homebrew 先装: https://brew.sh)
brew install node git yt-dlp

# 2. clone + 装依赖
git clone https://github.com/stevenjia93/claudio.git
cd claudio/server && npm install && cd ..

# 3. 配 .env
cp .env.example .env
# 填上 ANTHROPIC_API_KEY (必填) + ELEVENLABS_API_KEY (强推, 不填走机器嗓)

# 4. 起服务
./start.sh

# 5. 第一次跑, 强烈推荐扫码登录网易云 (解锁海外曲 / VIP 曲)
node scripts/netease-auth.js
# 之后浏览器开 http://localhost:8080
```

可选: 接 Spotify 当口味画像 — 看下面 [接入 Spotify](#接入-spotify-听歌数据作为口味信号) 一节。

---

## 跑起来 — 详细

### 方式 A: Docker (一行命令)

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

**Docker 的限制**:
- 网易云扫码登录脚本 `scripts/netease-auth.js` 需要 mac `open` 命令开 Preview, Docker 里跑不动; 容器里只能跑匿名 (大部分歌还是 fallback YT)
- YT Music: 容器拿不到你 Chrome 的 cookie。两个办法:
  - 手贴: `.env` 里写 `YT_COOKIE=YSC=xxx; VISITOR_INFO1_LIVE=xxx;...`（从浏览器 F12 拷）
  - 文件挂载: 在 host 跑一次 `yt-dlp --cookies-from-browser chrome --cookies cookies.txt`, 然后 docker run 加 `-v $(pwd)/cookies.txt:/cookies.txt:ro`, `.env` 里设 `YT_COOKIES_FILE=/cookies.txt`

---

### 方式 B: Mac 本地原生

#### 1. 装基础工具

```bash
# 没装 Homebrew 先装: https://brew.sh
brew install node git yt-dlp     # yt-dlp 是 YouTube Music 必备
node -v                          # 确认 >= 20
```

#### 2. 拿到 API keys

| Key | 必填 | 哪儿拿 | 用途 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **是** | https://console.anthropic.com → API keys | Claude 大脑 |
| `ELEVENLABS_API_KEY` | 推荐 | https://elevenlabs.io → Profile → API key | DJ 真人嗓（不填就用浏览器机器嗓） |
| `ELEVENLABS_VOICE_ID` | 配合上面 | Voice Library 里挑一个，复制 Voice ID | 英文 DJ 声音 |
| `ELEVENLABS_VOICE_ID_ZH` | 可选 | 同上 | 中文 DJ 声音 (默认台湾女声 `9lHjugDhwqoxA5MhX0az`) |
| `SPOTIFY_CLIENT_ID` / `SECRET` | 可选 | https://developer.spotify.com/dashboard | 拉 Spotify 听歌画像 (账号要 Premium) |

#### 3. clone + 装依赖

```bash
git clone https://github.com/stevenjia93/claudio.git
cd claudio/server
npm install        # 装 server 依赖, 含 play-dl (YT Music 备用)
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

# 启用哪些音源 (左到右优先级)
MUSIC_SOURCES=netease,ytmusic
```

#### 5. 起服务 + 网易云登录

```bash
./start.sh
```

`start.sh` 会自动:
1. 检查 `.env` 在不在
2. 没装依赖就 `npm install`
3. NeteaseCloudMusicApi 没跑就后台起一个 (`/tmp/claudio-ncm.log`)
4. 加载 `.env` 然后 `node server/server.js`
5. 启动日志告诉你局域网地址 (手机能用)

打开 <http://localhost:8080> 应该能用。但是: **匿名访问网易云只能拿到部分歌**, 海外曲 / VIP 曲会 fallback 到 YT。**强烈推荐扫码登录一次** (启动 NCM 跑着, 另开一个终端):

```bash
node scripts/netease-auth.js
```

脚本会:
- 起本地轮询去问 NCM 的 `/login/qr/check`
- 自动开 Preview 显示二维码
- 你拿手机网易云 APP → "我的" → 扫一扫 → 扫这个码 → 确认
- 自动抓 cookie + 验证账号 + 写到 `state/netease-cookie.json` (gitignored)
- 显示你的 nickname + vipType

下次 `./start.sh` 启动, 看到这行就说明 cookie 生效:

```
[netease] cookie 加载 ✓ (你的昵称, vipType N)
```

cookie 一般几个月有效, 失效了重跑这个脚本就行。

#### 6. 之后每天怎么用

```bash
./start.sh
```

`Ctrl+C` 退就行。NCM 那个后台进程下次还能复用，不用重启。

---

## 接入 Spotify 听歌数据（作为口味信号）

不让 Spotify 放歌（DRM 拿不到流），而是把你 Spotify 的 Top Artists + Liked Songs 同步成本地 JSON, 喂给 Claude 当口味画像。多年累积的听歌数据 → Claude 推的更贴你。

> ⚠ 注意: 创建 Spotify dev app 的账号必须有 **Premium** 订阅, 不然 API 都返 403。这是 Spotify 自己的政策, 跟代码无关。

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
| Spotify 返 403 "premium required" | 创建 dev app 的账号没 Premium, 或者刚开通 Premium 几小时内 (cache 没刷过来), 等 1-3 小时 |
| 启动日志 `refresh_token invalid_grant, 请重跑 scripts/spotify-auth.js` | refresh_token 被 revoke, 重跑 auth 脚本 |
| 跑 spotify-auth.js 报 `端口 3001 被占用` | `lsof -nP -iTCP:3001 -sTCP:LISTEN` 查谁占的, 释放再跑 |

---

## YT Music

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

## 国内网络

YT Music / Anthropic API 都需要走代理：

```ini
HTTPS_PROXY=http://127.0.0.1:7890    # v2rayN 默认 10808, Clash 默认 7890
HTTP_PROXY=http://127.0.0.1:7890
```

`claude.js` 会自动认这两个变量，走 https-proxy-agent。yt-dlp 也会自动认。

## QQ 音乐 / 汽水音乐

代码里有占位 (`server/sources/qq.js`, `douyin.js`), **目前不可用**。腾讯 / 字节系把 API 锁得很死, 第三方 wrapper 项目 (jsososo/QQMusicApi 等) 自 2022 年起没更新, 上游接口早就变了。如果以后有靠谱的 wrapper 出现可以重启这条线。

---

## 调教 Claudio

四个文件，改了立刻生效（不用重启）：

| 文件 | 干嘛的 |
|---|---|
| `user/taste.md` | 你的音乐口味 — 爱什么、烦什么、什么场景听什么 |
| `user/routines.md` | 你的作息 — Claudio 会结合时间挑歌 |
| `user/playlists.json` | 锚点歌单 — 给 Claudio 当参考 |
| `prompts/dj-persona.md` | DJ 英文人设 (BBC Radio 3 风) |
| `prompts/dj-persona-zh.md` | DJ 中文人设 (台湾午夜电台女声风) |

`state.json` 也是 Claude 的输入：
- `feedback.liked / disliked` — 你点过 ♡ 和 🖤 的歌，prompt 里会注入 "多推类似的 / 避开"
- `plays[-10:]` — 最近 10 次播放，避免重复
- `messages[-6:]` — 最近 6 条对话上下文
- `playMode` — 你选的播放模式 (顺序/随机/单曲循环), 跨重启保留
- `djLanguage` — 你选的 DJ 语种 ('en' 或 'zh'), 跨重启保留

还有两个**自动同步**的输入 (跑过对应脚本后自动注入):
- `user/spotify-listening.json` — Spotify Top Artists + Liked Songs (24h 自动刷新)
- `state/netease-cookie.json` — 网易云登录态 (让 netease 拉到 VIP/海外曲)

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
| 点 ⏭ | 下一首 (尊重当前模式: 随机 → 随机一首; 单曲循环 → 跳出循环到下一首) |
| 点 模式按钮 (≡→ / ⇄ / ↻) | 切顺序 / 随机 / 单曲循环 |
| 点 顶部 `🎙 EN` / `🎙 中` pill | 切 DJ 语种 (英文 ⇄ 中文); 切了不动当前队列, 下次 DJ 说话/选歌按新语种 |
| 点 ♡ | 标记喜欢；再点取消 |
| 点 🖤 (心碎) | 标记不喜欢 + 自动切下一首 + 底部 5s 撤回 toast |
| 点 toast 里 [撤回] | 取消刚才的 dislike (5s 内有效) |
| tabs 行最右 ⋯ | 看历史 dislike 列表, 每条 ✕ 撤回 |
| 待播 tab 顶 [清空] | 一键清空待播列表 |
| 待播 tab 顶 [换一批] | 清空 + 让 Claude 重推一批 |
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
│   │   ├── netease.js            网易云 (走 NeteaseCloudMusicApi :3000 + cookie 持久化)
│   │   ├── ytmusic.js            YT Music (yt-dlp + 流代理 + artist 排序)
│   │   ├── qq.js                 QQ 音乐 (占位, 上游 wrapper 死了)
│   │   └── douyin.js             汽水音乐 (占位, 没好的公开 API)
│   ├── taste-sources/
│   │   └── spotify.js            Spotify 口味画像同步 (24h TTL)
│   ├── tts.js                    ElevenLabs 语音合成 + 缓存
│   ├── router.js                 意图分流 (control / play / chat)
│   ├── context.js                组装 prompt (主对话 / 间奏报幕)
│   └── state.js                  状态持久化 (JSON)
├── pwa/                          播放器前端
│   ├── index.html
│   ├── app.js                    播放 + 歌词 + 队列 + 模式 + dislike-undo + 鼠标动效
│   ├── style.css                 Discord 玻璃 × 风景图 × 流星
│   └── manifest.json
├── scripts/
│   ├── netease-auth.js           一次性网易云 QR 扫码登录
│   └── spotify-auth.js           一次性 Spotify OAuth 授权
├── prompts/dj-persona.md         DJ 人设 (BBC Radio 3 风)
├── user/                         你的个人语料
│   ├── taste.md
│   ├── routines.md
│   └── playlists.json
├── docs/superpowers/             设计文档 + 实现计划
└── .env                          密钥 (自己创建,不上 git)
```

运行时自动生成 (都 gitignored):
```
state/state.json                  播放历史 + 队列 + 反馈 + 模式 + DJ 间奏节奏
state/netease-cookie.json         网易云登录 cookie (跑过 netease-auth.js 后)
state/spotify-token.json          Spotify OAuth token (跑过 spotify-auth.js 后)
user/spotify-listening.json       同步下来的 Top Artists + Liked Songs (24h 自动刷)
tts_cache/<hash>.mp3              真人嗓缓存 (相同文本不重合成)
```

---

## 手机也能用

Mac 跑着 server，手机连同一个 WiFi：

1. 启动日志里那个 **局域网** 地址（`http://192.168.x.x:8080`），手机浏览器打开
2. iOS Safari → 分享 → "添加到主屏幕" → 装成 PWA
3. Mac 系统设置 → 网络 → WiFi → 详细信息 → TCP/IP，看 IP 地址。一般能直接通，不用管防火墙

---

## 出门也能用 / 朋友也能听 (Cloudflare Tunnel + Access)

Mac 跑着 claudio 不动, 但通过 Cloudflare 给一个公网 HTTPS 域名 + 登录鉴权。**不公开**, 只有你白名单的邮箱能进。

### 架构

```
[你 / 朋友 手机或电脑]
       ↓ https://claudio.<你域名>.com (任意网络都通)
[Cloudflare 边缘 — Access 登录验证 (邮箱 magic link)]
       ↓ 加密 tunnel
[你 Mac — cloudflared 进程]
       ↓ localhost:8080
[claudio]
```

### 前提

- 一个域名挂在 Cloudflare DNS (随便买一个 .xyz / .me 几块钱一年, NS 改到 Cloudflare 即可)
- Mac 要常开, 合盖会睡 → 系统设置 → 电池 → "防止 Mac 自动睡眠" 勾上

### 一次性搭建 (~15 分钟)

#### 1. 装 cloudflared 并登录

```bash
brew install cloudflared
cloudflared tunnel login              # 开浏览器选你域名授权
cloudflared tunnel create claudio     # 创建一个叫 claudio 的隧道
```

留意输出里的 **tunnel id** (一串 UUID), 后面要用。

#### 2. 配置隧道

新建 `~/.cloudflared/config.yml`:

```yaml
tunnel: <你刚才那个 UUID>
credentials-file: /Users/<你用户名>/.cloudflared/<UUID>.json

ingress:
  - hostname: claudio.<你域名>.com
    service: http://localhost:8080
  - service: http_status:404
```

#### 3. 把域名指向隧道

```bash
cloudflared tunnel route dns claudio claudio.<你域名>.com
```

#### 4. 跑隧道 (常驻)

```bash
cloudflared tunnel run claudio
```

把这条放进 `tmux` / `nohup` / 写个 launchd plist 让它开机自启。

#### 5. 加 Cloudflare Access 登录页 (关键, 不加就是开放代理)

在 Cloudflare Dashboard:
- **Zero Trust** (左边) → **Access** → **Applications** → **Add an application** → **Self-hosted**
- Application domain: `claudio.<你域名>.com`
- 给一个 policy:
  - Action: **Allow**
  - Rule: **Emails** → 填你自己邮箱 + 朋友邮箱列表
- 保存

### 试用

- 浏览器开 `https://claudio.<你域名>.com`
- 跳到 Cloudflare 登录页 → 输你邮箱 → 收到 magic link → 点链接登录
- 跳回 claudio, 跟在 localhost 一样用

朋友想听 → 让他们也用白名单里那个邮箱登录, 同样走 magic link。

### 不想搞域名 / 临时测一下

跳过域名和 Access, 走一次性临时隧道:

```bash
cloudflared tunnel --url http://localhost:8080
```

会吐一个 `https://<随机词>.trycloudflare.com` 出来。**没鉴权**, 任何人扫到这个 URL 都能用你的 Anthropic / ElevenLabs 烧钱, 只适合自己 5 分钟测一下。

### 流量

- mp3 128kbps ≈ 1 MB/分钟; 朋友 1 小时 ~60 MB
- 网易 VIP 走 FLAC ~5 MB/分钟; 1 小时 ~300 MB
- Cloudflare 流量目前不计费 (个人免费版)
- Mac 这边走家里带宽

---

## 配置开关速查

```ini
# —— 必填 ——
ANTHROPIC_API_KEY=

# —— DJ 嗓 (推荐) ——
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=               # 英文 DJ 声音 (默认英式男声)
ELEVENLABS_VOICE_ID_ZH=            # 中文 DJ 声音 (默认台湾女声; UI 顶 pill 切换)

# —— 音源开关 ——
MUSIC_SOURCES=netease,ytmusic      # 优先级,左到右,逗号分隔
NCM_BASE=http://localhost:3000     # 网易云 API 地址
YT_COOKIES_FROM_BROWSER=chrome     # YT 借浏览器登录态
YT_COOKIE=                         # 或手贴 cookie
YT_COOKIES_FILE=                   # Docker 推荐: 挂载 cookies.txt 路径
YT_DLP_BIN=yt-dlp                  # 自定义 yt-dlp 路径

# —— Spotify 口味画像 (可选) ——
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# —— DJ 间奏 ——
DJ_AUTO_INTRO=1                    # 设 0 关闭 "每 2-4 首一段过渡词"

# —— 模型 ——
CLAUDIO_MODEL=claude-sonnet-4-5-20250929    # 默认就够用

# —— 网络 (国内必填) ——
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
```
