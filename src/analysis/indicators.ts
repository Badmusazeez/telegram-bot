import type { Candle } from "../types";

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function rsi(closes: number[], period: number): number[] {
  const out: number[] = [];
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] !== undefined && slowEma[i] !== undefined) {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  const macdValues = macdLine.filter((v) => v !== undefined) as number[];
  const signalSparse = ema(macdValues, signalPeriod);

  // Map signal back onto full index space
  const signal: number[] = [];
  const histogram: number[] = [];
  let signalIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] === undefined) continue;
    const s = signalSparse[signalIdx];
    if (s !== undefined) {
      signal[i] = s;
      histogram[i] = macdLine[i] - s;
    }
    signalIdx++;
  }

  return { macd: macdLine, signal, histogram };
}

export function atr(candles: Candle[], period: number): number[] {
  const out: number[] = [];
  if (candles.length <= period) return out;

  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs[i] = candles[i].high - candles[i].low;
      continue;
    }
    const prevClose = candles[i - 1].close;
    trs[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  out[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

/** Detect EMA crossover on the last *closed* candle (index -2 vs -3). */
export function detectEmaCrossover(
  fast: number[],
  slow: number[],
  closedIndex: number
): "BUY" | "SELL" | null {
  const i = closedIndex;
  const prev = i - 1;
  if (
    fast[i] === undefined ||
    slow[i] === undefined ||
    fast[prev] === undefined ||
    slow[prev] === undefined
  ) {
    return null;
  }
  const wasBelow = fast[prev] <= slow[prev];
  const nowAbove = fast[i] > slow[i];
  const wasAbove = fast[prev] >= slow[prev];
  const nowBelow = fast[i] < slow[i];
  if (wasBelow && nowAbove) return "BUY";
  if (wasAbove && nowBelow) return "SELL";
  return null;
}

export function lastDefined(values: number[]): number | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined && Number.isFinite(values[i])) {
      return values[i];
    }
  }
  return undefined;
}
