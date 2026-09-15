#!/usr/bin/env bash
# Run as root on the VPS. Deploys Arc bot to /root/arc-telegram-bot and
# imports RH mint keys + tracked (/track) wallets from the Robinhood bot.
set -euo pipefail

ARC_DIR="${ARC_DIR:-/root/arc-telegram-bot}"
RH_DIR="${RH_DIR:-/root/telegram-bot}"
RH_KEYS="${RH_DIR}/data/mint-wallets.json"
RH_STATE="${RH_DIR}/data/state.json"
BRANCH="${ARC_BRANCH:-cursor/arc-telegram-bot-ad16}"

if [[ ! -f "$RH_KEYS" ]]; then
  echo "ERROR: RH keys not found at $RH_KEYS"
  exit 1
fi

if [[ ! -f "$RH_STATE" ]]; then
  echo "ERROR: RH state not found at $RH_STATE (needed for tracked wallets)"
  exit 1
fi

if [[ ! -d "$RH_DIR/.git" ]]; then
  echo "ERROR: $RH_DIR is not a git checkout (need origin to clone Arc branch)."
  exit 1
fi

REMOTE="$(git -C "$RH_DIR" remote get-url origin)"

if [[ ! -d "$ARC_DIR/.git" ]]; then
  if [[ -e "$ARC_DIR" ]]; then
    echo "ERROR: $ARC_DIR exists but is not a git checkout. Move it aside first."
    exit 1
  fi
  echo "==> Cloning $BRANCH into $ARC_DIR"
  git clone -b "$BRANCH" --single-branch "$REMOTE" "$ARC_DIR"
else
  echo "==> Updating existing $ARC_DIR"
  git -C "$ARC_DIR" fetch origin "$BRANCH"
  git -C "$ARC_DIR" checkout "$BRANCH"
  git -C "$ARC_DIR" pull --ff-only origin "$BRANCH" || true
fi

cd "$ARC_DIR"

if [[ ! -f .env ]]; then
  echo "==> Writing Arc .env"
  cat > .env <<'EOF'
# Arc NFT copy bot — SEPARATE from Robinhood bot (/root/telegram-bot)
TELEGRAM_BOT_TOKEN=8719982394:AAESzt7T5j1k47Kt05k91FaYL0KAlQYfSdM
TELEGRAM_ALLOWED_CHAT_IDS=543570208

CHAIN=arc
TRACK_RPC_URL=https://rpc.arc-scan.org
MINT_RPC_URL=https://rpc.arc-scan.org
TRACK_RPC_BACKUP_URL=
MINT_RPC_BACKUP_URL=
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
fi

echo "==> npm install + build"
npm install
npm run build

echo "==> Import RH mint wallets (replace)"
npm run import-keys -- "$RH_KEYS" --replace
chmod 600 data/mint-wallets.json

echo "==> Import RH tracked wallets (replace)"
npm run import-tracks -- "$RH_STATE" --replace

echo "==> Start pm2 arc-nft-bot (does not touch RH)"
pm2 delete arc-nft-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo
echo "DONE. Arc bot at $ARC_DIR"
node -e "const d=require('./data/mint-wallets.json'); console.log('Arc mint keys:', d.length); d.forEach((w,i)=>console.log(i+1, w.address))"
node -e "const s=require('./data/state.json'); console.log('Arc tracked:', (s.trackedWallets||[]).length); (s.trackedWallets||[]).forEach((w,i)=>console.log(i+1, w.address, w.label||''))"
echo
pm2 list | grep -E 'arc|robinhood|name' || pm2 list
echo
echo "In Telegram @arcybot_bot: /start · /listkeys · /wallets"
