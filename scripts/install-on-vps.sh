#!/usr/bin/env bash
# Deploy Ethereum bot (@LarEth_Bot) to /root/eth-telegram-bot.
# Imports RH mint keys + tracked wallets. Does not touch RH / Arc / Ink pm2 apps.
set -euo pipefail

ETH_DIR="${ETH_DIR:-/root/eth-telegram-bot}"
RH_DIR="${RH_DIR:-/root/telegram-bot}"
RH_KEYS="${RH_DIR}/data/mint-wallets.json"
RH_STATE="${RH_DIR}/data/state.json"
BRANCH="${ETH_BRANCH:-cursor/eth-telegram-bot-ad16}"

ETH_RPC="https://eth-mainnet.g.alchemy.com/v2/rII4SERrRQMo_H5GavFfo"
ETH_TOKEN="8851025506:AAGan3ToN00R54FBBg4zfuHiTK7ETz3Es-0"

if [[ ! -f "$RH_KEYS" ]]; then
  echo "ERROR: RH keys not found at $RH_KEYS"
  exit 1
fi
if [[ ! -f "$RH_STATE" ]]; then
  echo "ERROR: RH state not found at $RH_STATE"
  exit 1
fi
if [[ ! -d "$RH_DIR/.git" ]]; then
  echo "ERROR: $RH_DIR is not a git checkout (need origin to clone ETH branch)."
  exit 1
fi

TOKEN="${ETH_TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TOKEN" && -f /root/eth-bot-token.txt ]]; then
  TOKEN="$(tr -d '[:space:]' </root/eth-bot-token.txt)"
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN="$ETH_TOKEN"
fi

REMOTE="$(git -C "$RH_DIR" remote get-url origin)"

if [[ ! -d "$ETH_DIR/.git" ]]; then
  if [[ -e "$ETH_DIR" ]]; then
    echo "ERROR: $ETH_DIR exists but is not a git checkout. Move it aside first."
    exit 1
  fi
  echo "==> Cloning $BRANCH into $ETH_DIR"
  git clone -b "$BRANCH" --single-branch "$REMOTE" "$ETH_DIR"
else
  echo "==> Updating existing $ETH_DIR"
  git -C "$ETH_DIR" fetch origin "$BRANCH"
  git -C "$ETH_DIR" checkout "$BRANCH"
  git -C "$ETH_DIR" pull --ff-only origin "$BRANCH" || true
fi

cd "$ETH_DIR"

upsert_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    # Use | delimiter — URLs contain /
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

if [[ ! -f .env ]]; then
  echo "==> Writing ETH .env"
  cat > .env <<EOF
# Ethereum NFT copy bot (@LarEth_Bot) — SEPARATE from RH / Arc / Ink
TELEGRAM_BOT_TOKEN=${TOKEN}
TELEGRAM_ALLOWED_CHAT_IDS=543570208

CHAIN=ethereum
TRACK_RPC_URL=${ETH_RPC}
MINT_RPC_URL=${ETH_RPC}
TRACK_RPC_BACKUP_URL=
MINT_RPC_BACKUP_URL=
ROBINHOOD_RPC_URL=
ALCHEMY_API_KEY=rII4SERrRQMo_H5GavFfo

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
  echo "==> Refreshing ETH .env (token + Alchemy RPC)"
  upsert_env TELEGRAM_BOT_TOKEN "${TOKEN}"
  upsert_env TELEGRAM_ALLOWED_CHAT_IDS "543570208"
  upsert_env CHAIN ethereum
  upsert_env TRACK_RPC_URL "${ETH_RPC}"
  upsert_env MINT_RPC_URL "${ETH_RPC}"
  upsert_env TRACK_RPC_BACKUP_URL ""
  upsert_env MINT_RPC_BACKUP_URL ""
  upsert_env ROBINHOOD_RPC_URL ""
  upsert_env ALCHEMY_API_KEY "rII4SERrRQMo_H5GavFfo"
fi

echo "==> npm install + build"
npm install
npm run build

echo "==> Import RH mint wallets (replace)"
npm run import-keys -- "$RH_KEYS" --replace
chmod 600 data/mint-wallets.json

echo "==> Import RH tracked wallets (replace)"
npm run import-tracks -- "$RH_STATE" --replace

echo "==> Start pm2 eth-nft-bot (does not touch RH/Arc/Ink)"
pm2 delete eth-nft-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo
echo "DONE. ETH bot at $ETH_DIR"
node -e "const d=require('./data/mint-wallets.json'); console.log('ETH mint keys:', d.length); d.forEach((w,i)=>console.log(i+1, w.address))"
node -e "const s=require('./data/state.json'); console.log('ETH tracked:', (s.trackedWallets||[]).length); (s.trackedWallets||[]).forEach((w,i)=>console.log(i+1, w.address, w.label||''))"
pm2 list | grep -E 'eth|ink|arc|robinhood|name' || pm2 list
echo
echo "In Telegram @LarEth_Bot: /start · /listkeys · /wallets · /golive"
