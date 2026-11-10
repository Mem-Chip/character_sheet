#!/usr/bin/env bash
# 把界面部署到服务器上的站点目录（线上：dnd.memchip.cc，站点根目录）。
#
# 配置放在仓库根目录的 .deploy.env（不进 git），见 .deploy.env.example：
#   DEPLOY_HOST=user@host     DEPLOY_KEY=~/.ssh/xxx.key     DEPLOY_DIR=/www/wwwroot/<站点>
#   DEPLOY_OWNER=www:www（可选，网站文件的属主）
#
# 做的事：构建 → 打包上传到服务器的临时目录 → 备份要换掉的那几项到 ~/backups/ → 换上新的 → 检查；
# 站点目录里构建产物以外的东西不动（页面用相对路径，放在子路径下也能用）。
# 后端装过的话（tools/setup-server.sh），顺带上传打包好的 dist-server/main.js 并重启 dnd-v2 服务。
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
  npm run build:server
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
sudo mkdir -p "$DIR"
cd "$STAGE"
# 只换构建产物里有的那几项（index.html、assets、5etools…）：站点根目录里的别的东西
# （宝塔的 .user.ini、证书验证用的 .well-known、错误页）不动
ITEMS=(); for f in * .[!.]*; do [ -e "$f" ] && ITEMS+=("$f"); done
OLD=(); for f in "${ITEMS[@]}"; do sudo test -e "$DIR/$f" && OLD+=("$f"); done
mkdir -p ~/backups
if [ ${#OLD[@]} -gt 0 ]; then
  sudo tar -czf ~/backups/"site-$STAMP.tar.gz" -C "$DIR" "${OLD[@]}"
  echo "  旧版本备份：~/backups/site-$STAMP.tar.gz"
fi
sudo chown -R "$OWNER" "$STAGE"
# index.html 最后换：它引用的新 assets 先到位
for f in "${ITEMS[@]}"; do
  [ "$f" = index.html ] && continue
  sudo rm -rf "$DIR/$f.old"
  if sudo test -e "$DIR/$f"; then sudo mv "$DIR/$f" "$DIR/$f.old"; fi
  sudo mv "$STAGE/$f" "$DIR/$f"
  sudo rm -rf "$DIR/$f.old"
done
sudo mv -f "$STAGE/index.html" "$DIR/index.html"
cd / && sudo rmdir "$STAGE"
echo "  已替换：${#ITEMS[@]} 项（$(sudo du -sh "$DIR" | cut -f1)）"
REMOTE

# 后端（打包后的 dist-server/main.js）：服务装过了（tools/setup-server.sh）才更新
if "${SSH[@]}" "$DEPLOY_HOST" 'systemctl cat dnd-v2 >/dev/null 2>&1'; then
  echo "更新后端 …"
  [ -f dist-server/main.js ] || { echo "dist-server/main.js 不存在：先 npm run build:server" >&2; exit 1; }
  # 小机器上 node 加载打包文件要十几秒：健康检查最多等 30 秒
  "${SSH[@]}" "$DEPLOY_HOST" "sudo tee /opt/dnd-v2/main.js >/dev/null && sudo systemctl restart dnd-v2 && for i in \$(seq 30); do sleep 1; curl -sf http://127.0.0.1:${API_PORT:-8789}/api/health >/dev/null && { echo \"  后端已重启（\${i} 秒）\"; exit 0; }; done; echo '  后端 30 秒内没起来：sudo journalctl -u dnd-v2 -n 30' >&2; exit 1" < dist-server/main.js
else
  echo "（服务器上还没装后端：先跑一次 bash tools/setup-server.sh）"
fi

echo "完成。打开站点后强制刷新一次（Ctrl+F5）。"
