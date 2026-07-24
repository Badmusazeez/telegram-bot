import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  atr,
  detectEmaCrossover,
  ema,
  macd,
  rsi,
  sma,
} from "../src/analysis/indicators";
import { computeRiskLevels } from "../src/risk/levels";
import type { Candle } from "../src/types";

function makeCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 60_000,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000 + i * 10,
    closeTime: (i + 1) * 60_000 - 1,
    quoteVolume: (1000 + i * 10) * close,
  }));
}

describe("indicators", () => {
  it("computes SMA", () => {
    const values = [1, 2, 3, 4, 5];
    const out = sma(values, 3);
    assert.equal(out[2], 2);
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
  });

  it("computes EMA and detects bullish crossover", () => {
    // Flat then sharp rise so fast EMA crosses above slow
    const closes = [
      10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
      10, 10, 10, 12, 14, 16, 18, 20,
    ];
    const fast = ema(closes, 3);
    const slow = ema(closes, 8);
    let found: string | null = null;
    for (let i = 1; i < closes.length; i++) {
      const cross = detectEmaCrossover(fast, slow, i);
      if (cross) found = cross;
    }
    assert.equal(found, "BUY");
  });

  it("computes RSI in 0..100", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const series = rsi(closes, 14);
    const last = series[series.length - 1];
    assert.ok(last !== undefined);
    assert.ok(last > 50 && last <= 100);
  });

  it("computes MACD histogram", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 50 + Math.sin(i / 5) * 5 + i * 0.1);
    const { histogram } = macd(closes);
    const defined = histogram.filter((v) => v !== undefined);
    assert.ok(defined.length > 0);
  });

  it("computes ATR > 0", () => {
    const candles = makeCandles(
      Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 2)
    );
    const series = atr(candles, 14);
    const last = series[series.length - 1];
    assert.ok(last !== undefined && last > 0);
  });
});

describe("risk levels", () => {
  it("places SL below and TP above for BUY", () => {
    // computeRiskLevels uses config from env — set minimal env before import already happened.
    // Values depend on config defaults loaded via dotenv; we assert directional correctness.
    const levels = computeRiskLevels("BUY", 100, 2);
    assert.ok(levels.stopLoss < levels.entry);
    assert.ok(levels.takeProfit1 > levels.entry);
    assert.ok(levels.takeProfit2 > levels.takeProfit1);
    assert.ok(levels.riskReward1 > 0);
  });

  it("places SL above and TP below for SELL", () => {
    const levels = computeRiskLevels("SELL", 100, 2);
    assert.ok(levels.stopLoss > levels.entry);
    assert.ok(levels.takeProfit1 < levels.entry);
    assert.ok(levels.takeProfit2 < levels.takeProfit1);
  });
});
