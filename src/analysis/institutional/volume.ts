import { cmf, obv, sma } from "../indicators";
import type { Side } from "../../types";
import type { FactorResult, MultiTfBundle } from "./types";
import { closed } from "./types";

/** Approximate volume profile POC from closes weighted by volume. */
function volumeProfileBias(
  candles: ReturnType<typeof closed>,
  bins = 24
): { poc: number; nearHvn: boolean; inLvn: boolean } {
  const prices = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  if (hi <= lo) return { poc: prices[prices.length - 1], nearHvn: false, inLvn: false };
  const step = (hi - lo) / bins;
  const bucket = new Array(bins).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((prices[i] - lo) / step)));
    bucket[idx] += vols[i];
  }
  let maxI = 0;
  let minI = 0;
  for (let i = 0; i < bins; i++) {
    if (bucket[i] > bucket[maxI]) maxI = i;
    if (bucket[i] < bucket[minI]) minI = i;
  }
  const poc = lo + (maxI + 0.5) * step;
  const price = prices[prices.length - 1];
  const nearHvn = Math.abs(price - poc) / price < 0.01;
  const priceBin = Math.min(bins - 1, Math.max(0, Math.floor((price - lo) / step)));
  const sorted = [...bucket].sort((a, b) => a - b);
  const lowThreshold = sorted[Math.floor(bins * 0.25)] ?? 0;
  const inLvn = bucket[priceBin] <= lowThreshold;
  return { poc, nearHvn, inLvn };
}

export function analyzeVolume(
  bundle: MultiTfBundle,
  preferredSide: Side | "NEUTRAL"
): FactorResult {
  const weight = 0.15;
  const reasons: string[] = [];
  const c = closed(bundle.primary);
  if (c.length < 40) {
    return {
      name: "volume",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["Insufficient volume history"],
      directionBias: "NEUTRAL",
    };
  }

  const vols = c.map((x) => x.volume);
  const i = c.length - 1;
  const volMa = sma(vols, 20);
  const avg = volMa[i];
  const spikeMult = avg && avg > 0 ? vols[i] / avg : 0;
  const spikeOk = spikeMult >= 1.5;

  const obvSeries = obv(c);
  const obvNow = obvSeries[i];
  const obvPrev = obvSeries[i - 10] ?? obvNow;
  const obvUp = obvNow > obvPrev;
  const obvDown = obvNow < obvPrev;

  const cmfSeries = cmf(c, 20);
  const cmfNow = cmfSeries[i] ?? 0;

  const vp = volumeProfileBias(c.slice(-80));

  reasons.push(
    `Volume ${spikeMult.toFixed(2)}× 20-SMA ${spikeOk ? "(≥1.5× OK)" : "(BELOW 1.5× — key miss)"}`
  );
  reasons.push(`OBV ${obvUp ? "rising" : obvDown ? "falling" : "flat"}`);
  reasons.push(`CMF(20)=${cmfNow.toFixed(3)}`);
  reasons.push(
    `Volume profile POC≈${vp.poc.toPrecision(6)}${vp.nearHvn ? " (near HVN)" : ""}${vp.inLvn ? " (in LVN — breakout prone)" : ""}`
  );

  let side: Side | "NEUTRAL" = "NEUTRAL";
  if (spikeOk && obvUp && cmfNow > 0) side = "BUY";
  if (spikeOk && obvDown && cmfNow < 0) side = "SELL";

  let score = 0;
  if (spikeOk) score += 0.45;
  if ((preferredSide === "BUY" && obvUp) || (preferredSide === "SELL" && obvDown))
    score += 0.25;
  if ((preferredSide === "BUY" && cmfNow > 0) || (preferredSide === "SELL" && cmfNow < 0))
    score += 0.2;
  if (vp.inLvn && spikeOk) score += 0.1;

  const aligned =
    spikeOk &&
    preferredSide !== "NEUTRAL" &&
    ((preferredSide === "BUY" && obvUp && cmfNow > 0) ||
      (preferredSide === "SELL" && obvDown && cmfNow < 0));

  return {
    name: "volume",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned,
    missingKey: !spikeOk || !aligned,
    reasons,
    directionBias: side,
  };
}
