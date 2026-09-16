import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "ethers";
import {
  CONSOLIDATE_DUST_WEI,
  parseDisburseArgs,
  parseEthAmount,
} from "./ethTreasury";

describe("ethTreasury parsers", () => {
  it("parseEthAmount", () => {
    assert.equal(parseEthAmount("0.001"), parseEther("0.001"));
    assert.equal(parseEthAmount("1eth"), parseEther("1"));
    assert.equal(parseEthAmount("1usdc"), parseEther("1"));
    assert.equal(parseEthAmount("2.5usdc"), parseEther("2.5"));
    assert.equal(parseEthAmount("0"), null);
    assert.equal(parseEthAmount(""), null);
    assert.equal(parseEthAmount("abc"), null);
  });

  it("parseDisburseArgs", () => {
    assert.deepEqual(parseDisburseArgs("0.001 all"), {
      amountWei: parseEther("0.001"),
      walletRaw: "all",
    });
    assert.deepEqual(parseDisburseArgs("0.002 1 2"), {
      amountWei: parseEther("0.002"),
      walletRaw: "1 2",
    });
    assert.equal(parseDisburseArgs(""), null);
    assert.equal(parseDisburseArgs("all"), null);
  });

  it("dust reserve is positive", () => {
    assert.ok(CONSOLIDATE_DUST_WEI > 0n);
  });
});
