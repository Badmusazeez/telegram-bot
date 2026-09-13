#!/usr/bin/env bash
# Point @porshmints_bot (Ink) tracker + minting at the public Ink RPC.
# Both use the same provider — one URL covers monitor and mint sends.
# Does NOT touch ~/telegram-bot / Robinhood.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLIC_RPC="${1:-https://rpc-gel.inkonchain.com}"

if [[ ! -f .env ]]; then
  echo "✗ No .env in $ROOT — copy env.example first."
  exit 1
fi

if [[ "$(basename "$ROOT")" == "telegram-bot" ]] || [[ -d src/robinhood ]]; then
  echo "✗ REFUSING: this looks like the Robinhood folder. Use ~/porshmints-bot only."
  exit 1
fi

cp .env ".env.bak-$(date +%Y%m%d%H%M%S)"

if grep -qE '^(ETH_RPC_URL|INK_RPC_URL|RPC_URL)=' .env; then
  sed -i -E "s#^(ETH_RPC_URL|INK_RPC_URL|RPC_URL)=.*#\1=${PUBLIC_RPC}#g" .env
else
  echo "ETH_RPC_URL=${PUBLIC_RPC}" >> .env
fi

if grep -q '^CHAIN=' .env; then
  sed -i 's/^CHAIN=.*/CHAIN=ink/' .env
else
  echo 'CHAIN=ink' >> .env
fi

# Clear Alchemy key so NFT enrich doesn't keep hitting a dead Alchemy app
if grep -q '^ALCHEMY_API_KEY=' .env; then
  sed -i 's/^ALCHEMY_API_KEY=.*/ALCHEMY_API_KEY=/' .env
fi

echo "✓ Public Ink RPC set (tracker + minting):"
grep -E '^(CHAIN|ETH_RPC_URL|INK_RPC_URL|RPC_URL|ALCHEMY_API_KEY)=' .env || true
echo
echo "Restart with:"
echo "  sudo systemctl restart porshmints-bot"
echo "  sudo systemctl is-active porshmints-bot"
echo "  sudo journalctl -u porshmints-bot -n 30 --no-pager"
