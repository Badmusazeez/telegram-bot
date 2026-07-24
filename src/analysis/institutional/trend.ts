import { ema } from "../indicators";
import type { Candle, Side } from "../../types";
import type { FactorResult, MultiTfBundle } from "./types";
import { closed, lastClose } from "./types";

function structureBias(candles: Candle[]): Side | "NEUTRAL" {
  const c = closed(candles);
  if (c.length < 30) return "NEUTRAL";
  const swing = 5;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = swing; i < c.length - swing; i++) {
    const h = c[i].high;
    const l = c[i].low;
    let isH = true;
    let isL = true;
    for (let j = i - swing; j <= i + swing; j++) {
      if (j === i) continue;
      if (c[j].high >= h) isH = false;
      if (c[j].low <= l) isL = false;
    }
    if (isH) highs.push(h);
    if (isL) lows.push(l);
  }
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  const hh = highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows[lows.length - 1] > lows[lows.length - 2];
  const lh = highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows[lows.length - 1] < lows[lows.length - 2];
  if (hh && hl) return "BUY";
  if (lh && ll) return "SELL";
  return "NEUTRAL";
}

function tfEmaBias(candles: Candle[]): Side | "NEUTRAL" {
  const c = closed(candles);
  const closes = c.map((x) => x.close);
  if (closes.length < 60) return "NEUTRAL";
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const i = closes.length - 1;
  if (e20[i] === undefined || e50[i] === undefined) return "NEUTRAL";
  if (closes[i] > e20[i] && e20[i] > e50[i]) return "BUY";
  if (closes[i] < e20[i] && e20[i] < e50[i]) return "SELL";
  return "NEUTRAL";
}

export function analyzeTrend(bundle: MultiTfBundle): FactorResult {
  const reasons: string[] = [];
  const c = closed(bundle.primary);
  const closes = c.map((x) => x.close);
  const weight = 0.25;

  if (closes.length < 220) {
    return {
      name: "trend",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["Insufficient history for EMA 9/20/50/100/200"],
      directionBias: "NEUTRAL",
    };
  }

  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e100 = ema(closes, 100);
  const e200 = ema(closes, 200);
  const i = closes.length - 1;
  const price = closes[i];
  const vals = [e9[i], e20[i], e50[i], e100[i], e200[i]];
  if (vals.some((v) => v === undefined)) {
    return {
      name: "trend",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["EMA stack incomplete"],
      directionBias: "NEUTRAL",
    };
  }

  const [v9, v20, v50, v100, v200] = vals as number[];
  const bullStack = v9 > v20 && v20 > v50 && v50 > v100 && v100 > v200;
  const bearStack = v9 < v20 && v20 < v50 && v50 < v100 && v100 < v200;
  const above200 = price > v200;
  const below200 = price < v200;

  const h1 = tfEmaBias(bundle.h1);
  const h4 = tfEmaBias(bundle.h4);
  const d1 = tfEmaBias(bundle.d1);
  const struct = structureBias(bundle.primary);

  reasons.push(
    `EMA stack ${bullStack ? "bullish" : bearStack ? "bearish" : "mixed"} (9/20/50/100/200)`
  );
  reasons.push(
    `Price ${above200 ? "above" : below200 ? "below" : "at"} EMA200 (${v200.toPrecision(6)})`
  );
  reasons.push(`MTF: 1H=${h1} 4H=${h4} D=${d1}`);
  reasons.push(
    `Structure: ${struct === "BUY" ? "HH/HL" : struct === "SELL" ? "LH/LL" : "mixed/range"}`
  );

  let side: Side | "NEUTRAL" = "NEUTRAL";
  if (bullStack && above200) side = "BUY";
  else if (bearStack && below200) side = "SELL";

  // Conflicting HTF = hard fail later
  const htfConflict =
    (side === "BUY" && (h4 === "SELL" || d1 === "SELL")) ||
    (side === "SELL" && (h4 === "BUY" || d1 === "BUY"));

  let score = 0;
  if (bullStack || bearStack) score += 0.35;
  if ((side === "BUY" && above200) || (side === "SELL" && below200)) score += 0.2;
  const mtfAgreeCount =
    side === "NEUTRAL" ? 0 : [h1, h4, d1].filter((b) => b === side).length;
  score += (mtfAgreeCount / 3) * 0.3;
  if (struct === side) score += 0.15;
  if (htfConflict) {
    score = Math.min(score, 0.25);
    reasons.push("CONFLICT: higher-timeframe trend opposes setup");
  }

  const aligned =
    side !== "NEUTRAL" &&
    !htfConflict &&
    mtfAgreeCount >= 2 &&
    (bullStack || bearStack) &&
    struct !== "NEUTRAL";

  return {
    name: "trend",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned,
    missingKey: !aligned,
    reasons,
    directionBias: side,
  };
}

export function summarizeHtf(bundle: MultiTfBundle): string {
  return `1H ${tfEmaBias(bundle.h1)} · 4H ${tfEmaBias(bundle.h4)} · D ${tfEmaBias(bundle.d1)} · price ${lastClose(bundle.primary)}`;
}
