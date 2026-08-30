#!/usr/bin/env bash
# 云版部署 — 把 compose + Caddyfile + .env 推到服务器, 拉最新镜像起容器
#
# 用法: ./scripts/deploy-cloud.sh user@服务器IP
# 前提: 服务器装好 docker (含 compose 插件); 本机能 ssh 免密或输密码上去
# 更新: 代码 push 到 main 后 CI 会自动构建新镜像, 再跑一次本脚本即可

set -euo pipefail
HOST="${1:?用法: ./scripts/deploy-cloud.sh user@服务器IP}"
DIR="/opt/claudio"

cd "$(dirname "$0")/.."

[ -f .env ] || { echo "✗ 缺 .env (cp .env.example .env 然后填)"; exit 1; }
grep -q "^CLAUDIO_DOMAIN=" .env || { echo "✗ .env 里没配 CLAUDIO_DOMAIN (云版必须)"; exit 1; }
grep -q "^CLAUDIO_AUTH_TOKEN=" .env || { echo "✗ .env 里没配 CLAUDIO_AUTH_TOKEN (云版必须, 别裸奔)"; exit 1; }

DOMAIN=$(grep "^CLAUDIO_DOMAIN=" .env | cut -d= -f2 | tr -d ' "')

echo "▸ 推文件到 $HOST:$DIR"
ssh "$HOST" "sudo mkdir -p $DIR && sudo chown \$(id -un) $DIR"
scp docker-compose.cloud.yml Caddyfile .env "$HOST:$DIR/"

# YT cookie: 云上 IP 会被 YouTube 盘查, 挂过滤版 cookie 文件 (只含 YT/Google 域)
# 重新生成: yt-dlp --cookies-from-browser chrome --cookies full.txt --skip-download <YT任意URL>
#          然后 grep 出 youtube/google 行存成 cookies.txt (别把整罐 cookie 传上去!)
[ -f cookies.txt ] || { echo "✗ 缺 cookies.txt (云上 YT 音源需要, 生成方法见本脚本注释)"; exit 1; }
scp cookies.txt "$HOST:$DIR/"

# 大脑走 codex 会员的话, 把本机登录态带上 (容器里挂到 /root/.codex)
if grep -q "^CLAUDIO_BRAIN=codex" .env; then
  [ -f ~/.codex/auth.json ] || { echo "✗ CLAUDIO_BRAIN=codex 但本机没有 ~/.codex/auth.json (先 codex login)"; exit 1; }
  ssh "$HOST" "mkdir -p $DIR/codex"
  scp ~/.codex/auth.json "$HOST:$DIR/codex/auth.json"
fi

echo "▸ 拉镜像 + 起容器"
ssh "$HOST" "cd $DIR && docker compose -f docker-compose.cloud.yml pull && docker compose -f docker-compose.cloud.yml up -d"

echo
echo "✓ 起了 → https://$DOMAIN"
echo "  看日志: ssh $HOST 'cd $DIR && docker compose -f docker-compose.cloud.yml logs -f claudio'"
