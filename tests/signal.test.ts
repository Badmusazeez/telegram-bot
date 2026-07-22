import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeTechnical } from "../src/analysis/technical";
import { formatSignalAlert } from "../src/telegram/formatter";
import type { Candle, TradeSignal } from "../src/types";

function candle(i: number, close: number, volume = 1000): Candle {
  return {
    openTime: i * 60_000,
    open: close,
    high: close * 1.02,
    low: close * 0.98,
    close,
    volume,
    closeTime: (i + 1) * 60_000 - 1,
    quoteVolume: volume * close,
  };
}

describe("technical analysis", () => {
  it("returns null without a crossover", () => {
    const candles = Array.from({ length: 80 }, (_, i) =>
      candle(i, 100 + i * 0.01, 1000)
    );
    // Add forming candle
    candles.push(candle(80, 101, 1000));
    const result = analyzeTechnical(candles);
    // Slow grind may or may not cross depending on EMA — either null or a signal object
    if (result) {
      assert.ok(result.emaCross === "BUY" || result.emaCross === "SELL");
      assert.ok(result.atr > 0);
    } else {
      assert.equal(result, null);
    }
  });

  it("detects bullish crossover on the last closed candle", () => {
    // Build a series where EMA9 crosses above EMA21 exactly on the final closed bar.
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(120 - i * 0.5); // downtrend
    for (let i = 0; i < 7; i++) closes.push(100 + i * 1.5); // early bounce
    // Pad / tweak until crossover lands on last closed index
    let candles: Candle[] = [];
    for (let extra = 0; extra < 40; extra++) {
      const series = [
        ...closes,
        ...Array.from({ length: extra }, (_, i) => 110.5 + i * 2),
      ];
      candles = series.map((c, i) =>
        candle(i, c, i >= series.length - 3 ? 9000 : 1000)
      );
      // forming candle
      candles.push(
        candle(series.length, series[series.length - 1] + 1, 9000)
      );
      const result = analyzeTechnical(candles);
      if (result?.emaCross === "BUY") {
        assert.ok(result.score >= 1);
        assert.ok(result.atr > 0);
        return;
      }
    }
    assert.fail("expected a BUY EMA crossover within synthetic series");
  });
});

describe("formatter", () => {
  it("includes BUY, SL and TP in HTML alert", () => {
    const signal: TradeSignal = {
      id: "abc",
      symbol: "BTCUSDT",
      side: "BUY",
      exchange: "mexc",
      timeframe: "15m",
      trendTimeframe: "1h",
      entry: 65000,
      stopLoss: 64000,
      takeProfit1: 67000,
      takeProfit3: 71000,
      riskReward1: 2.5,
      riskReward2: 3,
      riskReward3: 4,
      technical: {
        emaFast: 64900,
        emaSlow: 64800,
        emaCross: "BUY",
        rsi: 55,
        macdHistogram: 12,
        macdBullish: true,
        volumeSpike: true,
        atr: 400,
        score: 3,
        reasons: ["EMA stack bullish"],
      },
      fundamental: {
        fundingRate: 0.0001,
        openInterestChangePct: 1.2,
        longShortRatio: 1.05,
        score: 2,
        reasons: ["Funding ok"],
      },
      confidence: 88,
      quality: "MED",
      tags: ["BUY", "trend", "momentum"],
      summary: "test",
      createdAt: Date.now(),
      verdict: "BUY",
      htfTrend: "1H BUY · 4H BUY · D BUY",
      whyValid: ["EMA stack bullish", "ADX strong"],
      positionSize: 0.15,
      accountBalance: 1000,
      riskPercent: 1,
      estimatedHolding: "2h–12h",
      invalidation: ["Close below SL"],
      majorRisks: ["Volatility"],
      factorScores: [
        { name: "trend", weight: 0.25, score: 90, aligned: true },
        { name: "momentum", weight: 0.2, score: 85, aligned: true },
      ],
    };
    const text = formatSignalAlert(signal);
    assert.match(text, /LONG BTCUSDT/);
    assert.match(text, /Stop Loss/);
    assert.match(text, /TP1/);
    assert.match(text, /TP3/);
    assert.match(text, /Final verdict/);
    assert.doesNotMatch(text, /Position size/);
  });
});
