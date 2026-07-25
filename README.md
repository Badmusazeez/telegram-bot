# robinhood-nft-copy-bot

Telegram bot for **Robinhood Chain** free-mint NFT copy trading.

Track whale wallets. When they do a **free mint**, the bot can auto-replay the same mint calldata into your wallet. **Paid mints/buys are skipped.**

**Dry-run is on by default.** Turn on live auto-mint only after testing.

## Mode

| Setting | Default | Meaning |
|---|---|---|
| `CHAIN` | `robinhood` | Robinhood Chain (4663) |
| `FREE_MINTS_ONLY` | `true` | Skip paid activity |
| `COPY_ENABLED` | `false` | Auto-mint off until `/copy on` |
| `DRY_RUN` | `true` | Simulate; no spend |

## How auto free-mint works

1. Whale wallet receives an ERC-721 mint (`from = 0x0`, 0 value)
2. Bot loads their mint transaction
3. If they sent a **0-value** mint tx themselves, bot replays the same calldata
4. Paid txs are skipped

## Quick start

```bash
# Windows PowerShell (env.example is easier to see than .env.example)
copy env.example .env

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

## Network (MetaMask)

- Name: Robinhood Chain  
- Chain ID: `4663`  
- RPC: `https://rpc.mainnet.chain.robinhood.com`  
- Symbol: RH gas (native)  
- Explorer: https://robinhoodchain.blockscout.com  

## Safety

- Never paste a private key into Telegram
- Use a fresh low-balance mint wallet
- Malicious mint contracts can still waste gas — allowlist with `/allow` when possible
- Delete `data/state.json` if you reset the bot

## Scheduled mints

Schedule a free mint for a future time (bot must stay running / on VPS):

```text
/schedulemint +5m 0xContract mint1
/schedulemint 2026-07-25T18:00:00Z 0xContract 0x1249c58b
/schedulemintfromtx 0xWhaleTxHash +2m
/schedules
/cancelschedule sch_...
```

Presets: `mint` = `mint()`, `mint1` = `mint(uint256)` qty 1.  
Or paste full calldata hex from a whale mint tx.

Keep `DRY_RUN=false` and `PRIVATE_KEY` set for live scheduled mints.

## Commands

`/start` `/help` `/status` `/wallets` `/track` `/untrack` `/copy` `/dryrun` `/freemints` `/maxbuy` `/allow` `/prices` `/watchprice` `/schedulemint` `/schedules`
