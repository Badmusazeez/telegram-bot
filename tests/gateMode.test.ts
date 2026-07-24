import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("balanced gate preset wiring", () => {
  it("exports soft-gate fields from config under GATE_MODE=balanced", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "dummy";
    process.env.GATE_MODE = "balanced";
    delete process.env.MIN_CONFIDENCE;
    delete process.env.VOLUME_SPIKE_MULT;
    delete process.env.MIN_RISK_REWARD;
    delete process.env.REQUIRE_SMC_HARD;
    delete process.env.MAX_PAIRS;
    delete process.env.SCAN_INTERVAL_MS;
    delete process.env.SMC_MIN_SCORE;

    // Fresh import via dynamic path bust — use child eval of compiled values by re-reading module cache
    const id = require.resolve("../src/config");
    delete require.cache[id];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require("../src/config") as typeof import("../src/config");

    assert.equal(config.gateMode, "balanced");
    assert.equal(config.minConfidence, 75);
    assert.equal(config.volumeSpikeMult, 1.3);
    assert.equal(config.minRiskReward, 2.0);
    assert.equal(config.requireSmcHard, false);
    assert.equal(config.requirePaHard, true);
    assert.equal(config.smcMinScore, 0.3);
    assert.equal(config.maxPairs, 80);
    assert.equal(config.scanIntervalMs, 180_000);
  });
});
