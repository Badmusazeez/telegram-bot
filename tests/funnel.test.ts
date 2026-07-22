import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bumpReject,
  emptyFunnel,
  finalizeFunnel,
  formatFunnelLog,
} from "../src/analysis/funnel";

describe("scan funnel", () => {
  it("tracks top reject stage", () => {
    const funnel = emptyFunnel();
    funnel.scanned = 40;
    for (let i = 0; i < 22; i++) bumpReject(funnel, "volume");
    for (let i = 0; i < 10; i++) bumpReject(funnel, "trend");
    finalizeFunnel(funnel);
    funnel.nearMisses = [
      "BTC_USDT rejected: Trend ✓, Momentum ✓, Volume ✗ · Volume = 1.34x (needs 1.50x)",
      "SOL_USDT rejected: Trend ✓, Momentum ✓, Volume ✓, PA ✓, SMC ✓ · Confidence = 82% (needs 85%)",
    ];
    assert.equal(funnel.topRejectStage, "volume");
    assert.equal(funnel.topRejectCount, 22);
    const text = formatFunnelLog(funnel);
    assert.match(text, /Top reject: volume \(22 pairs\)/);
    assert.match(text, /Scanned: 40/);
    assert.match(text, /Closest rejects:/);
    assert.match(text, /1\.34x/);
    assert.match(text, /82%/);
  });
});
