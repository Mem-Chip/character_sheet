#!/usr/bin/env bash
# 把界面部署到服务器上的一个静态目录（线上：dnd.memchip.cc/v2/）。
#
# 配置放在仓库根目录的 .deploy.env（不进 git），见 .deploy.env.example：
#   DEPLOY_HOST=user@host     DEPLOY_KEY=~/.ssh/xxx.key     DEPLOY_DIR=/www/wwwroot/<站点>/v2
#   DEPLOY_OWNER=www:www（可选，网站文件的属主）
#
# 做的事：构建 → 打包上传到服务器的临时目录 → 备份线上目录到 ~/backups/ → 换上新的 → 检查。
# 页面本身是纯静态的（数据在 dist/5etools 里），站点外面那道 HTTP 基本认证不受影响。
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .deploy.env ] && set -a && . ./.deploy.env && set +a
: "${DEPLOY_HOST:?缺 DEPLOY_HOST（写在 .deploy.env 里）}"
: "${DEPLOY_DIR:?缺 DEPLOY_DIR（写在 .deploy.env 里）}"
DEPLOY_OWNER="${DEPLOY_OWNER:-www:www}"
SSH=(ssh -o BatchMode=yes)
[ -n "${DEPLOY_KEY:-}" ] && SSH+=(-i "${DEPLOY_KEY/#\~/$HOME}")

if [ "${SKIP_BUILD:-}" != 1 ]; then
  npm run typecheck
  npm test
  npm run build
fi
[ -f dist/index.html ] || { echo "dist/index.html 不存在：先构建" >&2; exit 1; }
[ -d dist/5etools ] || echo "⚠️ dist 里没有 5etools 数据：页面会直接去站点取（可能被跨域挡住）" >&2

STAMP=$(date +%Y%m%d-%H%M%S)
STAGE="/tmp/deploy-$STAMP"
echo "上传到 $DEPLOY_HOST:$STAGE …"
tar -C dist -czf - . | "${SSH[@]}" "$DEPLOY_HOST" "mkdir -p '$STAGE' && tar -xzf - -C '$STAGE'"

echo "备份并替换 $DEPLOY_DIR …"
"${SSH[@]}" "$DEPLOY_HOST" bash -s -- "$DEPLOY_DIR" "$STAGE" "$STAMP" "$DEPLOY_OWNER" <<'REMOTE'
set -euo pipefail
DIR="$1"; STAGE="$2"; STAMP="$3"; OWNER="$4"
mkdir -p ~/backups
if sudo test -d "$DIR"; then
  sudo tar -czf ~/backups/"$(basename "$DIR")-$STAMP.tar.gz" -C "$(dirname "$DIR")" "$(basename "$DIR")"
  echo "  旧版本备份：~/backups/$(basename "$DIR")-$STAMP.tar.gz"
fi
sudo chown -R "$OWNER" "$STAGE"
sudo rm -rf "$DIR.old"
if sudo test -d "$DIR"; then sudo mv "$DIR" "$DIR.old"; fi
sudo mv "$STAGE" "$DIR"
sudo rm -rf "$DIR.old"
echo "  已替换：$(sudo find "$DIR" -type f | wc -l) 个文件，$(sudo du -sh "$DIR" | cut -f1)"
REMOTE

echo "完成。打开站点后强制刷新一次（Ctrl+F5）。"
