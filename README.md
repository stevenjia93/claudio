# Claudio · 个人 AI 电台

私人 DJ:读懂你的听歌习惯 → 规划声音 → 像 DJ 那样报幕。

```
┌──────────────────────────────────────────────────────────────┐
│  PWA :8080  ↔  Node 服务器  ↔  Anthropic API (Claude)       │
│                     ↓             ↓                          │
│             网易云 API :3000   ElevenLabs (DJ 真人嗓)        │
└──────────────────────────────────────────────────────────────┘
```

---

## 跑起来 — Mac 版

### 1. 装基础工具

```bash
# 没装 Homebrew 先装: https://brew.sh
brew install node git
node -v              # 确认 >= 20
```

### 2. 拿到 API keys

- **Anthropic**: https://console.anthropic.com → API keys → Create Key,充 $5
- **ElevenLabs**(可选,但强烈推荐): https://elevenlabs.io → Profile → API key
  - Voice Library 里挑一个声音,复制 Voice ID

> 不配 ElevenLabs 也能跑,DJ 会用浏览器原生 TTS(机器嗓)说话。

### 3. 解压 + 装依赖

```bash
unzip claudio.zip
cd claudio/server
npm install
```

### 4. 设环境变量

复制 `.env.example` 改名成 `.env`,填好你的 key:

```bash
cd ..
cp .env.example .env
# 用任意编辑器打开 .env 填进去
nano .env
```

`.env` 里至少要有:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=IRHApOXLvnW57QJPQH2P
```

### 5. 跑 NeteaseCloudMusicApi(开新终端)

```bash
npx NeteaseCloudMusicApi
```

看到 `server running @ http://localhost:3000` 就成。**这个终端不要关**。

### 6. 跑 Claudio(回原终端)

```bash
cd claudio/server
# 把 .env 加载进当前 shell
set -a; source ../.env; set +a
node server.js
```

启动日志应该是:

```
🎙  Claudio @ http://localhost:8080
   局域网: http://192.168.x.x:8080
   WebSocket: ws://localhost:8080/stream
[tts] ElevenLabs 就绪 · voice=... · model=eleven_turbo_v2_5
   网易云 API 假定在 http://localhost:3000
```

打开 http://localhost:8080,在"跟我说"输入框敲一句话试试。

---

## 手机也能用

Mac 跑着 server,手机连同一个 WiFi:

1. 启动日志里那个 **局域网** 地址(`http://192.168.x.x:8080`),手机浏览器打开
2. iOS Safari → 分享 → "添加到主屏幕" → 装成 PWA
3. Mac 系统偏好设置 → 网络 → WiFi → 详细信息 → TCP/IP,看 IP 地址。一般能直接通,不用管防火墙

---

## 把 Claudio 调教成你的

四个文件,改了立刻生效,不用重启:

| 文件 | 干嘛的 |
|---|---|
| `user/taste.md` | 你的音乐口味 — 爱什么、烦什么、什么场景听什么 |
| `user/routines.md` | 你的作息 — Claudio 会结合时间挑歌 |
| `user/playlists.json` | 锚点歌单 — 给 Claudio 当参考 |
| `prompts/dj-persona.md` | DJ 人设 — 调他怎么说话 |

---

## 网易云 VIP 歌

VIP 歌默认拿不到直链。要解锁:

```bash
# 跑着 NeteaseCloudMusicApi 时,另一个终端
curl "http://localhost:3000/login/qr/key?timestamp=$(date +%s)"
# 拿 unikey,然后:
curl "http://localhost:3000/login/qr/create?key=YOUR_UNIKEY&qrimg=true&timestamp=$(date +%s)"
# 把返回的 base64 二维码图片打开,手机网易云 APP 扫码登录
curl "http://localhost:3000/login/qr/check?key=YOUR_UNIKEY&timestamp=$(date +%s)"
# 看到 code=803 就登录成功了
```

---

## 怎么跟 Claudio 说话

- `play 周杰伦 稻香` → 直连 Netease 搜歌进队列
- `next` / `pause` / `play` / `stop` → 控制
- 任何自然语言 → 走 Claude 大脑,他会挑歌 + 用真人嗓说一段开场白
  - "今晚有点闷,给我来点发呆的"
  - "something melancholic for a rainy afternoon"
  - "我想清醒,但不要太凶"

---

## 国内访问 Anthropic

如果你在国内(出口 IP 是 CN):
- 浏览器和命令行都需要走代理才能调 Anthropic API
- 设代理环境变量:`HTTPS_PROXY=http://127.0.0.1:你的代理端口`(v2rayN 默认 10808/10809)
- `claude.js` 自动检测 `HTTPS_PROXY`,走 node-fetch + https-proxy-agent

---

## 目录结构

```
claudio/
├── server/                     Node 本地大脑
│   ├── server.js               入口 + HTTP/WS
│   ├── claude.js               Anthropic API 适配器(支持代理)
│   ├── music.js                Netease 客户端
│   ├── tts.js                  ElevenLabs 语音合成 + 缓存
│   ├── router.js               意图分流
│   ├── context.js              提示词组装
│   └── state.js                状态持久化(JSON)
├── pwa/                        播放器前端
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── manifest.json
├── prompts/dj-persona.md       DJ 人设
├── user/                       你的个人语料
│   ├── taste.md
│   ├── routines.md
│   └── playlists.json
└── .env                        密钥(自己创建,不上 git)
```

运行时自动生成:
```
state/state.json                播放历史 + 队列
tts_cache/<hash>.mp3            真人嗓缓存
```
