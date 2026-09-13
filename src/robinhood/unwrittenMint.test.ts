import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { id } from "ethers";
import {
  ACQUIRE_SELECTOR,
  DECIPHER_SELECTOR,
  computeAcquireValue,
  UNWRITTEN,
} from "./unwrittenMint";
import { mineUnwrittenNonceSync } from "./unwrittenPow";

describe("unwrittenMint", () => {
  it("contract + OpenSea constants", () => {
    assert.equal(
      UNWRITTEN.contract,
      "0xcc840af97a2b4ba57410ebc48f2c736f8dacef82"
    );
    assert.match(UNWRITTEN.openSeaUrl, /the-unwritten/);
    assert.equal(UNWRITTEN.maxSupply, 8888);
  });

  it("acquire + decipher selectors", () => {
    assert.equal(ACQUIRE_SELECTOR, id("acquire(uint256)").slice(0, 10));
    assert.equal(ACQUIRE_SELECTOR, "0x20889d3b");
    assert.equal(DECIPHER_SELECTOR, id("decipher(uint256)").slice(0, 10));
  });

  it("computeAcquireValue matches site +2% default", () => {
    const price = 1_000_000_000_000_000n; // 0.001 ETH
    assert.equal(computeAcquireValue(price, 200), 1_020_000_000_000_000n);
    assert.equal(computeAcquireValue(price, 0), price);
  });
});

describe("unwrittenPow", () => {
  it("finds nonce under an easy target", () => {
    const seed =
      "0x107270bf7525d4674c39b58b6aca76fdbed4350783cb6e1515ff9a3f38f37033";
    const sender = "0x1111111111111111111111111111111111111111";
    const target = 1n << 255n;
    const found = mineUnwrittenNonceSync({
      seed,
      sender,
      target,
      maxTries: 10_000,
    });
    assert.ok(found);
    assert.ok(BigInt(found!.hash) < target);
  });

  it("sync mine respects shouldStop", () => {
    const seed =
      "0x107270bf7525d4674c39b58b6aca76fdbed4350783cb6e1515ff9a3f38f37033";
    const sender = "0x1111111111111111111111111111111111111111";
    const target = 1n << 200n;
    let calls = 0;
    const found = mineUnwrittenNonceSync({
      seed,
      sender,
      target,
      maxTries: 10_000,
      shouldStop: () => {
        calls++;
        return calls > 3;
      },
    });
    assert.equal(found, null);
    assert.ok(calls > 3);
  });
});
