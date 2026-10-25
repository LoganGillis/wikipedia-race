#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${HOME}/wikipedia-race"
REPO="https://github.com/LoganGillis/wikipedia-race.git"
PORT=3847

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" reset --hard origin/main
fi

cd "$APP_DIR"
if command -v npm >/dev/null 2>&1; then
  :
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

npm install --omit=dev

# systemd unit
sudo tee /etc/systemd/system/wikipedia-race.service >/dev/null <<UNIT
[Unit]
Description=Wikipedia Race WebSocket server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=NODE_ENV=production
ExecStart=$(command -v node) ${APP_DIR}/server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now wikipedia-race.service
sudo systemctl restart wikipedia-race.service

# open firewall if ufw present
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow ${PORT}/tcp || true
fi

sleep 1
curl -fsS "http://127.0.0.1:${PORT}/health" || true
systemctl --no-pager --full status wikipedia-race.service | head -20
echo "PUBLIC_WS=ws://$(curl -fsS -m 3 ifconfig.me 2>/dev/null || echo 51.81.33.210):${PORT}/ws"
