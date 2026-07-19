# Free-Mint NFT Copy Bot (Telegram) — Robinhood Chain

Track whale wallets on **Robinhood Chain** (or Ethereum). When they do a **free mint**, the bot can auto-replay the same mint calldata into your wallet. **Paid mints/buys are skipped.**

**Dry-run is on by default.** Turn on live auto-mint only after testing.

## Mode

| Setting | Default | Meaning |
|---|---|---|
| `CHAIN` | `robinhood` | Robinhood Chain (4663) |
| `FREE_MINTS_ONLY` | `true` | Skip paid activity |
| `COPY_ENABLED` | `false` | Auto-mint off until `/copy on` |
| `DRY_RUN` | `true` | Simulate; no spend |

## How auto free-mint works

1. Whale wallet receives an ERC-721 mint (`from = 0x0`, 0 ETH)
2. Bot loads their mint transaction
3. If they sent a **0 ETH** mint tx themselves, bot replays the same calldata
4. Paid txs (`value > 0`) are skipped

## Quick start (Robinhood + free mints)

```bash
cp .env.example .env
# fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS
# add PRIVATE_KEY only when ready for live auto-mint
npm install
npm run dev
```

Telegram:

```text
/start
/track 0xWhale FreeMinter
/freemints on
/copy on
/dryrun on
/status
```

When dry-run looks good:

```text
/dryrun off
```

Fund the buyer wallet with a little ETH on Robinhood Chain for gas first.

## Network (MetaMask)

- Name: Robinhood Chain  
- Chain ID: `4663`  
- RPC: `https://rpc.mainnet.chain.robinhood.com`  
- Symbol: ETH  
- Explorer: https://robinhoodchain.blockscout.com  

## Safety

- Never paste a private key into Telegram
- Use a fresh low-balance mint wallet
- Malicious mint contracts can still waste gas or behave badly — allowlist collections with `/allow` when possible
- Delete `data/state.json` when switching chains

## Commands

`/start` `/help` `/status` `/wallets` `/track` `/untrack` `/copy` `/dryrun` `/freemints` `/maxbuy` `/allow`
