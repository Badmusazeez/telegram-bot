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

## Quick start

```bash
# copy env template
cp env.example .env

# fill:
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_ALLOWED_CHAT_IDS
#   ETH_RPC_URL (Alchemy recommended)
#   PRIVATE_KEY          ← your mint wallet
#   TRACKED_WALLETS      ← whales to follow (optional; or /track in Telegram)

npm install
npm run dev
```

### Minimal `.env` you care about

```env
TELEGRAM_BOT_TOKEN=123:ABC
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

Telegram:

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

When dry-run looks good:

```text
/dryrun off
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
