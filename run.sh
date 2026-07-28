#!/usr/bin/env bash
# Foreground runner (good for first test on VPS).
# For always-on: use systemd (see README / deploy/eth-mint-bot.service).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not installed. Run: ./scripts/vps-install.sh"
  exit 1
fi

npm run check
exec npm run start:dev
