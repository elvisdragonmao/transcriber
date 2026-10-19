#!/usr/bin/env bash
# Install a Caddy build that includes the Cloudflare DNS module next to the apt package
# (apt keeps owning /usr/bin/caddy; we only point the service at /usr/local/bin/caddy-cloudflare).
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK=/root/caddy-change-$TS
sudo mkdir -p "$BK"
sudo cp -a /etc/caddy/Caddyfile "$BK/" 2>/dev/null || true
sudo cp -a /etc/systemd/system/caddy.service.d "$BK/" 2>/dev/null || true
echo "backup: $BK"
TMP=$(mktemp -d)
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com%2Fcaddy-dns%2Fcloudflare" -o "$TMP/caddy"
chmod +x "$TMP/caddy"
"$TMP/caddy" list-modules | grep -q '^dns.providers.cloudflare$' || { echo "downloaded caddy lacks the cloudflare module" >&2; exit 1; }
"$TMP/caddy" version
sudo install -m 0755 "$TMP/caddy" /usr/local/bin/caddy-cloudflare
sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<'CONF'
[Service]
EnvironmentFile=/etc/caddy/cloudflare.env
ExecStart=
ExecStart=/usr/local/bin/caddy-cloudflare run --environ --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/bin/caddy-cloudflare reload --config /etc/caddy/Caddyfile --force
CONF
sudo systemctl daemon-reload
sudo bash -c 'set -a; . /etc/caddy/cloudflare.env; /usr/local/bin/caddy-cloudflare validate --config /etc/caddy/Caddyfile'
