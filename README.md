# arc-nft-copy-bot

Arc Chain NFT copy / snipe Telegram bot — **separate** from the Robinhood bot.

| | Robinhood bot | Arc bot |
|---|---|---|
| Path | `/root/telegram-bot` | `/root/arc-telegram-bot` |
| pm2 | `robinhood-nft-bot` | `arc-nft-bot` |
| Telegram | RH bot token | `@arcybot_bot` |
| Chain | Robinhood 4663 | Arc 5042 (USDC gas) |
| Data | own `data/` | own `data/` |

## VPS install (paste as root)

Requires RH bot already at `/root/telegram-bot` with `data/mint-wallets.json`.

```bash
cd /root
REMOTE=$(git -C /root/telegram-bot remote get-url origin)
git fetch "$REMOTE" cursor/arc-telegram-bot-ad16
git clone -b cursor/arc-telegram-bot-ad16 --single-branch "$REMOTE" /root/arc-telegram-bot
bash /root/arc-telegram-bot/scripts/install-on-vps.sh
```

That writes `.env`, runs `npm install` + `build`, imports all RH mint keys with `--replace`, and starts `pm2` app `arc-nft-bot`.

### Verify

```bash
ls -la /root/arc-telegram-bot/data/mint-wallets.json
node -e "const d=require('/root/arc-telegram-bot/data/mint-wallets.json'); console.log('Arc wallets:', d.length); d.forEach((w,i)=>console.log(i+1, w.address))"
pm2 list
```

Then in Telegram `@arcybot_bot`: `/start` → `/listkeys`.

## Local / cloud setup

```bash
cd /root/arc-telegram-bot   # or this folder
cp env.example .env         # fill TELEGRAM_* 
npm install && npm run build
npm run import-keys -- /path/to/mint-wallets.json --replace
pm2 start ecosystem.config.cjs
```

## Network

- Mainnet: `CHAIN=arc` · `https://rpc.arc-scan.org` · chainId `5042`
- Testnet: `CHAIN=arc-testnet` · `https://rpc.testnet.arc.io` · chainId `5042002`

Gas token is **USDC** (native).
