# NFT Copy Bot (Telegram) — Ethereum & Robinhood Chain

Track wallets in Telegram on **Ethereum** or **Robinhood Chain**. When a tracked wallet receives an ERC-721 NFT, the bot alerts you (with an OpenSea buy link) and can evaluate a copy trade.

**Dry-run is on by default.** Live auto-buy fulfillment is intentionally gated so a bad marketplace calldata path cannot drain funds.

## Supported chains

| `CHAIN` | Chain ID | Default RPC | Explorer |
|---|---|---|---|
| `ethereum` | 1 | Alchemy mainnet URL | etherscan.io |
| `robinhood` | 4663 | `https://rpc.mainnet.chain.robinhood.com` | robinhoodchain.blockscout.com |

Robinhood Chain is an EVM L2 with OpenSea NFT support.

## Features

- Switch chains with `CHAIN=ethereum` or `CHAIN=robinhood`
- Track wallets from Telegram
- Poll for ERC-721 transfers to those wallets
- OpenSea deep-link in every alert so you can buy from your own wallet
- Copy-trade evaluation with max price, gas cap, and collection allowlist
- Persistent state in `data/state.json`

## Quick start (Robinhood Chain)

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_IDS
# keep CHAIN=robinhood
npm install
npm run dev
```

### 1) Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token into `TELEGRAM_BOT_TOKEN`
3. Message your bot, then get your chat id from [@userinfobot](https://t.me/userinfobot)
4. Set `TELEGRAM_ALLOWED_CHAT_IDS=your_chat_id`

### 2) Chain / RPC

**Robinhood Chain:**

```env
CHAIN=robinhood
ETH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
```

**Ethereum mainnet:**

```env
CHAIN=ethereum
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ALCHEMY_API_KEY=YOUR_KEY
```

### 3) Run

```bash
npm run dev
```

In Telegram:

```text
/start
/track 0xWalletAddress Whale1
/status
```

### Buy the NFT yourself (recommended)

When an alert arrives, tap **OpenSea** in the message, connect your wallet on the correct chain, and buy manually. Keep `DRY_RUN=true` until you understand the risks.

## Telegram commands

| Command | Description |
|---|---|
| `/start` | Register chat for alerts |
| `/help` | Command list |
| `/status` | Chain, copy mode, dry-run, max buy, last block |
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
| `PRIVATE_KEY` | empty | Required only for live signing |

Live Seaport auto-fulfill is **not** enabled by default.

## Notes

- When switching chains, delete `data/state.json` (or reset `lastProcessedBlock`) so block cursors don’t mix.
- Robinhood Chain wallets are separate from Ethereum wallets even if the address string looks the same — activity is per-chain.
- Never commit `.env` or a funded private key.
