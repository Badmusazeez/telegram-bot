import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { id } from "ethers";
import {
  ACQUIRE_SELECTOR,
  computeAcquireValue,
  UNWRITTEN,
} from "./unwrittenMint";

describe("unwrittenMint", () => {
  it("contract + OpenSea constants", () => {
    assert.equal(
      UNWRITTEN.contract,
      "0xcc840af97a2b4ba57410ebc48f2c736f8dacef82"
    );
    assert.match(UNWRITTEN.openSeaUrl, /the-unwritten/);
    assert.equal(UNWRITTEN.maxSupply, 8888);
  });

  it("acquire(uint256) selector", () => {
    assert.equal(ACQUIRE_SELECTOR, id("acquire(uint256)").slice(0, 10));
    assert.equal(ACQUIRE_SELECTOR, "0x20889d3b");
  });

  it("computeAcquireValue matches site +2% default", () => {
    const price = 1_000_000_000_000_000n; // 0.001 ETH
    assert.equal(computeAcquireValue(price, 200), 1_020_000_000_000_000n);
    assert.equal(computeAcquireValue(price, 0), price);
  });
});
