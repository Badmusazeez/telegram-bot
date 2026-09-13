# @porshmints_bot — Ink mint bot

**This is `@porshmints_bot` (Ink chain).**  
It is **not** `@Nftcopymint_bot` (Robinhood Chain).  
They are **entirely separate** — different folder, token, `.env`, keys, state, and systemd service. They never work together.

| Bot | Chain | VPS folder | Systemd | State files |
|---|---|---|---|---|
| `@porshmints_bot` | **Ink** (57073) | `~/porshmints-bot` | `porshmints-bot` | `data/porshmints-*.json` |
| `@Nftcopymint_bot` | Robinhood | `~/telegram-bot` (or similar) | leave as-is | `data/state.json` etc. |

**Do not** share Telegram tokens, private keys, `.env`, `data/`, or systemd units.  
**Do not** install this bot into the Robinhood folder.  
Startup **refuses** to run if it detects the Robinhood tree or the `@Nftcopymint_bot` token.

---

Telegram bot for **Ink** free-mint + private-mint NFT copy trading.

Track whale wallets. When they do a **free mint** (0 ETH) or a **private/paid mint** (mint from `0x0` with value ≤ max buy), the bot can auto-replay the same mint calldata into your wallet. **Secondary marketplace buys are always skipped.**

**Dry-run is on by default.** Turn on live auto-mint only after testing.

## Mode

| Setting | Default | Meaning |
|---|---|---|
| `CHAIN` | `ink` | Ink mainnet (57073) |
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

## Put it on your VPS (separate from Robinhood)

Leave the Robinhood bot running wherever it already is. Do **not** stop it, edit it, or reuse its folder.

### 1) Clone into a NEW folder

```bash
ssh root@YOUR_VPS_IP

# Leave ~/telegram-bot (Robinhood / @Nftcopymint_bot) alone.
cd ~
# Only remove if reinstalling THIS Ink bot:
# rm -rf porshmints-bot

git clone -b cursor/eth-free-private-mint-bot-f9dc \
  https://github.com/Badmusazeez/telegram-bot.git porshmints-bot
cd porshmints-bot
```

You must end up in **`~/porshmints-bot`**, not `~/telegram-bot`.

### 2) Install + create `.env`

```bash
chmod +x scripts/vps-install.sh run.sh
./scripts/vps-install.sh
nano .env
```

Fill at least:

```env
TELEGRAM_BOT_TOKEN=...          # @porshmints_bot token ONLY (new BotFather bot)
TELEGRAM_ALLOWED_CHAT_IDS=YOUR_CHAT_ID
CHAIN=ink
ETH_RPC_URL=https://rpc-gel.inkonchain.com
PRIVATE_KEY=0xyour_ink_mint_wallet_key
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

`npm run check` verifies the token is **`@porshmints_bot`** and refuses `@Nftcopymint_bot`.

### 3) Quick test (foreground)

```bash
./run.sh
```

Message **`@porshmints_bot`** (not the Robinhood bot): `/start` → `/status`. Stop with `Ctrl+C`.

You must see `Telegram bot @porshmints_bot is online` before Telegram will reply.

### 4) Always-on systemd (own unit — does not replace Robinhood)

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

This unit is named **`porshmints-bot`**. It does not stop or restart the Robinhood bot’s service.

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
# fill @porshmints_bot TELEGRAM_*, ETH_RPC_URL (Ink), PRIVATE_KEY, TRACKED_WALLETS
npm install
npm run check
npm run start:dev
```

## Network

- Name: Ink  
- Chain ID: `57073`  
- RPC (public): `https://rpc-gel.inkonchain.com`  
- Explorer: https://explorer.inkonchain.com  
- Gas token: ETH  
- OpenSea slug: `ink`

## Data files (Ink bot only)

| File | Purpose |
|---|---|
| `data/porshmints-state.json` | tracked wallets / settings |
| `data/porshmints-mint-wallets.json` | mint keys added via `/addkey` |

These names are intentional so they never collide with `@Nftcopymint_bot` state.

## Safety

- Separate Telegram bot token from `@Nftcopymint_bot`
- Never paste a private key into Telegram (prefer `.env` `PRIVATE_KEY`)
- Use a fresh low-balance Ink mint wallet (ETH on Ink for gas)
- Allowlist with `/allow` when possible
- Never copy Robinhood `.env` / keys into this folder

## Commands

`/start` `/help` `/status` `/wallets` `/track` `/untrack` `/copy` `/dryrun` `/freemints` `/privatemints` `/maxbuy` `/allow` `/prices` `/watchprice` `/schedulemint` `/schedules`
