#!/usr/bin/env bash
set -euo pipefail

DOMAIN="129-226-81-110.sslip.io"
RUNTIME="http://127.0.0.1:4330"
CONF="/etc/nginx/conf.d/dots-mcp-ssl.conf"
TMP_CONF="$(mktemp)"
BACKUP=""

cleanup() {
  rm -f "$TMP_CONF"
}
trap cleanup EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run: sudo $0"
  exit 1
fi

if [[ -f "$CONF" ]]; then
  BACKUP="${CONF}.bak.$(date +%Y%m%d%H%M%S)"
  cp -a "$CONF" "$BACKUP"
fi

certbot certonly \
  --webroot -w /var/www/letsencrypt \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --keep-until-expiring

cat >"$TMP_CONF" <<EOF
server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 2m;

    location / {
        proxy_pass ${RUNTIME};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
        proxy_buffering off;
    }
}
EOF

install -m 0644 "$TMP_CONF" "$CONF"

if ! nginx -t; then
  echo "nginx validation failed; rolling back Dots-only config" >&2
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then
    cp -a "$BACKUP" "$CONF"
  else
    rm -f "$CONF"
  fi
  nginx -t || true
  exit 1
fi

systemctl reload nginx

echo "Dots HTTPS health:"
curl -fsS "https://${DOMAIN}/health"
echo

if [[ -f /home/ubuntu/dots-runtime/.env ]]; then
  MCP_URL="$(python3 - <<'PY'
import hashlib
from pathlib import Path
token = ""
for line in Path("/home/ubuntu/dots-runtime/.env").read_text().splitlines():
    if line.startswith("DOTS_TOKEN="):
        token = line.split("=",1)[1].strip()
        break
if token:
    secret = hashlib.sha256(("dots-mcp-path:" + token).encode()).hexdigest()[:48]
    print("https://129-226-81-110.sslip.io/mcp/" + secret)
PY
)"
  if [[ -n "$MCP_URL" ]]; then
    echo "MCP URL (keep private): $MCP_URL"
  fi
fi

echo "Dots 443 install complete."
