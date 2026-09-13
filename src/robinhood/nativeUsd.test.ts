import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatNativeWithUsd,
  formatUsd,
  nativeToUsd,
} from "./nativeUsd";

describe("nativeUsd", () => {
  it("formats USD tiers", () => {
    assert.equal(formatUsd(2512.82), "$2513");
    assert.equal(formatUsd(3.1), "$3.10");
    assert.equal(formatUsd(0.0042), "$0.0042");
    assert.equal(formatUsd(0), "$0.00");
  });

  it("appends dollar value next to RH", () => {
    assert.equal(
      formatNativeWithUsd(0.001, 2500),
      "0.001000 RH ($2.50)"
    );
    assert.equal(formatNativeWithUsd(0.001, null), "0.001000 RH");
  });

  it("nativeToUsd multiplies", () => {
    assert.equal(nativeToUsd(0.002, 2500), 5);
    assert.equal(nativeToUsd(0.002, null), null);
  });
});
