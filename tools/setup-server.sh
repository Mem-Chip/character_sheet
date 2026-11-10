#!/usr/bin/env bash
# 一次性：在服务器上装后端（打包后的 dist-server/main.js）的 systemd 服务，并让 nginx 把 /api/ 转给它。
# 之后的更新走 npm run deploy（会顺带打包、上传 main.js 并重启服务）。
# 再跑一次也安全：会重写 systemd 单元和 nginx 里本脚本管的那一段。
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
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/dnd-v2/main.js
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

# nginx：本脚本管的那段夹在 >>> / <<< 两行之间，每次整段重写；文件里别的规则不动。
# 顺带删掉以前页面在 /v2/ 下时写的那段（「⑤ v2 后端」开头，到第一个单独的 } 为止）。
BAK="$INC.bak-$(date +%Y%m%d%H%M%S)"
sudo touch "$INC"
sudo cp "$INC" "$BAK"
sudo sed -i -e '/^# ── ⑤ v2 后端/,/^}$/d' -e '/^# >>> dnd-v2/,/^# <<< dnd-v2/d' "$INC"
sudo tee -a "$INC" >/dev/null <<NGINX
# >>> dnd-v2（tools/setup-server.sh 写的，再跑一次会整段重写）
# 后端（账户、同步、战役）：/api/ 转给本机 $PORT；proxy_pass 不带路径，后端收到的就是 /api/...
location /api/ {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_read_timeout 30s;
    client_max_body_size 8m;
}
# 站点门禁（server/gate.ts）：页面先问后端放不放行，没输过站点密码就转到 /gate.html。
# 宝塔自己的正则 location（.js / .css / 图片、.well-known 证书验证）不经过这里：打包的代码和图标不算秘密，
# 用户数据都在 /api/ 下，由后端自己挡。
location = /api/gate/check {
    internal;
    proxy_pass http://127.0.0.1:$PORT;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
}
location / {
    auth_request /api/gate/check;
    error_page 401 403 = @gate;
}
location @gate { return 302 /gate.html; }
location = /gate.html { }
# 页面以前在 /v2/ 下：旧链接、书签跳到根目录
location = /v2 { return 301 /; }
location ^~ /v2/ { rewrite ^/v2/(.*)\$ /\$1 permanent; }
# <<< dnd-v2
NGINX
NGX=$(command -v nginx || echo /www/server/nginx/sbin/nginx)
if ! sudo "$NGX" -t; then
  sudo cp "$BAK" "$INC"
  echo "nginx 配置检查没过：已恢复原来的 $INC" >&2
  exit 1
fi
sudo "$NGX" -s reload
echo "nginx：/api/ → 127.0.0.1:$PORT，/v2/ → 跳到 /（备份：$BAK）"
REMOTE
echo "完成。接着 npm run deploy 上传后端并启动。"
