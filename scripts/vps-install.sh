#!/usr/bin/env bash
# One-time VPS install for @porshmints_bot (Ink) ONLY.
#
# HARD RULE: never install into the @Nftcopymint_bot (Robinhood) folder.
# Correct layout:
#   ~/telegram-bot/     → @Nftcopymint_bot (Robinhood) — leave running, do not touch
#   ~/porshmints-bot/   → @porshmints_bot (Ink)  — this install
#
# Usage (from THIS repo root):
#   chmod +x scripts/vps-install.sh
#   ./scripts/vps-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Installing @porshmints_bot (Ink)…"
echo "    HARD SEPARATION from @Nftcopymint_bot (Robinhood)."
echo "    Root: $ROOT"

# ── refuse to install on top of the Robinhood bot ──────────────────────────
if [[ -d "$ROOT/src/robinhood" ]]; then
  echo
  echo "✗ REFUSING: found src/robinhood/ — this is the Robinhood bot tree."
  echo "  Leave that folder alone. Clone THIS bot into ~/porshmints-bot:"
  echo
  echo "  cd ~"
  echo "  git clone -b cursor/eth-free-private-mint-bot-f9dc \\"
  echo "    https://github.com/Badmusazeez/telegram-bot.git porshmints-bot"
  echo "  cd porshmints-bot && ./scripts/vps-install.sh"
  echo
  exit 1
fi

PKG_NAME="$(node -p "require('./package.json').name" 2>/dev/null || true)"
if [[ "$PKG_NAME" == "robinhood-nft-copy-bot" ]]; then
  echo
  echo "✗ REFUSING: package.json is robinhood-nft-copy-bot."
  echo "  You are in the Robinhood folder. Use ~/porshmints-bot instead."
  echo
  exit 1
fi
if [[ "$PKG_NAME" != "porshmints-bot" ]]; then
  echo
  echo "✗ REFUSING: package name is '${PKG_NAME:-unknown}' (expected porshmints-bot)."
  echo "  Check out branch cursor/eth-free-private-mint-bot-f9dc into ~/porshmints-bot."
  echo
  exit 1
fi

BASE="$(basename "$ROOT")"
if [[ "$BASE" == "telegram-bot" ]]; then
  echo
  echo "✗ REFUSING: folder is named 'telegram-bot' (Robinhood install path)."
  echo "  Install @porshmints_bot into a DIFFERENT directory: ~/porshmints-bot"
  echo
  exit 1
fi

# Warn if sibling Robinhood folder exists nearby (OK — just don't touch it)
SIBLING=""
for cand in "$HOME/telegram-bot" "/root/telegram-bot"; do
  if [[ -d "$cand/src/robinhood" || -f "$cand/data/state.json" ]]; then
    SIBLING="$cand"
    break
  fi
done
if [[ -n "$SIBLING" ]]; then
  echo "    ✓ Found Robinhood bot at $SIBLING — leaving it untouched."
fi

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
  echo "    Use the @porshmints_bot token — NEVER the @Nftcopymint_bot token."
  echo "    Use an Ink PRIVATE_KEY + Ink RPC — NEVER the Robinhood wallet/RPC."
else
  echo "==> .env already exists (leaving it alone)"
  chmod 600 .env || true
fi

mkdir -p data
chmod 700 data || true

# Never create Robinhood state filenames in this tree
if [[ -f data/state.json || -f data/mint-wallets.json ]]; then
  echo
  echo "✗ REFUSING: Robinhood state files present in data/ (state.json / mint-wallets.json)."
  echo "  This folder must only use:"
  echo "    data/porshmints-state.json"
  echo "    data/porshmints-mint-wallets.json"
  echo "  Remove the Robinhood files or use a fresh ~/porshmints-bot clone."
  echo
  exit 1
fi

echo "==> Building TypeScript…"
npm run build

echo
echo "Done. @porshmints_bot is isolated from @Nftcopymint_bot."
echo "Next steps:"
echo "  1) nano .env   # @porshmints_bot token + Ink RPC + Ink key + tracked wallets"
echo "     CHAIN=ink"
echo "     ETH_RPC_URL=https://rpc-gel.inkonchain.com"
echo "  2) npm run check"
echo "  3) Quick test:  ./run.sh   then /start in Telegram @porshmints_bot"
echo "  4) Always-on (does NOT affect Robinhood systemd):"
echo "       sudo cp deploy/porshmints-bot.service /etc/systemd/system/"
echo "       # edit WorkingDirectory= if path is not /root/porshmints-bot"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now porshmints-bot"
echo "       sudo journalctl -u porshmints-bot -f"
echo
echo "  Robinhood bot (if installed) keeps using its own service/folder — do not restart it for this."
echo
