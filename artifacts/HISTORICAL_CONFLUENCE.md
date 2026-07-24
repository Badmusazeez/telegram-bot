# Historical institutional confluence audit

## Question
When did this bot’s full institutional setup (trend + momentum + volume + price action + SMC + confidence ≥85% + structure RR) all pass at once on crypto charts?

## Method
- Script: `scripts/historical-confluence.ts` (`npm run audit:history`)
- Data: Binance Vision **spot** USDT klines (15m primary, 1h/4h/1d HTF)
  - Binance Futures API is geo-blocked (451) from this environment
  - MEXC retains only ~2000 15m bars (~21 days)
- Universe: 40 liquid USDT pairs, every closed 15m bar for **365 days** (2025-07-24 → 2026-07-24)
- Same analyzers as the live bot for chart factors
- Futures + fundamental scored **neutral 50%** (bar-accurate funding/OI/news cannot be fully replayed)

## Result (candid)
**Zero full passes.** No 15m bar on any of the 40 pairs met every hard gate in the last year.

| Stage | Bars rejected |
| --- | ---: |
| Volume prefilter (<~1.5×) | 964,914 |
| Trend | 248,869 |
| Momentum | 47,694 |
| Warmup | 8,034 |
| Price action | 3,700 |
| Volume (OBV/CMF after spike) | 2,879 |
| **SMC** | **171** |
| Confidence / RR / passed | **0** |

So the stack repeatedly got as far as **trend + momentum + volume + price action**, then **always died at SMC**. Nothing reached confidence/RR.

## Closest dates (failed SMC only)
These are the “warming up” moments — other gates were largely in place, SMC was not:

| UTC time | Pair | Core scores (T/M/V/PA/SMC) |
| --- | --- | --- |
| 2025-09-28T19:45Z | ZECUSDT | 100 / 83 / 90 / 100 / **45** |
| 2025-09-04T15:00Z | UNIUSDT | 90 / 83 / 90 / 100 / **50** |
| 2026-01-17T08:00Z | INJUSDT | 90 / 83 / 90 / 100 / **50** |
| 2026-01-16T06:15Z | BANKUSDT | 100 / 83 / 100 / 100 / 30 |
| 2026-02-24T06:45Z | BNBUSDT | 100 / 83 / 100 / 100 / 30 |
| 2026-06-03T19:15Z | XRPUSDT | 100 / 83 / 100 / 100 / 30 |
| 2026-06-04T01:00Z | SOLUSDT | 100 / 83 / 90 / 100 / 30 |
| 2026-04-13T22:00Z | BTCUSDT | 90 / 67 / 90 / 100 / 30 |
| 2026-07-03T10:30Z | ETHUSDT | 90 / 67 / 90 / 100 / 30 |

Full machine-readable dump: `artifacts/historical-confluence-report.json`

## Why SMC never cleared
Hard SMC alignment requires **all** of:
1. BOS or CHoCH with the trade side
2. Order block **or** FVG **or** liquidity sweep
3. Price in **discount** (BUY) or **premium** (SELL)

That third zone filter rarely coincides with a fresh breakout + 1.5× volume + MTF EMA stack on the same 15m close — which is why the live bot often stays at 0 alerts.

## Re-run
```bash
TELEGRAM_BOT_TOKEN=dummy LOOKBACK_DAYS=365 MAX_SYMBOLS=40 npm run audit:history
```
