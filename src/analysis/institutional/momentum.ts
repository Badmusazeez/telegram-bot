import { adx, detectEmaCrossover, ema, macd, rsi, stochRsi } from "../indicators";
import type { Side } from "../../types";
import type { FactorResult, MultiTfBundle } from "./types";
import { closed } from "./types";

export function analyzeMomentum(
  bundle: MultiTfBundle,
  preferredSide: Side | "NEUTRAL"
): FactorResult {
  const weight = 0.2;
  const reasons: string[] = [];
  const c = closed(bundle.primary);
  const closes = c.map((x) => x.close);
  if (closes.length < 60) {
    return {
      name: "momentum",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["Insufficient candles for momentum"],
      directionBias: "NEUTRAL",
    };
  }

  const i = closes.length - 1;
  const rsiSeries = rsi(closes, 14);
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 5];
  const { macd: macdLine, signal, histogram } = macd(closes);
  const { k, d } = stochRsi(closes);
  const { adx: adxSeries, plusDI, minusDI } = adx(c, 14);
  const adxNow = adxSeries[i];
  const fast = ema(closes, 9);
  const slow = ema(closes, 20);
  const cross = detectEmaCrossover(fast, slow, i);

  if (rsiNow === undefined || adxNow === undefined || histogram[i] === undefined) {
    return {
      name: "momentum",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["Momentum indicators incomplete"],
      directionBias: "NEUTRAL",
    };
  }

  // Simple divergence: price higher high vs RSI lower high (bearish) etc.
  let divergence: "bullish" | "bearish" | "none" = "none";
  if (rsiPrev !== undefined) {
    const priceUp = closes[i] > closes[i - 5];
    const rsiUp = rsiNow > rsiPrev;
    if (priceUp && !rsiUp) divergence = "bearish";
    if (!priceUp && rsiUp) divergence = "bullish";
  }

  const macdBull =
    histogram[i] > 0 &&
    (histogram[i - 1] === undefined || histogram[i] >= histogram[i - 1]) &&
    macdLine[i] !== undefined &&
    signal[i] !== undefined &&
    macdLine[i] >= signal[i];
  const macdBear =
    histogram[i] < 0 &&
    (histogram[i - 1] === undefined || histogram[i] <= histogram[i - 1]) &&
    macdLine[i] !== undefined &&
    signal[i] !== undefined &&
    macdLine[i] <= signal[i];

  const stochK = k[i];
  const stochD = d[i];
  const stochBull =
    stochK !== undefined &&
    stochD !== undefined &&
    stochK > stochD &&
    stochK > 20 &&
    stochK < 80;
  const stochBear =
    stochK !== undefined &&
    stochD !== undefined &&
    stochK < stochD &&
    stochK < 80 &&
    stochK > 20;

  const strongTrend = adxNow > 25;
  const diBull = (plusDI[i] ?? 0) > (minusDI[i] ?? 0);
  const diBear = (minusDI[i] ?? 0) > (plusDI[i] ?? 0);

  reasons.push(`RSI(14)=${rsiNow.toFixed(1)} (${divergence} divergence)`);
  reasons.push(
    `MACD hist ${histogram[i].toFixed(6)} · ${macdBull ? "bullish" : macdBear ? "bearish" : "flat"}`
  );
  reasons.push(
    `StochRSI K=${stochK?.toFixed(1) ?? "n/a"} D=${stochD?.toFixed(1) ?? "n/a"}`
  );
  reasons.push(
    `ADX(14)=${adxNow.toFixed(1)} ${strongTrend ? "(strong)" : "(weak <25)"}`
  );
  if (cross) reasons.push(`EMA9/20 crossover: ${cross}`);

  let side: Side | "NEUTRAL" = "NEUTRAL";
  const bullPts =
    (rsiNow >= 45 && rsiNow <= 70 ? 1 : 0) +
    (macdBull ? 1 : 0) +
    (stochBull ? 1 : 0) +
    (strongTrend && diBull ? 1 : 0) +
    (cross === "BUY" ? 1 : 0) +
    (divergence !== "bearish" ? 1 : 0);
  const bearPts =
    (rsiNow <= 55 && rsiNow >= 30 ? 1 : 0) +
    (macdBear ? 1 : 0) +
    (stochBear ? 1 : 0) +
    (strongTrend && diBear ? 1 : 0) +
    (cross === "SELL" ? 1 : 0) +
    (divergence !== "bullish" ? 1 : 0);

  if (bullPts >= bearPts && bullPts >= 4) side = "BUY";
  else if (bearPts > bullPts && bearPts >= 4) side = "SELL";

  if (preferredSide !== "NEUTRAL" && side !== "NEUTRAL" && side !== preferredSide) {
    reasons.push("Momentum conflicts with trend bias");
  }

  let score = Math.max(bullPts, bearPts) / 6;
  if (!strongTrend) {
    score *= 0.5;
    reasons.push("ADX≤25 — trend strength insufficient (key miss)");
  }

  const aligned =
    strongTrend &&
    side !== "NEUTRAL" &&
    (preferredSide === "NEUTRAL" || side === preferredSide) &&
    ((side === "BUY" && macdBull) || (side === "SELL" && macdBear));

  return {
    name: "momentum",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned,
    missingKey: !aligned,
    reasons,
    directionBias: side,
    metrics: {
      rsi: Number(rsiNow.toFixed(2)),
      adx: Number(adxNow.toFixed(2)),
      adxNeed: 25,
      macdHist: Number((histogram[i] ?? 0).toFixed(8)),
    },
  };
}
