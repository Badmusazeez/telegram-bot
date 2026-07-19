# Ethereum NFT Copy Bot (Telegram)

Track Ethereum wallets in Telegram. When a tracked wallet receives an ERC-721 NFT (OpenSea Seaport, Blur, or other on-chain activity), the bot alerts you and can evaluate a copy trade.

**Dry-run is on by default.** Live auto-buy fulfillment is intentionally gated so a bad marketplace calldata path cannot drain funds.

## Features

- Track any number of Ethereum wallets from Telegram
- Poll mainnet for ERC-721 transfers to those wallets
- Detect OpenSea Seaport / Blur settlement contracts
- Enrich alerts with Alchemy NFT metadata (name + image when available)
- Copy-trade evaluation with max price, gas cap, and collection allowlist
- Persistent state in `data/state.json`

## Quick start

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN + ETH_RPC_URL (Alchemy recommended)
npm install
npm run dev
```

### 1) Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token into `TELEGRAM_BOT_TOKEN`
3. Message your bot, then get your chat id from [@userinfobot](https://t.me/userinfobot)
4. Set `TELEGRAM_ALLOWED_CHAT_IDS=your_chat_id`

### 2) Ethereum RPC

Use Alchemy or another archive-capable mainnet endpoint:

```env
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ALCHEMY_API_KEY=YOUR_KEY
```

### 3) Run

```bash
npm run dev     # development
npm run build && npm start
```

In Telegram:

```text
/start
/track 0xWalletAddress Whale1
/wallets
/status
/copy on
/maxbuy 0.05
```

## Telegram commands

| Command | Description |
|---|---|
| `/start` | Register chat for alerts |
| `/help` | Command list |
| `/status` | Copy mode, dry-run, max buy, last block |
| `/wallets` | List tracked wallets |
| `/track <addr> [label]` | Start tracking a wallet |
| `/untrack <addr>` | Stop tracking |
| `/copy on\|off` | Toggle copy evaluation |
| `/dryrun on\|off` | Toggle simulation mode |
| `/maxbuy <eth>` | Max ETH for a copy |
| `/allow <contract\|clear>` | Collection allowlist |

## Copy trading safety

| Setting | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | Simulate only — recommended |
| `COPY_ENABLED` | `false` | Must enable via env or `/copy on` |
| `MAX_BUY_ETH` | `0.05` | Hard price ceiling |
| `MAX_GAS_GWEI` | `40` | Skip when gas is too high |
| `ALLOWED_COLLECTIONS` | empty | Empty = all collections |
| `PRIVATE_KEY` | empty | Required only for live signing |
| `OPENSEA_API_KEY` | empty | Used to look up asks before live copy |

Live auto-fulfillment through Seaport is **not** enabled by default. When dry-run is off and an OpenSea listing is found, the bot reports the ask and stops before broadcasting a fulfill transaction. Extend `src/ethereum/copyExecutor.ts` if you want to plug in your own fulfillment path.

## Architecture

```text
Telegram commands ──► state store (data/state.json)
                           │
Ethereum RPC poll ──► NFT transfer monitor ──► copy evaluator ──► Telegram alert
```

## Notes

- Only ERC-721 `Transfer` events with 4 indexed topics are decoded (standard collections).
- Marketplace buys paid in WETH may show `Paid: unknown / transfer` while still tagging Seaport/Blur as the venue.
- Never commit `.env` or a funded private key.
- NFT copy trading is high risk; you can lose money quickly on fees, snipes, and illiquid exits.
