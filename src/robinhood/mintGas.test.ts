import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_MINT_GAS_LIMIT,
  mintSelectorLabel,
  resolveMintGasLimit,
} from "./mintGas";

describe("resolveMintGasLimit", () => {
  it("accepts a legitimate ~1.2M estimate and applies 20% margin capped by ceiling", () => {
    const estimated = 1_200_000n;
    const ceiling = 2_500_000;
    const res = resolveMintGasLimit({ estimated, ceiling, marginPct: 20 });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.estimated, estimated);
    // 1_200_000 * 1.2 = 1_440_000
    assert.equal(res.gasLimit, 1_440_000n);
    assert.equal(res.gasLimit < BigInt(ceiling), true);
    assert.equal(res.marginPct, 20);
  });

  it("does not send the raw 1.2M hint as gasLimit when estimate is smaller", () => {
    const estimated = 250_000n;
    const res = resolveMintGasLimit({
      estimated,
      ceiling: DEFAULT_MAX_MINT_GAS_LIMIT,
      marginPct: 20,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.gasLimit, 300_000n); // 250k * 1.2
    assert.notEqual(res.gasLimit, 1_200_000n);
  });

  it("rejects an abnormally high estimate above the safety ceiling", () => {
    const estimated = 9_000_000n;
    const ceiling = 2_500_000;
    const res = resolveMintGasLimit({ estimated, ceiling, marginPct: 20 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.reason, /exceeds MAX_MINT_GAS_LIMIT/);
    assert.equal(res.estimated, estimated);
  });

  it("caps margin at the ceiling when estimate is near the limit", () => {
    const estimated = 2_400_000n;
    const ceiling = 2_500_000;
    const res = resolveMintGasLimit({ estimated, ceiling, marginPct: 20 });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // 2.4M * 1.2 = 2.88M → capped to ceiling
    assert.equal(res.gasLimit, BigInt(ceiling));
  });

  it("rejects non-positive estimates", () => {
    const res = resolveMintGasLimit({
      estimated: 0n,
      ceiling: 2_500_000,
    });
    assert.equal(res.ok, false);
  });

  it("labels SeaDrop mintPublic selector", () => {
    assert.equal(
      mintSelectorLabel(
        "0x161ac21f000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ),
      "SeaDrop.mintPublic"
    );
  });
});
