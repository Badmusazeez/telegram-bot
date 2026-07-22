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
    assert.equal(funnel.topRejectStage, "volume");
    assert.equal(funnel.topRejectCount, 22);
    const text = formatFunnelLog(funnel);
    assert.match(text, /Top reject: volume \(22 pairs\)/);
    assert.match(text, /Scanned: 40/);
  });
});
