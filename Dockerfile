# claudio Docker 镜像
#
# 用法:
#   docker build -t claudio .
#   docker run -d \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     -e ELEVENLABS_API_KEY=sk_... \
#     -e ELEVENLABS_VOICE_ID=... \
#     -p 8080:8080 \
#     -v claudio-state:/app/state \
#     -v claudio-tts:/app/tts_cache \
#     ghcr.io/stevenjia93/claudio:latest

FROM node:20-alpine

# 系统依赖:
#   yt-dlp + ffmpeg → YouTube Music 拉流
#   tini → 容器里正确处理信号 (Ctrl+C / docker stop)
#   curl → start.sh 探活 NeteaseCloudMusicApi 用
RUN apk add --no-cache bash yt-dlp ffmpeg curl ca-certificates tini \
    || ( \
      # alpine 老版本社区源没 yt-dlp, 回落到 pip
      apk add --no-cache bash python3 py3-pip ffmpeg curl ca-certificates tini \
      && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    )

WORKDIR /app

# 先装 server 依赖 (单独一层, package.json 没变就走缓存)
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

# 把 NeteaseCloudMusicApi 装到全局, 避免每次启动 npx 现下载
RUN npm install -g NeteaseCloudMusicApi --no-audit --no-fund

# codex CLI — CLAUDIO_BRAIN=codex 的大脑 (登录态 auth.json 由 volume 挂到 /root/.codex)
# `codex --version` 是构建期自检: alpine/musl 不兼容会让 build 直接失败, 不带病上线
RUN npm install -g @openai/codex --no-audit --no-fund && codex --version

# 拷剩下的代码
COPY . .

# 把 NCM 在容器里的 npx 路径预热: start.sh 用 npx -y NeteaseCloudMusicApi
# (装全局后, npx 会优先找全局版本, 直接 spawn, 不联网)

# 持久化目录 (建议外挂 volume)
VOLUME ["/app/state", "/app/tts_cache"]

EXPOSE 8080

# tini 正确处理 SIGTERM, 让 Node + NCM 都干净退出
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./start.sh"]
