#!/usr/bin/env bash
# One-time VPS install for eth-free-private-mint-bot
# Usage (from repo root):
#   chmod +x scripts/vps-install.sh
#   ./scripts/vps-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Checking Node.js…"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Installing Node 20 via NodeSource…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "Install Node.js 20+ manually, then re-run this script."
    exit 1
  fi
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20+ required (found $(node -v))."
  exit 1
fi
echo "    $(node -v) / npm $(npm -v)"

echo "==> Installing npm dependencies…"
npm install

if [[ ! -f .env ]]; then
  echo "==> Creating .env from env.example…"
  cp env.example .env
  chmod 600 .env
  echo "    Edit secrets now:  nano .env"
else
  echo "==> .env already exists (leaving it alone)"
  chmod 600 .env || true
fi

mkdir -p data
chmod 700 data || true

echo "==> Building TypeScript…"
npm run build

echo
echo "Done. Next steps:"
echo "  1) nano .env   # TELEGRAM_BOT_TOKEN, chat id, ETH_RPC_URL, PRIVATE_KEY, TRACKED_WALLETS"
echo "  2) npm run check"
echo "  3) Quick test:  npm run start:dev"
echo "  4) Or install systemd (keeps running after logout):"
echo "       sudo cp deploy/eth-mint-bot.service /etc/systemd/system/"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now eth-mint-bot"
echo "       sudo journalctl -u eth-mint-bot -f"
echo
