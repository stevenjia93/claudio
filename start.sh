#!/usr/bin/env bash
# claudio 一键启动 — 起 NeteaseCloudMusicApi (如果没跑) + Node server
#
# 第一次跑前要装好依赖、配好 .env (看 README)。
# 之后每天 ./start.sh 就够了。

set -e
cd "$(dirname "$0")"

# ——— 检查 .env ———
if [ ! -f .env ]; then
  echo "✗ 找不到 .env, 先 cp .env.example .env 填好你的 key"
  echo "  详见 README"
  exit 1
fi

# ——— 检查依赖 ———
if [ ! -d server/node_modules ]; then
  echo "▸ 装 server 依赖 (cd server && npm install)..."
  (cd server && npm install --no-audit --no-fund)
fi

# ——— 起 NeteaseCloudMusicApi (如果还没跑) ———
if curl -fs -o /dev/null "http://localhost:3000/search?keywords=test" 2>/dev/null; then
  echo "▸ NeteaseCloudMusicApi 已经在 :3000 跑着"
else
  echo "▸ 起 NeteaseCloudMusicApi 后台 → /tmp/claudio-ncm.log"
  nohup npx -y NeteaseCloudMusicApi >/tmp/claudio-ncm.log 2>&1 &
  # 等就绪 (最多 15s)
  for i in $(seq 1 15); do
    sleep 1
    curl -fs -o /dev/null "http://localhost:3000/search?keywords=test" 2>/dev/null && break
  done
  curl -fs -o /dev/null "http://localhost:3000/search?keywords=test" 2>/dev/null \
    || { echo "✗ NeteaseCloudMusicApi 起不来, 看 /tmp/claudio-ncm.log"; exit 1; }
fi

# ——— 起 Claudio ———
echo "▸ 起 Claudio @ http://localhost:8080"
echo "  Ctrl+C 退"
echo
set -a; source .env; set +a
cd server
exec node server.js
