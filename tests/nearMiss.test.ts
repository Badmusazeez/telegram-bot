import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNearMissLine } from "../src/analysis/institutional/engine";
import type { FactorResult } from "../src/analysis/institutional/types";

function factor(
  name: FactorResult["name"],
  score: number,
  aligned: boolean,
  reasons: string[] = [],
  metrics?: Record<string, number>
): FactorResult {
  return {
    name,
    weight: 0.15,
    score,
    aligned,
    missingKey: !aligned,
    reasons,
    directionBias: "BUY",
    metrics,
  };
}

describe("near-miss scorecard", () => {
  it("shows per-stage percentages and reject reasons", () => {
    const factors: FactorResult[] = [
      factor("trend", 1, true, ["EMA stack bullish"]),
      factor(
        "momentum",
        0.82,
        false,
        ["MACD not confirming bias", "ADX≤25 — trend strength insufficient (key miss)"],
        { adx: 22.4, rsi: 54 }
      ),
      factor(
        "volume",
        0.74,
        false,
        ["Volume 1.34× 20-SMA (needs 1.50×)"],
        { volumeMult: 1.34, volumeNeed: 1.5 }
      ),
      factor("priceAction", 0.91, true, ["Breakout held"]),
      factor("smc", 0.88, true, ["BOS confirmed"]),
    ];

    const { line, distance } = buildNearMissLine(
      "HBAR_USDT",
      "volume",
      factors,
      81
    );

    assert.match(line, /^HBAR_USDT/);
    assert.match(line, /Trend \.+ 100%/);
    assert.match(line, /Momentum \.+ 82%/);
    assert.match(line, /Volume \.+ 74%/);
    assert.match(line, /Price Action \.+ 91%/);
    assert.match(line, /SMC \.+ 88%/);
    assert.match(line, /Overall Confidence: 81%/);
    assert.match(line, /Reason rejected:/);
    assert.match(line, /\* Volume below 1\.50× \(now 1\.34×\)/);
    assert.ok(distance < 20, "near volume miss should rank close");
  });

  it("ranks higher overall confidence as closer", () => {
    const base = [
      factor("trend", 0.9, true),
      factor("momentum", 0.85, true),
      factor("volume", 0.8, true),
      factor("priceAction", 0.8, true),
      factor("smc", 0.8, true),
    ];
    const near = buildNearMissLine("A_USDT", "confidence", base, 84);
    const far = buildNearMissLine(
      "B_USDT",
      "trend",
      [
        factor("trend", 0.2, false, ["HTF not aligned"]),
        factor("momentum", 0.3, false),
        factor("volume", 0.2, false),
        factor("priceAction", 0.2, false),
        factor("smc", 0.2, false),
      ],
      35
    );
    assert.ok(near.distance < far.distance);
  });
});
