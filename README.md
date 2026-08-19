# MEXC AI Trading Assistant

Institutional-quality **analysis and alert engine** for MEXC USDT-M Futures.

The system continuously monitors configured perpetual pairs, combines EMA trend, multi-timeframe market structure, Smart Money Concepts, order flow, open interest, funding, liquidity, volume, and volatility, then sends **BUY / SELL** alerts to Telegram only when confluence clears a high confidence threshold.

It does **not** place orders. Quality over quantity — the assistant stays idle when conditions are not favorable.

## Features

- Live MEXC Futures REST + WebSocket market data
- OKX cross-exchange validation (price, OI, funding, trend, liquidations)
- CoinMarketCap market metadata + news/security intelligence
- **ICT 2022 Model** (primary entry): HTF SSL/BSL sweep → LTF MSS → FVG at discount/premium
- Higher-timeframe bias: Daily / 4H / 1H
- Execution timing: 15m / 5m (1m optional for ICT LTF)
- EMA 20/50/100/200 alignment filters (never used alone)
- Market structure (HH/HL/LH/LL, BOS, CHoCH)
- SMC zones (order blocks, FVG, breakers, mitigation, premium/discount)
- Liquidity sweeps + liquidation heatmap approximation
- Order-flow delta / imbalance / absorption
- Open interest + funding modifiers
- ATR volatility filter and dynamic SL/TP (min RR 2.5, preferred 3.0)
- Weighted confidence 0–100 (minimum 66) with positive/negative factor explanations
- Confidence tiers: Standard (66–70), High-Quality (71–84), Elite (85–100)
- News-driven confidence penalty / temporary alert suppression
- Telegram alerts with institutional commentary
- Decision logging for accepted and rejected setups
- Health endpoint for VPS monitoring
- Docker / docker-compose deployment
- Plugin hooks for on-chain, whale, unlocks, calendar, dashboard, backtest modules

## Supported symbols

Default pairs (easy to extend in `config/settings.yaml`):

- BTC_USDT
- ETH_USDT
- SOL_USDT
- XRP_USDT
- BNB_USDT
- DOGE_USDT

## Architecture

```
src/mexc_assistant/
  exchange/       # MEXC REST + WebSocket adapters
  analysis/       # EMA, structure, SMC, liquidity, OF, OI, funding, vol
  signals/        # Confluence engine + confidence scoring
  risk/           # Stops, targets, daily/weekly loss gates
  commentary/     # Institutional alert narrative
  alerts/         # Telegram delivery + dedupe
  plugins/        # Future enhancement hooks
  core/           # Config, models, logging, health
  app.py          # 24/7 orchestrator
  main.py         # CLI entrypoint
```

Core scan loop:

1. Stream trades over WebSocket (REST fallback)
2. Pull multi-TF klines, ticker (includes `holdVol` OI), funding
3. Run analysis modules
4. Gate by risk limits + hard confluence filters
5. Score confidence; reject below 66
6. Format Telegram alert + append decision log

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .

cp .env.example .env
# set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

# single dry-run scan
python -m mexc_assistant.main --once --dry-run

# continuous 24/7 mode
python -m mexc_assistant.main
```

## Docker (VPS)

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:8080/health
docker compose logs -f
```

## Configuration

Primary config: `config/settings.yaml`

Environment overrides (`.env`):

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Destination chat/channel |
| `CMC_API_KEY` | Optional CoinMarketCap Pro key (public fallback used if empty) |
| `ACCOUNT_EQUITY` | Equity used for 1% risk sizing |
| `DRY_RUN` | `true` logs alerts without Telegram send |
| `LOG_LEVEL` | `INFO` / `DEBUG` |
| `CONFIG_PATH` | Alternate YAML path |

### Confidence weighting (sums to 100%)

| Factor | Weight |
|---|---|
| EMA Alignment | 12% |
| Higher-Timeframe Trend | 10% |
| Market Structure (BOS/CHoCH) | 10% |
| Smart Money Concepts | 10% |
| Liquidity Sweep | 8% |
| Order Flow | 12% |
| Open Interest | 8% |
| Funding Rate | 5% |
| Liquidation Heatmap | 8% |
| Volume | 7% |
| ATR / Volatility | 5% |
| Risk-to-Reward | 5% |

Cross-exchange conflicts and high-impact news apply additional penalties (or suppress alerts).

### Signal rules (summary)

- Never EMA-alone: require multi-category confluence (trend, EMA, structure, SMC, liquidity, order flow, OI/funding, liquidations, volume, volatility, cross-exchange, RR)
- At least **6** positive weighted categories and confidence ≥ **66**
- Reject flat/intertwined EMAs, low-volume breakouts, sharp OI decline, material MEXC/OKX conflicts
- High-impact hack/exploit/delist news can pause new alerts temporarily
- Risk: 1% equity / trade, max 3 positions, daily loss 3%, weekly loss 8%

## Telegram alert shape

```
🟢 BUY BTCUSDT

Confidence: 91%

Trend:
Bullish

Reason:
...

Entry:
...
Stop Loss:
...
Take Profit 1/2/3:
...
Risk-to-Reward:
3.4 : 1
```

## Logs & health

- App logs: `logs/app.log`
- Decision journal (accept/reject): `logs/decisions.jsonl`
- Health: `GET :8080/health`

## Tests

```bash
pip install -e ".[dev]"
pytest -q
```

## Future enhancements

Plugin registry is ready for:

- Whale wallet monitoring
- Token unlock tracking
- Economic calendar filters
- AI news sentiment
- Stablecoin flow / exchange reserve tracking
- Portfolio dashboard, backtesting, web UI, mobile push, trade journal

Enable stubs via `plugins.enabled` in YAML once implementations are added under `plugins/`.

## Disclaimer

This software provides market analysis alerts only. It is not financial advice and does not execute trades. Crypto derivatives are high risk — use at your own responsibility.
