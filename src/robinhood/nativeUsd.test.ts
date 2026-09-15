import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatNativeWithUsd,
  formatUsd,
  nativeToUsd,
} from "./nativeUsd";

describe("nativeUsd", () => {
  it("formats USD tiers", () => {
    assert.equal(formatUsd(12.5), "$12.50");
    assert.equal(formatUsd(0.0042), "$0.0042");
    assert.equal(formatUsd(0), "$0.00");
  });

  it("appends dollar value next to USDC", () => {
    assert.equal(
      formatNativeWithUsd(0.001, 1),
      "0.001000 USDC ($0.0010)"
    );
    assert.equal(formatNativeWithUsd(0.001, null), "0.001000 USDC");
  });

  it("nativeToUsd multiplies", () => {
    assert.equal(nativeToUsd(2, 1), 2);
    assert.equal(nativeToUsd(0.002, null), null);
  });
});
