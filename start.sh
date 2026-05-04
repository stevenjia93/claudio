#!/usr/bin/env bash
# claudio 一键启动 — 起 NeteaseCloudMusicApi (如果没跑) + Node server
#
# 第一次跑前要装好依赖、配好 .env (本地) 或 -e 环境变量 (Docker)。
# 之后:
#   本地: ./start.sh
#   Docker: docker run -e ANTHROPIC_API_KEY=... -p 8080:8080 ghcr.io/stevenjia93/claudio

set -e
cd "$(dirname "$0")"

# ——— 拿到 env ———
# 优先读 .env 文件 (本地), 没文件就靠已经 export 的环境变量 (Docker)
if [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "✗ 没拿到 ANTHROPIC_API_KEY"
  echo "  本地: cp .env.example .env 然后编辑"
  echo "  Docker: docker run -e ANTHROPIC_API_KEY=... ..."
  exit 1
fi

# ——— 装依赖 (本地) ———
if [ ! -d server/node_modules ]; then
  echo "▸ 装 server 依赖..."
  (cd server && npm install --no-audit --no-fund)
fi

# ——— 起 NeteaseCloudMusicApi ———
NCM_PID=""
if curl -fs -o /dev/null "http://localhost:3000/search?keywords=test" 2>/dev/null; then
  echo "▸ NeteaseCloudMusicApi 已经在 :3000 跑着"
else
  echo "▸ 起 NeteaseCloudMusicApi 后台 → /tmp/claudio-ncm.log"
  nohup npx -y NeteaseCloudMusicApi >/tmp/claudio-ncm.log 2>&1 &
  NCM_PID=$!
  for i in $(seq 1 15); do
    sleep 1
    curl -fs -o /dev/null "http://localhost:3000/search?keywords=test" 2>/dev/null && break
  done
  curl -fs -o /dev/null "http://localhost:3000/search?keywords=test" 2>/dev/null \
    || { echo "✗ NeteaseCloudMusicApi 起不来,看 /tmp/claudio-ncm.log"; exit 1; }
fi

# 退出时把后台 NCM 也带走 (在 Docker 里这能让 SIGTERM 正确传播)
cleanup() {
  if [ -n "$NCM_PID" ] && kill -0 "$NCM_PID" 2>/dev/null; then
    kill "$NCM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ——— 起 Claudio ———
echo "▸ 起 Claudio @ http://localhost:8080"
echo "  Ctrl+C 退"
echo
cd server
exec node server.js
