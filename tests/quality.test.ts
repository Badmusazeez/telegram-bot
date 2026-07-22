import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atrPctOk, qualityLabel } from "../src/analysis/quality";

describe("quality gates", () => {
  it("rejects tiny and huge ATR%", () => {
    assert.equal(atrPctOk(0.01, 100).ok, false); // 0.01%
    assert.equal(atrPctOk(10, 100).ok, false); // 10%
    assert.equal(atrPctOk(1, 100).ok, true); // 1%
  });

  it("labels confidence bands", () => {
    assert.equal(qualityLabel(95), "HIGH");
    assert.equal(qualityLabel(90), "MED");
    assert.equal(qualityLabel(40), "LOW");
  });
});
