import type { Side } from "../../types";
import type { FactorResult, MultiTfBundle } from "./types";
import { closed } from "./types";

function swings(c: ReturnType<typeof closed>, left = 3, right = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = left; i < c.length - right; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isH = false;
      if (c[j].low <= c[i].low) isL = false;
    }
    if (isH) highs.push(c[i].high);
    if (isL) lows.push(c[i].low);
  }
  return { highs, lows };
}

export function analyzeSmc(
  bundle: MultiTfBundle,
  preferredSide: Side | "NEUTRAL"
): FactorResult {
  const weight = 0.15;
  const reasons: string[] = [];
  const c = closed(bundle.primary);
  if (c.length < 50) {
    return {
      name: "smc",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["Insufficient data for SMC"],
      directionBias: "NEUTRAL",
    };
  }

  const { highs, lows } = swings(c);
  const price = c[c.length - 1].close;
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];

  const bosBull = lastHigh !== undefined && prevHigh !== undefined && lastHigh > prevHigh;
  const bosBear = lastLow !== undefined && prevLow !== undefined && lastLow < prevLow;

  const chochBull =
    prevLow !== undefined &&
    lastLow !== undefined &&
    prevHigh !== undefined &&
    lastLow > prevLow &&
    price > prevHigh;
  const chochBear =
    prevHigh !== undefined &&
    lastHigh !== undefined &&
    prevLow !== undefined &&
    lastHigh < prevHigh &&
    price < prevLow;

  let orderBlockOk = false;
  for (let i = c.length - 3; i >= Math.max(0, c.length - 25); i--) {
    const candle = c[i];
    const next = c[i + 1];
    if (
      preferredSide === "BUY" &&
      candle.close < candle.open &&
      next.close > next.open &&
      price >= candle.low &&
      price <= candle.high
    ) {
      orderBlockOk = true;
      reasons.push(
        `Bullish order block ${candle.low.toPrecision(6)}-${candle.high.toPrecision(6)}`
      );
      break;
    }
    if (
      preferredSide === "SELL" &&
      candle.close > candle.open &&
      next.close < next.open &&
      price >= candle.low &&
      price <= candle.high
    ) {
      orderBlockOk = true;
      reasons.push(
        `Bearish order block ${candle.low.toPrecision(6)}-${candle.high.toPrecision(6)}`
      );
      break;
    }
  }

  let fvgOk = false;
  for (let i = c.length - 2; i >= Math.max(2, c.length - 20); i--) {
    const a = c[i - 2];
    const b = c[i];
    if (a.high < b.low && preferredSide === "BUY" && price >= a.high && price <= b.low) {
      fvgOk = true;
      reasons.push(`Bullish FVG ${a.high.toPrecision(6)}-${b.low.toPrecision(6)}`);
      break;
    }
    if (a.low > b.high && preferredSide === "SELL" && price <= a.low && price >= b.high) {
      fvgOk = true;
      reasons.push(`Bearish FVG ${b.high.toPrecision(6)}-${a.low.toPrecision(6)}`);
      break;
    }
  }

  const cur = c[c.length - 1];
  const sweepBull = lastLow !== undefined && cur.low < lastLow && cur.close > lastLow;
  const sweepBear = lastHigh !== undefined && cur.high > lastHigh && cur.close < lastHigh;

  const window = c.slice(-50);
  const hi = Math.max(...window.map((x) => x.high));
  const lo = Math.min(...window.map((x) => x.low));
  const mid = (hi + lo) / 2;
  const discount = price < mid;
  const premium = price > mid;

  reasons.push(
    `BOS ${bosBull ? "bullish" : bosBear ? "bearish" : "none"} · CHoCH ${chochBull ? "bullish" : chochBear ? "bearish" : "none"}`
  );
  if (sweepBull) reasons.push("Liquidity sweep of lows");
  if (sweepBear) reasons.push("Liquidity sweep of highs");
  reasons.push(discount ? "Discount zone" : premium ? "Premium zone" : "Equilibrium");

  let score = 0;
  if (
    (preferredSide === "BUY" && (bosBull || chochBull)) ||
    (preferredSide === "SELL" && (bosBear || chochBear))
  ) {
    score += 0.3;
  }
  if (orderBlockOk) score += 0.2;
  if (fvgOk) score += 0.2;
  if (
    (preferredSide === "BUY" && sweepBull) ||
    (preferredSide === "SELL" && sweepBear)
  ) {
    score += 0.15;
  }
  if (
    (preferredSide === "BUY" && discount) ||
    (preferredSide === "SELL" && premium)
  ) {
    score += 0.15;
  }

  const aligned =
    preferredSide !== "NEUTRAL" &&
    ((preferredSide === "BUY" &&
      (bosBull || chochBull) &&
      (orderBlockOk || fvgOk || sweepBull) &&
      discount) ||
      (preferredSide === "SELL" &&
        (bosBear || chochBear) &&
        (orderBlockOk || fvgOk || sweepBear) &&
        premium));

  return {
    name: "smc",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned,
    missingKey: !aligned,
    reasons,
    directionBias: preferredSide,
  };
}
