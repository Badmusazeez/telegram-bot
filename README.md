# Futures AI Trading Assistant (MEXC / Binance)

24/7 scanner for **USDT-M Futures** on **MEXC** (default) or **Binance**. It watches liquid perpetual pairs for **EMA crossovers**, requires **technical + fundamental confirmations**, then sends **BUY/SELL** alerts on Telegram with **entry, stop loss, and take-profit** levels.

**Alerts only** — this bot does **not** place orders.

## MEXC vs Binance

| | MEXC | Binance |
|---|---|---|
| Config | `EXCHANGE=mexc` | `EXCHANGE=binance` |
| Reachability | Often works where Binance is blocked | Many regions/cloud IPs get HTTP 451 |
| Symbols | `BTC_USDT` style | `BTCUSDT` style |
| OI history / L/S ratio | Funding yes; OI history & L/S limited | Full public data endpoints |

If Binance ping fails on your PC, use **MEXC**.

## What it does

1. Loads trading USDT-M perpetual pairs from the selected exchange
2. Filters by 24h quote volume (default ≥ $5M)
3. Detects **EMA fast/slow crossover** on the last *closed* candle
4. Confirms with technicals: **RSI**, **MACD histogram**, **volume spike**
5. Confirms with fundamentals: **funding rate** (+ OI / L/S when available)
6. Sizes **SL / TP1 / TP2** from **ATR** multiples
7. Sends a Telegram alert (with cooldown)

## Run on your computer

### Prerequisites

- Node.js **20+** from [nodejs.org](https://nodejs.org)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat id from [@userinfobot](https://t.me/userinfobot)

### Fastest path

```bash
npm run setup
npm run bot
```

If `npm run bot` fails on Windows with `'C:\\Program' is not recognized`, use:

```bash
npm run start:dev
```

### Switch to MEXC (recommended if Binance is blocked)

**Where:** VS Code → open `.env`

```env
EXCHANGE=mexc
```

Save, restart with `npm run start:dev`.

### Telegram commands

| Command | Action |
|---|---|
| `/start` | Register this chat for alerts |
| `/status` | Scanner stats |
| `/pause` | Pause scanning |
| `/resume` | Resume scanning |
| `/help` | Command list |

## Run on a VPS (24/7)

See **[`deploy/VPS.md`](deploy/VPS.md)**.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `EXCHANGE` | `mexc` | `mexc` or `binance` |
| `TIMEFRAME` | `15m` | MEXC supports 1m,5m,15m,30m,1h,4h,1d |
| `EMA_FAST` / `EMA_SLOW` | `9` / `21` | Crossover lengths |
| `MIN_QUOTE_VOLUME_USDT` | `5000000` | Min 24h quote volume |
| `MIN_TECHNICAL_SCORE` | `2` | Min technical confirmations |
| `MIN_FUNDAMENTAL_SCORE` | `1` | Min fundamental confirmations |
| `STOP_LOSS_ATR_MULT` | `1.5` | SL in ATRs |
| `TAKE_PROFIT_ATR_MULT` | `3` | TP1 in ATRs |
| `TAKE_PROFIT_2_ATR_MULT` | `5` | TP2 in ATRs |

## Disclaimer

Crypto futures are high risk. Not financial advice.
