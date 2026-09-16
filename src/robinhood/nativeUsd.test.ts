import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatNativeWithUsd, formatUsd, nativeToUsd } from "./nativeUsd";

describe("nativeUsd (ETH)", () => {
  it("formats usd", () => {
    assert.equal(formatUsd(12.5), "$12.50");
  });

  it("appends dollar value next to ETH", () => {
    assert.equal(
      formatNativeWithUsd(0.001, 3000, "ETH"),
      "0.001000 ETH ($3.00)"
    );
    assert.equal(formatNativeWithUsd(0.001, null, "ETH"), "0.001000 ETH");
  });

  it("converts native to usd", () => {
    assert.equal(nativeToUsd(0.01, 3000), 30);
    assert.equal(nativeToUsd(0.01, null), null);
  });
});
