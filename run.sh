#!/usr/bin/env bash
# Foreground runner for @porshmints_bot (Ethereum) ONLY.
# For always-on: use systemd unit porshmints-bot.service
#
# NEVER run this from the @Nftcopymint_bot / Robinhood folder.
# NEVER reuse that bot's token, .env, or data/.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -d src/robinhood ]]; then
  echo "✗ REFUSING: src/robinhood/ found — this is the Robinhood bot tree."
  echo "  Run @porshmints_bot only from ~/porshmints-bot"
  exit 1
fi

PKG="$(node -p "require('./package.json').name" 2>/dev/null || true)"
if [[ "$PKG" != "porshmints-bot" ]]; then
  echo "✗ REFUSING: package is '${PKG:-unknown}' (expected porshmints-bot)"
  exit 1
fi

if [[ "$(basename "$PWD")" == "telegram-bot" ]]; then
  echo "✗ REFUSING: folder telegram-bot is for @Nftcopymint_bot (Robinhood)."
  echo "  Use ~/porshmints-bot for this Ethereum bot."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not installed. Run: ./scripts/vps-install.sh"
  exit 1
fi

npm run check
exec npm run start:dev
