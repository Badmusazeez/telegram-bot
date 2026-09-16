# eth-nft-copy-bot (@LarEth_Bot)

Ethereum mainnet NFT copy / snipe Telegram bot — **separate** from Robinhood, Arc, and Ink.

| | Robinhood | Arc | Ink | Ethereum |
|---|---|---|---|---|
| Path | `/root/telegram-bot` | `/root/arc-telegram-bot` | `/root/ink-telegram-bot` | `/root/eth-telegram-bot` |
| pm2 | `robinhood-nft-bot` | `arc-nft-bot` | `ink-nft-bot` | `eth-nft-bot` |
| Telegram | RH bot | `@arcybot_bot` | `@porshmints_bot` | `@LarEth_Bot` |
| Chain | Robinhood 4663 | Arc 5042 | Ink 57073 | Ethereum 1 |
| RPC | RH Alchemy/CS | public Arc | public Ink | ETH Alchemy |

## VPS install (paste as root)

Requires RH bot at `/root/telegram-bot` (imports all mint keys + tracked wallets):

```bash
REMOTE=$(git -C /root/telegram-bot remote get-url origin)
git clone -b cursor/eth-telegram-bot-ad16 --single-branch "$REMOTE" /root/eth-telegram-bot
bash /root/eth-telegram-bot/scripts/install-on-vps.sh
```

### Verify

```bash
node -e "const d=require('/root/eth-telegram-bot/data/mint-wallets.json'); console.log('ETH mint keys:', d.length)"
node -e "const s=require('/root/eth-telegram-bot/data/state.json'); console.log('ETH tracked:', s.trackedWallets.length)"
pm2 list
```

Telegram `@LarEth_Bot`: `/start` → `/listkeys` → `/wallets` → `/golive` for live MAX mint.

## Network

- Mainnet: `CHAIN=ethereum` · chainId `1`
- Track + mint: `https://eth-mainnet.g.alchemy.com/v2/…` (same Alchemy URL)
- Gas: **ETH**

Does **not** share data, pm2, or Telegram with the Robinhood bot.
