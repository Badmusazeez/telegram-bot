import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  classifyMintCalldata,
  isMintLikeCalldata,
  NON_MINT_SELECTORS,
} from "./mintDetect";
import {
  clearMintStrategyCache,
  getCachedMintStrategy,
  mintStrategyCacheSize,
  orderedStrategyKinds,
  rememberMintStrategy,
} from "./strategyCache";
import {
  peekCachedNonce,
  resetNonceManager,
  withWalletNonce,
} from "./nonceManager";
import { PipelineTimer } from "./latency";
import { resolveMintGasLimit } from "./mintGas";

describe("classifyMintCalldata", () => {
  it("accepts SeaDrop mintPublic as high-confidence mint", () => {
    const data =
      "0x161ac21f" +
      "000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
      "0000000000000000000000000000a26b00c1f0df003000390027140000faa719" +
      "000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" +
      "0000000000000000000000000000000000000000000000000000000000000001";
    const c = classifyMintCalldata(
      "0x00005ea00ac477b1030ce78506496e8c2de24bf5",
      data
    );
    assert.equal(c.isMint, true);
    assert.equal(c.confidence, "high");
  });

  it("accepts legacy SeaDrop mintPublic selector", async () => {
    const { isSeaDropMintPublic, decodeSeaDropMintPublic } = await import(
      "./seaDrop"
    );
    const data =
      "0x9b4f3f25" +
      "000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
      "0000000000000000000000000000a26b00c1f0df003000390027140000faa719" +
      "000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" +
      "0000000000000000000000000000000000000000000000000000000000000002";
    assert.equal(isSeaDropMintPublic(data), true);
    const decoded = decodeSeaDropMintPublic(data);
    assert.ok(decoded);
    assert.equal(decoded!.quantity, 2);
  });

  it("rejects ERC-20 transfer / approve selectors", () => {
    for (const sel of ["0xa9059cbb", "0x095ea7b3", "0xa22cb465"]) {
      assert.equal(NON_MINT_SELECTORS.has(sel), true);
      assert.equal(isMintLikeCalldata("0xabc", sel + "00".repeat(64)), false);
    }
  });

  it("accepts mint(uint256) selector", () => {
    const c = classifyMintCalldata(
      "0x1111111111111111111111111111111111111111",
      "0xa0712d68" + "00".repeat(64)
    );
    assert.equal(c.isMint, true);
  });

  it("accepts Outlaws-style mint(uint256,bytes32[]) selector", () => {
    const data =
      "0xba41b0c6" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "0000000000000000000000000000000000000000000000000000000000000000";
    const c = classifyMintCalldata(
      "0xe0ed3a7db90a18852010b1374a677db6a5821174",
      data,
      undefined,
      0n
    );
    assert.equal(c.isMint, true);
    assert.equal(c.confidence, "medium");
  });

  it("treats unknown 0-value custom calls as free-mint candidates when enabled", () => {
    const c = classifyMintCalldata(
      "0x1111111111111111111111111111111111111111",
      "0xdeadbeef" + "00".repeat(64),
      undefined,
      0n,
      { acceptUnknownZeroValue: true }
    );
    assert.equal(c.isMint, true);
    assert.equal(c.confidence, "low");
  });

  it("does not treat unknown 0-value calls as mint without opt-in", () => {
    const c = classifyMintCalldata(
      "0x1111111111111111111111111111111111111111",
      "0xdeadbeef" + "00".repeat(64),
      undefined,
      0n
    );
    assert.equal(c.isMint, false);
  });

  it("still rejects unknown paid (value>0) custom calls", () => {
    const c = classifyMintCalldata(
      "0x1111111111111111111111111111111111111111",
      "0xdeadbeef" + "00".repeat(64),
      undefined,
      10n ** 15n,
      { acceptUnknownZeroValue: true }
    );
    assert.equal(c.isMint, false);
  });
});

describe("strategyCache", () => {
  beforeEach(() => clearMintStrategyCache());

  it("remembers and reorders strategies for fast path", () => {
    rememberMintStrategy({
      contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "replay",
      quantity: 10,
    });
    assert.equal(mintStrategyCacheSize(), 1);
    const hit = getCachedMintStrategy(
      "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
    );
    assert.ok(hit);
    assert.equal(hit!.kind, "replay");
    assert.deepEqual(
      orderedStrategyKinds("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", [
        "opensea",
        "replay",
        "public",
      ]),
      ["replay", "opensea", "public"]
    );
  });
});

describe("nonceManager", () => {
  beforeEach(() => resetNonceManager());

  it("serializes same-wallet sends and advances nonce", async () => {
    const provider = {
      getTransactionCount: async () => 7,
    } as unknown as import("ethers").JsonRpcProvider;

    const seen: number[] = [];
    await Promise.all([
      withWalletNonce({
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        provider,
        fn: async (n) => {
          seen.push(n);
          await new Promise((r) => setTimeout(r, 20));
          return n;
        },
      }),
      withWalletNonce({
        address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        provider,
        fn: async (n) => {
          seen.push(n);
          return n;
        },
      }),
    ]);
    assert.deepEqual(seen, [7, 8]);
    assert.equal(
      peekCachedNonce("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      9
    );
  });
});

describe("PipelineTimer", () => {
  it("reports total latency", async () => {
    const t = new PipelineTimer(Date.now() - 50);
    t.mark("decode");
    await new Promise((r) => setTimeout(r, 5));
    t.mark("strategy");
    t.mark("simulate");
    t.mark("broadcast");
    t.mark("done");
    const s = t.summary(true);
    assert.match(s, /total=\d+ms/);
    assert.match(s, /result=ok/);
  });
});

describe("gas + simulation gate", () => {
  it("estimateGas-style rejection still blocks abnormal gas", () => {
    const bad = resolveMintGasLimit({
      estimated: 9_000_000n,
      ceiling: 2_500_000,
    });
    assert.equal(bad.ok, false);
  });

  it("simulation-pass estimate becomes gasLimit with margin", () => {
    const ok = resolveMintGasLimit({
      estimated: 400_000n,
      ceiling: 2_500_000,
      marginPct: 20,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.gasLimit, 480_000n);
  });
});
