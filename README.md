# Binance Futures AI Trading Assistant

24/7 scanner for **Binance USDT-M Futures**. It watches every liquid perpetual pair for **EMA crossovers**, requires **technical + fundamental confirmations**, then sends **BUY/SELL** alerts on Telegram with **entry, stop loss, and take-profit** levels.

**Alerts only** — this bot does **not** place orders on Binance.

## What it does

1. Loads all trading USDT-M perpetual pairs from Binance
2. Filters by 24h quote volume (default ≥ $5M) so you are not spammed by illiquid coins
3. On each scan, pulls candles for your timeframe (default `15m`)
4. Detects **EMA fast/slow crossover** on the last *closed* candle
5. Confirms with technicals: **RSI**, **MACD histogram**, **volume spike**
6. Confirms with fundamentals: **funding rate**, **open interest change**, **global long/short ratio**
7. Sizes **SL / TP1 / TP2** from **ATR** multiples
8. Sends a Telegram alert (with cooldown so the same pair does not spam)

## Run on your computer

### Prerequisites

- Node.js **20+** from [nodejs.org](https://nodejs.org)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat id from [@userinfobot](https://t.me/userinfobot)

### Fastest path

```bash
npm run setup      # interactive prompts → creates .env
npm run bot        # installs deps if needed, checks .env, starts scanner
```

Or:

```bash
chmod +x run.sh && ./run.sh   # macOS / Linux / WSL
.\run.cmd                     # Windows
```

Keep the terminal open. Stop with `Ctrl+C`.

### Manual

```bash
cp .env.example .env
# edit TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS
npm install
npm run check
npm run start:dev
```

### Telegram commands

| Command | Action |
|---|---|
| `/start` | Register this chat for alerts |
| `/status` | Scanner stats |
| `/pause` | Pause scanning |
| `/resume` | Resume scanning |
| `/help` | Command list |

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TIMEFRAME` | `15m` | Candle interval |
| `EMA_FAST` / `EMA_SLOW` | `9` / `21` | Crossover lengths |
| `SCAN_INTERVAL_MS` | `60000` | Seconds between full-market scans |
| `MIN_QUOTE_VOLUME_USDT` | `5000000` | Min 24h quote volume to include a pair |
| `MAX_PAIRS` | `0` | Cap pairs (`0` = all that pass filters) |
| `MIN_TECHNICAL_SCORE` | `2` | Min technical confirmations (crossover counts as 1) |
| `MIN_FUNDAMENTAL_SCORE` | `1` | Min fundamental confirmations |
| `STOP_LOSS_ATR_MULT` | `1.5` | SL distance in ATRs |
| `TAKE_PROFIT_ATR_MULT` | `3` | TP1 distance in ATRs |
| `TAKE_PROFIT_2_ATR_MULT` | `5` | TP2 distance in ATRs |
| `SIGNAL_COOLDOWN_MS` | `3600000` | Same symbol+side cooldown |
| `DRY_RUN` | `false` | Log alerts instead of sending |
| `SYMBOL_WHITELIST` | empty | Optional comma list e.g. `BTCUSDT,ETHUSDT` |
| `SYMBOL_BLACKLIST` | empty | Optional symbols to skip |

Binance **market data is public** — API keys are optional.

> **Region note:** Binance may return HTTP 451 from some countries/cloud IPs. Run the bot on your own computer or a VPS/VPN that can open `https://fapi.binance.com`. Override with `BINANCE_FUTURES_BASE_URL` if you use a reachable Futures endpoint.

## Project layout

```
src/
  binance/client.ts      # Futures REST (pairs, klines, funding, OI, L/S)
  analysis/indicators.ts # EMA, RSI, MACD, ATR
  analysis/technical.ts  # Crossover + confirmations
  analysis/fundamental.ts# Funding / OI / long-short
  analysis/signalEngine.ts
  risk/levels.ts         # TP / SL from ATR
  scanner/scanner.ts     # 24/7 scan loop
  telegram/              # Alerts + commands
  index.ts
```

## Tests

```bash
npm test
npm run typecheck
```

## Disclaimer

Crypto futures are high risk. Signals can be wrong. This software is for education and personal alerting — **not financial advice**. You are solely responsible for any trades you take.
