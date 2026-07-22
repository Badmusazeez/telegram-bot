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
      [
        "BTC_USDT",
        "Trend ............ 100%",
        "Momentum ......... 90%",
        "Volume ........... 74%",
        "Price Action ..... 88%",
        "SMC .............. 85%",
        "Overall Confidence: 83%",
        "Reason rejected:",
        "* Volume below 1.50× (now 1.34×)",
      ].join("\n"),
      [
        "SOL_USDT",
        "Trend ............ 100%",
        "Momentum ......... 92%",
        "Volume ........... 88%",
        "Price Action ..... 90%",
        "SMC .............. 86%",
        "Overall Confidence: 82%",
        "Reason rejected:",
        "* Overall confidence 82% < 85%",
      ].join("\n"),
    ];
    assert.equal(funnel.topRejectStage, "volume");
    assert.equal(funnel.topRejectCount, 22);
    const text = formatFunnelLog(funnel);
    assert.match(text, /Top reject: volume \(22 pairs\)/);
    assert.match(text, /Scanned: 40/);
    assert.match(text, /Closest rejects \(warming up\):/);
    assert.match(text, /Volume \.+ 74%/);
    assert.match(text, /Overall Confidence: 82%/);
    assert.match(text, /1\.34×/);
  });
});
