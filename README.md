# @porshmints_bot — Ethereum mint bot

**This is `@porshmints_bot` (Ethereum).**  
It is **not** `@Nftcopymint_bot` (Robinhood Chain).

| Bot | Chain | Keep separate |
|---|---|---|
| `@porshmints_bot` | Ethereum mainnet | this repo / this VPS folder |
| `@Nftcopymint_bot` | Robinhood Chain | different token, folder, `.env`, keys, state |

Do **not** share Telegram tokens, private keys, `.env`, or `data/` files between them.

---

Telegram bot for **Ethereum** free-mint + private-mint NFT copy trading.

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

> Allowlist/merkle private mints that embed proofs bound to the whale address may still revert on your wallet.

## Run on a VPS (recommended)

Use the **`@porshmints_bot` token** (never the `@Nftcopymint_bot` token).  
Install into a **separate folder** from the Robinhood bot.

### 1) Clone into its own folder

```bash
ssh root@YOUR_VPS_IP

# If you previously cloned into ~/telegram-bot for Robinhood, leave that alone.
# Put THIS bot in a different directory:
cd ~
rm -rf porshmints-bot   # only if reinstalling this ETH bot

git clone -b cursor/eth-free-private-mint-bot-f9dc \
  https://github.com/Badmusazeez/telegram-bot.git porshmints-bot
cd porshmints-bot
```

### 2) Install + create `.env`

```bash
chmod +x scripts/vps-install.sh run.sh
./scripts/vps-install.sh
nano .env
```

Fill at least:

```env
TELEGRAM_BOT_TOKEN=...          # @porshmints_bot token ONLY
TELEGRAM_ALLOWED_CHAT_IDS=YOUR_CHAT_ID
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xyour_eth_mint_wallet_key
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
```

Message **@porshmints_bot** in Telegram: `/start` → `/status`. Stop with `Ctrl+C`.

### 4) Keep it running with systemd

```bash
# WorkingDirectory defaults to /root/porshmints-bot — edit if different
nano deploy/porshmints-bot.service

sudo cp deploy/porshmints-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now porshmints-bot
sudo journalctl -u porshmints-bot -f
```

```bash
sudo systemctl status porshmints-bot
sudo systemctl restart porshmints-bot
sudo systemctl stop porshmints-bot
```

After editing `.env`: `sudo systemctl restart porshmints-bot`.

### Telegram (@porshmints_bot)

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

## Local quick start

```bash
cp env.example .env
# fill @porshmints_bot TELEGRAM_*, ETH_RPC_URL, PRIVATE_KEY, TRACKED_WALLETS
npm install
npm run check
npm run start:dev
```

## Network

- Name: Ethereum Mainnet  
- Chain ID: `1`  
- Explorer: https://etherscan.io  

## Data files (Ethereum bot only)

| File | Purpose |
|---|---|
| `data/porshmints-state.json` | tracked wallets / settings |
| `data/porshmints-mint-wallets.json` | mint keys added via `/addkey` |

These names are intentional so they never collide with `@Nftcopymint_bot` state.

## Safety

- Separate Telegram bot token from `@Nftcopymint_bot`
- Never paste a private key into Telegram (prefer `.env` `PRIVATE_KEY`)
- Use a fresh low-balance Ethereum mint wallet
- Allowlist with `/allow` when possible

## Commands

`/start` `/help` `/status` `/wallets` `/track` `/untrack` `/copy` `/dryrun` `/freemints` `/privatemints` `/maxbuy` `/allow` `/prices` `/watchprice` `/schedulemint` `/schedules`
