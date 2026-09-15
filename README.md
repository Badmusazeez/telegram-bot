# ink-nft-copy-bot (@porshmints_bot)

Ink Chain NFT copy / snipe Telegram bot — **separate** from Robinhood and Arc.

| | Robinhood | Arc | Ink |
|---|---|---|---|
| Path | `/root/telegram-bot` | `/root/arc-telegram-bot` | `/root/ink-telegram-bot` |
| pm2 | `robinhood-nft-bot` | `arc-nft-bot` | `ink-nft-bot` |
| Telegram | RH bot | `@arcybot_bot` | `@porshmints_bot` |
| Chain | Robinhood 4663 | Arc 5042 | Ink 57073 (ETH gas) |
| Data | own `data/` | own `data/` | own `data/` |

## VPS install (paste as root)

Requires RH bot at `/root/telegram-bot` (token for `@porshmints_bot` is baked into the installer):

```bash
REMOTE=$(git -C /root/telegram-bot remote get-url origin)
git clone -b cursor/ink-telegram-bot-ad16 --single-branch "$REMOTE" /root/ink-telegram-bot
bash /root/ink-telegram-bot/scripts/install-on-vps.sh
```

Imports RH mint keys + tracked wallets, starts `ink-nft-bot`.

### Verify

```bash
node -e "const d=require('/root/ink-telegram-bot/data/mint-wallets.json'); console.log('Ink mint keys:', d.length)"
node -e "const s=require('/root/ink-telegram-bot/data/state.json'); console.log('Ink tracked:', s.trackedWallets.length)"
pm2 list
```

Telegram `@porshmints_bot`: `/start` → `/listkeys` → `/wallets`.

## Network

- Mainnet: `CHAIN=ink` · `https://rpc-gel.inkonchain.com` · chainId `57073`
- Testnet: `CHAIN=ink-sepolia` · `https://rpc-gel-sepolia.inkonchain.com` · chainId `763373`

Gas token is **ETH**.
