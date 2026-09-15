#!/usr/bin/env bash
# Deploy Ink bot (@porshmints_bot) to /root/ink-telegram-bot.
# Imports RH mint keys + tracked wallets. Does not touch RH or Arc pm2 apps.
set -euo pipefail

INK_DIR="${INK_DIR:-/root/ink-telegram-bot}"
RH_DIR="${RH_DIR:-/root/telegram-bot}"
RH_KEYS="${RH_DIR}/data/mint-wallets.json"
RH_STATE="${RH_DIR}/data/state.json"
BRANCH="${INK_BRANCH:-cursor/ink-telegram-bot-ad16}"

if [[ ! -f "$RH_KEYS" ]]; then
  echo "ERROR: RH keys not found at $RH_KEYS"
  exit 1
fi
if [[ ! -f "$RH_STATE" ]]; then
  echo "ERROR: RH state not found at $RH_STATE"
  exit 1
fi
if [[ ! -d "$RH_DIR/.git" ]]; then
  echo "ERROR: $RH_DIR is not a git checkout (need origin to clone Ink branch)."
  exit 1
fi

# Default = @porshmints_bot (override with INK_TELEGRAM_BOT_TOKEN or /root/ink-bot-token.txt)
TOKEN="${INK_TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TOKEN" && -f /root/ink-bot-token.txt ]]; then
  TOKEN="$(tr -d '[:space:]' </root/ink-bot-token.txt)"
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN="8765326696:AAE5L-II3KSEMYuXxSBm3yTSIhkgfYSn7Vg"
fi

REMOTE="$(git -C "$RH_DIR" remote get-url origin)"

if [[ ! -d "$INK_DIR/.git" ]]; then
  if [[ -e "$INK_DIR" ]]; then
    echo "ERROR: $INK_DIR exists but is not a git checkout. Move it aside first."
    exit 1
  fi
  echo "==> Cloning $BRANCH into $INK_DIR"
  git clone -b "$BRANCH" --single-branch "$REMOTE" "$INK_DIR"
else
  echo "==> Updating existing $INK_DIR"
  git -C "$INK_DIR" fetch origin "$BRANCH"
  git -C "$INK_DIR" checkout "$BRANCH"
  git -C "$INK_DIR" pull --ff-only origin "$BRANCH" || true
fi

cd "$INK_DIR"

if [[ ! -f .env ]]; then
  echo "==> Writing Ink .env"
  cat > .env <<EOF
# Ink NFT copy bot (@porshmints_bot) — SEPARATE from RH / Arc
TELEGRAM_BOT_TOKEN=${TOKEN}
TELEGRAM_ALLOWED_CHAT_IDS=543570208

CHAIN=ink
TRACK_RPC_URL=https://rpc-gel.inkonchain.com
MINT_RPC_URL=https://rpc-gel.inkonchain.com
TRACK_RPC_BACKUP_URL=https://rpc-qnd.inkonchain.com
MINT_RPC_BACKUP_URL=https://rpc-qnd.inkonchain.com
ROBINHOOD_RPC_URL=

COPY_ENABLED=false
DRY_RUN=true
FREE_MINTS_ONLY=true

PRIVATE_KEY=
PRIVATE_KEYS=

MAX_BUY_ROBINHOOD=0.05
MAX_GAS_GWEI=100
MAX_MINT_GAS_LIMIT=2500000
MAX_MINT_QUANTITY=100

PRICE_ALERTS_ENABLED=true
PRICE_ALERT_PCT=10
EOF
  chmod 600 .env
else
  # Keep existing .env but refresh token if installer was given a new one
  if grep -q '^TELEGRAM_BOT_TOKEN=$' .env || grep -q 'PASTE_BOTFATHER' .env; then
    sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TOKEN}|" .env
  fi
fi

echo "==> npm install + build"
npm install
npm run build

echo "==> Import RH mint wallets (replace)"
npm run import-keys -- "$RH_KEYS" --replace
chmod 600 data/mint-wallets.json

echo "==> Import RH tracked wallets (replace)"
npm run import-tracks -- "$RH_STATE" --replace

echo "==> Start pm2 ink-nft-bot (does not touch RH/Arc)"
pm2 delete ink-nft-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo
echo "DONE. Ink bot at $INK_DIR"
node -e "const d=require('./data/mint-wallets.json'); console.log('Ink mint keys:', d.length); d.forEach((w,i)=>console.log(i+1, w.address))"
node -e "const s=require('./data/state.json'); console.log('Ink tracked:', (s.trackedWallets||[]).length); (s.trackedWallets||[]).forEach((w,i)=>console.log(i+1, w.address, w.label||''))"
pm2 list | grep -E 'ink|arc|robinhood|name' || pm2 list
echo
echo "In Telegram @porshmints_bot: /start · /listkeys · /wallets"
