#!/usr/bin/env bash
# Foreground runner for @porshmints_bot (Ethereum).
# For always-on: use systemd (deploy/porshmints-bot.service).
# Do not run this from the @Nftcopymint_bot (Robinhood) folder.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not installed. Run: ./scripts/vps-install.sh"
  exit 1
fi

npm run check
exec npm run start:dev
