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

That writes `.env`, runs `npm install` + `build`, imports all RH **mint keys** and **tracked (/track) wallets** with `--replace`, and starts `pm2` app `arc-nft-bot`.

### Verify

```bash
node -e "const d=require('/root/arc-telegram-bot/data/mint-wallets.json'); console.log('Arc mint keys:', d.length)"
node -e "const s=require('/root/arc-telegram-bot/data/state.json'); console.log('Arc tracked:', s.trackedWallets.length); s.trackedWallets.forEach((w,i)=>console.log(i+1, w.address, w.label))"
pm2 list
```

Then in Telegram `@arcybot_bot`: `/start` → `/listkeys` → `/wallets`.

## Local / cloud setup

```bash
cd /root/arc-telegram-bot   # or this folder
cp env.example .env         # fill TELEGRAM_* 
npm install && npm run build
npm run import-keys -- /path/to/mint-wallets.json --replace
npm run import-tracks -- /path/to/state.json --replace
pm2 start ecosystem.config.cjs
```

## Network

- Mainnet: `CHAIN=arc` · `https://rpc.arc-scan.org` · chainId `5042`
- Testnet: `CHAIN=arc-testnet` · `https://rpc.testnet.arc.io` · chainId `5042002`

Gas token is **USDC** (native).


## Treasury (native USDC)

Arc gas is **USDC**. From Telegram `@arcybot_bot` (requires `/dryrun off` for live sends):

```
/consolidate help
/consolidate              # sweep mint keys → funding / key #1
/consolidate 0xAddress

/disburse 1 all           # fund every mint key with 1 USDC
/disburse 0.5 1 2         # by /listkeys numbers
/disburseall 1            # same as /disburse 1 all
```

Funding wallet = `FUNDING_PRIVATE_KEY` in `.env`, else mint key #1.
