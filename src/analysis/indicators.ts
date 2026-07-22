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

export function highest(values: number[], period: number, endIndex: number): number {
  let h = -Infinity;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    if (i >= 0 && values[i] > h) h = values[i];
  }
  return h;
}

export function lowest(values: number[], period: number, endIndex: number): number {
  let l = Infinity;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    if (i >= 0 && values[i] < l) l = values[i];
  }
  return l;
}

/** Wilder ADX(period). Returns adx, plusDI, minusDI sparse arrays. */
export function adx(
  candles: Candle[],
  period = 14
): { adx: number[]; plusDI: number[]; minusDI: number[] } {
  const adxOut: number[] = [];
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  if (candles.length < period * 2) return { adx: adxOut, plusDI, minusDI };

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      plusDM[i] = 0;
      minusDM[i] = 0;
      tr[i] = candles[i].high - candles[i].low;
      continue;
    }
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose)
    );
  }

  let atrW = 0;
  let plusW = 0;
  let minusW = 0;
  for (let i = 1; i <= period; i++) {
    atrW += tr[i];
    plusW += plusDM[i];
    minusW += minusDM[i];
  }

  const dx: number[] = [];
  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      atrW = atrW - atrW / period + tr[i];
      plusW = plusW - plusW / period + plusDM[i];
      minusW = minusW - minusW / period + minusDM[i];
    }
    const pdi = atrW === 0 ? 0 : (100 * plusW) / atrW;
    const mdi = atrW === 0 ? 0 : (100 * minusW) / atrW;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  }

  // First ADX = SMA of DX
  let adxPrev = 0;
  let count = 0;
  for (let i = period; i < candles.length; i++) {
    if (dx[i] === undefined) continue;
    if (count < period) {
      adxPrev += dx[i];
      count++;
      if (count === period) {
        adxPrev /= period;
        adxOut[i] = adxPrev;
      }
      continue;
    }
    adxPrev = (adxPrev * (period - 1) + dx[i]) / period;
    adxOut[i] = adxPrev;
  }
  return { adx: adxOut, plusDI, minusDI };
}

/** Stochastic RSI (0-100). */
export function stochRsi(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): { k: number[]; d: number[] } {
  const rsiSeries = rsi(closes, rsiPeriod);
  const stoch: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (rsiSeries[i] === undefined) continue;
    const window: number[] = [];
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (j >= 0 && rsiSeries[j] !== undefined) window.push(rsiSeries[j]);
    }
    if (window.length < stochPeriod) continue;
    const hi = Math.max(...window);
    const lo = Math.min(...window);
    stoch[i] = hi === lo ? 0 : ((rsiSeries[i] - lo) / (hi - lo)) * 100;
  }
  const k = smaSparse(stoch, kSmooth);
  const d = smaSparse(k, dSmooth);
  return { k, d };
}

function smaSparse(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] === undefined) continue;
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && n < period; j--) {
      if (values[j] === undefined) continue;
      sum += values[j];
      n++;
    }
    if (n === period) out[i] = sum / period;
  }
  return out;
}

export function obv(candles: Candle[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      out[i] = candles[i].volume;
      prev = candles[i].close;
      continue;
    }
    if (candles[i].close > prev) out[i] = out[i - 1] + candles[i].volume;
    else if (candles[i].close < prev) out[i] = out[i - 1] - candles[i].volume;
    else out[i] = out[i - 1];
    prev = candles[i].close;
  }
  return out;
}

/** Chaikin Money Flow over period. */
export function cmf(candles: Candle[], period = 20): number[] {
  const out: number[] = [];
  const mfv: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const hl = c.high - c.low;
    const mfm = hl === 0 ? 0 : ((c.close - c.low) - (c.high - c.close)) / hl;
    mfv[i] = mfm * c.volume;
  }
  for (let i = period - 1; i < candles.length; i++) {
    let sumMfv = 0;
    let sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumMfv += mfv[j];
      sumVol += candles[j].volume;
    }
    out[i] = sumVol === 0 ? 0 : sumMfv / sumVol;
  }
  return out;
}
