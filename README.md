# arc-nft-copy-bot

Arc Chain NFT copy / snipe Telegram bot — **separate** from the Robinhood bot.

| | Robinhood bot | Arc bot |
|---|---|---|
| Path | `/root/telegram-bot` | `/root/arc-telegram-bot` |
| pm2 | `robinhood-nft-bot` | `arc-nft-bot` |
| Telegram | RH bot token | `@arcybot_bot` |
| Chain | Robinhood 4663 | Arc 5042 (USDC gas) |
| Data | own `data/` | own `data/` |

## Setup

```bash
cd /root/arc-telegram-bot   # or this folder
cp env.example .env         # fill TELEGRAM_* (already set in cloud .env)
npm install
npm run build
```

### Import your 18 Mac keys

From the Robinhood bot on your Mac (or VPS):

```bash
# copy mint-wallets.json then:
npm run import-keys -- /path/to/mint-wallets.json
# or replace entirely:
npm run import-keys -- /path/to/mint-wallets.json --replace
```

Or Telegram: `/addkey <private_key>` × 18.

### Run (pm2 — does not touch RH bot)

```bash
pm2 start ecosystem.config.cjs
pm2 logs arc-nft-bot
```

## Network

- Mainnet: `CHAIN=arc` · `https://rpc.arc-scan.org` · chainId `5042`
- Testnet: `CHAIN=arc-testnet` · `https://rpc.testnet.arc.io` · chainId `5042002`

Gas token is **USDC** (native).
