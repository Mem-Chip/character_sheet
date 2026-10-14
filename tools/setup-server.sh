#!/usr/bin/env bash
# 一次性：在服务器上装后端（server/main.ts）的 systemd 服务，并让 nginx 把 /v2/api/ 转给它。
# 之后的更新走 npm run deploy（会顺带上传 main.ts 并重启服务）。
#
# 用 .deploy.env 里的 DEPLOY_HOST / DEPLOY_KEY；另外可以设：
#   API_PORT=8789（8787 是原项目的卡片库后端，8788 是音频转播）
#   NGINX_INCLUDE=/www/server/panel/vhost/rewrite/<域名>.conf（宝塔的「伪静态」文件，面板不会覆盖它）
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .deploy.env ] && set -a && . ./.deploy.env && set +a
: "${DEPLOY_HOST:?缺 DEPLOY_HOST}"
API_PORT="${API_PORT:-8789}"
NGINX_INCLUDE="${NGINX_INCLUDE:-/www/server/panel/vhost/rewrite/dnd.memchip.cc.conf}"
SSH=(ssh -o BatchMode=yes)
[ -n "${DEPLOY_KEY:-}" ] && SSH+=(-i "${DEPLOY_KEY/#\~/$HOME}")

"${SSH[@]}" "$DEPLOY_HOST" bash -s -- "$API_PORT" "$NGINX_INCLUDE" <<'REMOTE'
set -euo pipefail
PORT="$1"; INC="$2"
sudo mkdir -p /opt/dnd-v2 /var/lib/dnd-v2
sudo chown www:www /var/lib/dnd-v2

sudo tee /etc/systemd/system/dnd-v2.service >/dev/null <<UNIT
[Unit]
Description=DnD 2024 v2 后端（账户、人物卡同步、战役）
After=network.target

[Service]
Type=simple
# 只监听 127.0.0.1；外面是 nginx 和站点的 HTTP 基本认证
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/dnd-v2/main.ts
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=DB=/var/lib/dnd-v2/server.db
Environment=SECURE_COOKIE=1
User=www
Group=www
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable dnd-v2 >/dev/null 2>&1

if ! sudo grep -q 'location /v2/api/' "$INC"; then
  sudo cp "$INC" "$INC.bak-$(date +%Y%m%d%H%M%S)"
  sudo tee -a "$INC" >/dev/null <<NGINX

# ── ⑤ v2 后端（账户、同步、战役）：把 /v2/api/ 转给本机 $PORT ──────────
# proxy_pass 不带路径：后端收到的就是 /v2/api/...（它自己去掉 /v2）
location /v2/api/ {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_read_timeout 30s;
    client_max_body_size 8m;
}
NGINX
  NGX=$(command -v nginx || echo /www/server/nginx/sbin/nginx)
  sudo "$NGX" -t
  sudo "$NGX" -s reload
  echo "nginx：已加上 /v2/api/ → 127.0.0.1:$PORT"
else
  echo "nginx：/v2/api/ 已经配过了"
fi
REMOTE
echo "完成。接着 npm run deploy 上传后端并启动。"
