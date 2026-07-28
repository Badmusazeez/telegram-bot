# eth-free-private-mint-bot

Telegram bot for **Ethereum** free-mint + private-mint NFT copy trading.

Cloned from the Robinhood free-mint bot, retargeted to Ethereum mainnet.

Track whale wallets. When they do a **free mint** (0 ETH) or a **private/paid mint** (mint from `0x0` with value ≤ max buy), the bot can auto-replay the same mint calldata into your wallet. **Secondary marketplace buys are always skipped.**

**Dry-run is on by default.** Turn on live auto-mint only after testing.

## Mode

| Setting | Default | Meaning |
|---|---|---|
| `CHAIN` | `ethereum` | Ethereum mainnet (1) |
| `FREE_MINTS_ONLY` | `false` | When true, skip private/paid mints |
| `PRIVATE_MINTS_ENABLED` | `true` | Copy private/paid mints under `MAX_BUY_ETH` |
| `COPY_ENABLED` | `false` | Auto-mint off until `/copy on` |
| `DRY_RUN` | `true` | Simulate; no spend |
| `MAX_BUY_ETH` | `0.05` | Max ETH for a private mint copy |

## How mint copy works

1. Tracked whale receives an ERC-721 mint (`from = 0x0`)
2. Bot loads their mint transaction
3. **Free mint** — `value = 0` → replay calldata with `value = 0`
4. **Private mint** — `value > 0` and ≤ `MAX_BUY_ETH` → replay calldata with the same value (and rewrite whale address in calldata when present)
5. Marketplace / secondary buys are skipped

> Allowlist/merkle private mints that embed proofs bound to the whale address may still revert on your wallet. Calldata address rewrite helps when the recipient is embedded, but not for single-use merkle proofs.

## Run on a VPS (recommended)

Use a **new** Telegram bot token (separate from the Robinhood bot). Keep the VPS running 24/7.

### 1) SSH into the VPS and clone this branch

```bash
ssh root@YOUR_VPS_IP   # or your user

# Ubuntu example
sudo apt-get update -y
sudo apt-get install -y git curl

git clone -b cursor/eth-free-private-mint-bot-f9dc https://github.com/Badmusazeez/telegram-bot.git
cd telegram-bot
```

### 2) Install + create `.env`

```bash
chmod +x scripts/vps-install.sh run.sh
./scripts/vps-install.sh
nano .env
```

Fill at least:

```env
TELEGRAM_BOT_TOKEN=123:ABC          # new bot from @BotFather
TELEGRAM_ALLOWED_CHAT_IDS=YOUR_CHAT_ID
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xyour_mint_wallet_key
TRACKED_WALLETS=0xWhale1:Alpha,0xWhale2:Beta
MAX_BUY_ETH=0.05
PRIVATE_MINTS_ENABLED=true
FREE_MINTS_ONLY=false
DRY_RUN=true
COPY_ENABLED=false
```

```bash
npm run check
```

### 3) Quick test (foreground)

```bash
./run.sh
# or: npm run start:dev
```

Message the bot in Telegram: `/start` → `/status`. Stop with `Ctrl+C`.

### 4) Keep it running with systemd

Edit the service file paths if your user/folder differ (`User=` and `WorkingDirectory=`):

```bash
nano deploy/eth-mint-bot.service
# set WorkingDirectory to your real path, e.g. /home/ubuntu/telegram-bot
# set User= to your Linux user

sudo cp deploy/eth-mint-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eth-mint-bot
sudo journalctl -u eth-mint-bot -f
```

Useful commands:

```bash
sudo systemctl status eth-mint-bot
sudo systemctl restart eth-mint-bot
sudo systemctl stop eth-mint-bot
```

After editing `.env`, always `sudo systemctl restart eth-mint-bot`.

### Telegram after it’s online

```text
/start
/track 0xWhale FreeMinter
/freemints off
/privatemints on
/maxbuy 0.05
/copy on
/dryrun on
/status
```

When dry-run looks good: `/dryrun off`

## Local quick start (laptop)

```bash
cp env.example .env
# fill TELEGRAM_*, ETH_RPC_URL, PRIVATE_KEY, TRACKED_WALLETS
npm install
npm run check
npm run start:dev
```
## Network (MetaMask)

- Name: Ethereum Mainnet  
- Chain ID: `1`  
- RPC: Alchemy / Infura / your node  
- Symbol: ETH  
- Explorer: https://etherscan.io  

## Safety

- Never paste a private key into Telegram (prefer `.env` `PRIVATE_KEY`)
- Use a fresh low-balance mint wallet
- Malicious mint contracts can still waste gas — allowlist with `/allow` when possible
- Delete `data/state.json` if you reset the bot

## Scheduled mints

```text
/schedulemint +5m 0xContract mint1
/schedulemint 2026-07-25T18:00:00Z 0xContract 0x1249c58b
/schedulemintfromtx 0xWhaleTxHash +2m
/schedules
/cancelschedule sch_...
```

Presets: `mint` = `mint()`, `mint1` = `mint(uint256)` qty 1.  
Or paste full calldata hex from a whale mint tx. Paid source txs are allowed when private mints are enabled and value ≤ max buy.

## Commands

`/start` `/help` `/status` `/wallets` `/track` `/untrack` `/copy` `/dryrun` `/freemints` `/privatemints` `/maxbuy` `/allow` `/prices` `/watchprice` `/schedulemint` `/schedules`
