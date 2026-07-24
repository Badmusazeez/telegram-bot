import { config } from "../config";
import type { Candle, Side } from "../types";
import { ema } from "./indicators";

/**
 * Higher-timeframe trend: fast EMA vs slow EMA on closed candles.
 * BUY needs fast > slow and price above slow; SELL the opposite.
 */
export function checkTrendAlignment(
  candles: Candle[],
  side: Side
): { ok: boolean; reason: string; emaFast: number; emaSlow: number } {
  if (candles.length < config.emaSlow + 5) {
    return {
      ok: false,
      reason: "Trend timeframe has insufficient candles",
      emaFast: 0,
      emaSlow: 0,
    };
  }

  const closed = candles.slice(0, -1);
  const closes = closed.map((c) => c.close);
  const fastSeries = ema(closes, config.emaFast);
  const slowSeries = ema(closes, config.emaSlow);
  const i = closes.length - 1;
  const emaFast = fastSeries[i];
  const emaSlow = slowSeries[i];
  const price = closes[i];

  if (emaFast === undefined || emaSlow === undefined) {
    return {
      ok: false,
      reason: "Trend EMAs unavailable",
      emaFast: 0,
      emaSlow: 0,
    };
  }

  const bullish = emaFast > emaSlow && price >= emaSlow;
  const bearish = emaFast < emaSlow && price <= emaSlow;
  const ok = side === "BUY" ? bullish : bearish;

  return {
    ok,
    emaFast,
    emaSlow,
    reason: ok
      ? `${config.trendTimeframe} trend aligned (${side === "BUY" ? "bullish" : "bearish"})`
      : `${config.trendTimeframe} trend against ${side} (EMA ${emaFast.toPrecision(6)}/${emaSlow.toPrecision(6)})`,
  };
}

/** Skip dead or insane volatility relative to price. */
export function atrPctOk(
  atrValue: number,
  price: number
): { ok: boolean; atrPct: number; reason?: string } {
  if (price <= 0) return { ok: false, atrPct: 0, reason: "Invalid price" };
  const atrPct = (atrValue / price) * 100;
  if (atrPct < config.minAtrPct) {
    return {
      ok: false,
      atrPct,
      reason: `ATR ${atrPct.toFixed(2)}% too low (dead market)`,
    };
  }
  if (atrPct > config.maxAtrPct) {
    return {
      ok: false,
      atrPct,
      reason: `ATR ${atrPct.toFixed(2)}% too high (chaotic move)`,
    };
  }
  return { ok: true, atrPct };
}

export function qualityLabel(confidence: number): "HIGH" | "MED" | "LOW" {
  if (confidence >= 92) return "HIGH";
  if (confidence >= config.minConfidence) return "MED";
  return "LOW";
}
