import type { Candle, Side } from "../../types";
import type { FactorResult, MultiTfBundle } from "./types";
import { closed } from "./types";

function isBullEngulf(prev: Candle, cur: Candle): boolean {
  return (
    prev.close < prev.open &&
    cur.close > cur.open &&
    cur.open <= prev.close &&
    cur.close >= prev.open
  );
}

function isBearEngulf(prev: Candle, cur: Candle): boolean {
  return (
    prev.close > prev.open &&
    cur.close < cur.open &&
    cur.open >= prev.close &&
    cur.close <= prev.open
  );
}

function isPinBar(c: Candle, bullish: boolean): boolean {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range <= 0) return false;
  const upper = c.high - Math.max(c.close, c.open);
  const lower = Math.min(c.close, c.open) - c.low;
  if (bullish) return lower >= body * 2 && lower >= range * 0.6 && upper <= body;
  return upper >= body * 2 && upper >= range * 0.6 && lower <= body;
}

function isInsideBar(prev: Candle, cur: Candle): boolean {
  return cur.high <= prev.high && cur.low >= prev.low;
}

function recentSwingLevels(c: Candle[], lookback = 40): { support: number; resistance: number } {
  const slice = c.slice(-lookback);
  return {
    support: Math.min(...slice.map((x) => x.low)),
    resistance: Math.max(...slice.map((x) => x.high)),
  };
}

function isChoppy(c: Candle[]): boolean {
  const slice = c.slice(-20);
  const range =
    Math.max(...slice.map((x) => x.high)) - Math.min(...slice.map((x) => x.low));
  const avgBody =
    slice.reduce((a, x) => a + Math.abs(x.close - x.open), 0) / slice.length;
  const mid = slice[0].close;
  return mid > 0 && range / mid < 0.02 && avgBody / mid < 0.003;
}

export function analyzePriceAction(
  bundle: MultiTfBundle,
  preferredSide: Side | "NEUTRAL"
): FactorResult {
  const weight = 0.15;
  const reasons: string[] = [];
  const c = closed(bundle.primary);
  if (c.length < 30) {
    return {
      name: "priceAction",
      weight,
      score: 0,
      aligned: false,
      missingKey: true,
      reasons: ["Insufficient candles for price action"],
      directionBias: "NEUTRAL",
    };
  }

  const cur = c[c.length - 1];
  const prev = c[c.length - 2];
  const prev2 = c[c.length - 3];
  const levels = recentSwingLevels(c);
  const choppy = isChoppy(c);

  const brokeRes = cur.close > levels.resistance * 0.998 && cur.close > prev.close;
  const brokeSup = cur.close < levels.support * 1.002 && cur.close < prev.close;

  // Retest: prior bar broke, current revisits level and holds
  const retestLong =
    prev.high >= levels.resistance &&
    cur.low <= levels.resistance &&
    cur.close > levels.resistance;
  const retestShort =
    prev.low <= levels.support &&
    cur.high >= levels.support &&
    cur.close < levels.support;

  const bullCandle =
    isBullEngulf(prev, cur) ||
    isPinBar(cur, true) ||
    (prev2.close < prev2.open &&
      Math.abs(prev.close - prev.open) < (prev.high - prev.low) * 0.3 &&
      cur.close > cur.open &&
      cur.close > prev2.open); // rough morning star

  const bearCandle =
    isBearEngulf(prev, cur) ||
    isPinBar(cur, false) ||
    (prev2.close > prev2.open &&
      Math.abs(prev.close - prev.open) < (prev.high - prev.low) * 0.3 &&
      cur.close < cur.open &&
      cur.close < prev2.open);

  const insideBreak =
    isInsideBar(prev2, prev) &&
    ((cur.close > prev2.high && preferredSide === "BUY") ||
      (cur.close < prev2.low && preferredSide === "SELL"));

  reasons.push(
    choppy
      ? "Market looks consolidating/choppy — avoid (key miss)"
      : "Not in tight consolidation"
  );
  reasons.push(
    `S/R window: support ${levels.support.toPrecision(6)} / resistance ${levels.resistance.toPrecision(6)}`
  );
  if (brokeRes || retestLong) reasons.push("Breakout/retest of resistance");
  if (brokeSup || retestShort) reasons.push("Breakdown/retest of support");
  if (bullCandle) reasons.push("Bullish candlestick confirmation");
  if (bearCandle) reasons.push("Bearish candlestick confirmation");
  if (insideBreak) reasons.push("Inside-bar breakout");

  let score = 0;
  if (!choppy) score += 0.25;
  if (
    (preferredSide === "BUY" && (brokeRes || retestLong)) ||
    (preferredSide === "SELL" && (brokeSup || retestShort))
  ) {
    score += 0.35;
  }
  if (
    (preferredSide === "BUY" && (bullCandle || insideBreak)) ||
    (preferredSide === "SELL" && (bearCandle || insideBreak))
  ) {
    score += 0.4;
  }

  const aligned =
    !choppy &&
    preferredSide !== "NEUTRAL" &&
    ((preferredSide === "BUY" &&
      (brokeRes || retestLong) &&
      (bullCandle || insideBreak)) ||
      (preferredSide === "SELL" &&
        (brokeSup || retestShort) &&
        (bearCandle || insideBreak)));

  return {
    name: "priceAction",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned,
    missingKey: !aligned,
    reasons,
    directionBias: preferredSide,
  };
}

export function structureStop(
  candles: Candle[],
  side: Side,
  entry: number,
  atr: number
): number {
  const c = closed(candles);
  const slice = c.slice(-20);
  if (side === "BUY") {
    const swingLow = Math.min(...slice.map((x) => x.low));
    return Math.min(swingLow, entry - atr * 1.2);
  }
  const swingHigh = Math.max(...slice.map((x) => x.high));
  return Math.max(swingHigh, entry + atr * 1.2);
}
