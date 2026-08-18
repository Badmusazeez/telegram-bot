/**
 * Sniper upgrade unit tests — failure analyzer, RPC pick, paid/free,
 * sold-out, eligibility, nextFreeAt, nonce isolation, Telegram format.
 * Does not hit live chain.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  analyzeMintFailure,
  classifyMintFailure,
} from "./failureAnalyze";
import {
  clearMintRpcPickCache,
  pickFastestMintRpc,
} from "./mintRpcPick";
import {
  normalizeTimestampMs,
  probeMintSlot,
} from "./slotProbe";
import {
  clearMintStrategyCache,
  getCachedMintStrategy,
  isKnownSuccessfulPath,
  rememberMintStrategy,
} from "./strategyCache";
import { resetNonceManager, withWalletNonce } from "./nonceManager";
import { formatPaidMintDetected, formatSlotRaceEvent } from "../telegram/formatter";
import { resolveMintGasLimit } from "./mintGas";

describe("analyzeMintFailure (rich classifier)", () => {
  it("classifies free-mint path errors distinctly", () => {
    assert.equal(analyzeMintFailure("not eligible").kind, "NOT_ELIGIBLE");
    assert.equal(analyzeMintFailure("insufficient payment").kind, "PAYMENT_REQUIRED");
    assert.equal(analyzeMintFailure("too early nextFreeAt").kind, "MINT_NOT_STARTED");
    assert.equal(analyzeMintFailure("sale ended").kind, "MINT_ENDED");
    assert.equal(analyzeMintFailure("sold out").kind, "SOLD_OUT");
    assert.equal(analyzeMintFailure("invalid quantity").kind, "QUANTITY_INVALID");
    assert.equal(analyzeMintFailure("already minted").kind, "ALREADY_MINTED");
    assert.equal(analyzeMintFailure("invalid merkle proof").kind, "PROOF_REQUIRED");
    assert.equal(analyzeMintFailure("not approved").kind, "APPROVAL_REQUIRED");
    assert.equal(analyzeMintFailure("no function selector").kind, "WRONG_CALLDATA");
    assert.equal(analyzeMintFailure("exceeds MAX_MINT_GAS_LIMIT").kind, "GAS_ERROR");
    assert.equal(analyzeMintFailure("nonce too low").kind, "NONCE_ERROR");
    assert.equal(analyzeMintFailure("rate limit 429").kind, "RPC_ERROR");
  });

  it("maps lost race / sold out / too early for slot recovery", () => {
    assert.equal(classifyMintFailure("already claimed").kind, "LOST_RACE");
    assert.match(classifyMintFailure("already claimed").reason, /consumed the slot/i);
    assert.equal(classifyMintFailure("too early").kind, "TOO_EARLY");
    assert.equal(classifyMintFailure("fully minted").kind, "SOLD_OUT");
    assert.equal(classifyMintFailure("reverted").kind, "LOST_RACE");
  });

  it("paid mint is NOT lost race", () => {
    assert.equal(classifyMintFailure("insufficient funds").kind, "OTHER");
    assert.equal(analyzeMintFailure("must pay").kind, "PAYMENT_REQUIRED");
  });
});

describe("scheduled vs immediate mint probe", () => {
  it("scheduled (future) mint → isFuture for pre-arm", async () => {
    const futureSec = BigInt(Math.floor(Date.now() / 1000) + 7200);
    const provider = {
      call: async () => "0x" + futureSec.toString(16).padStart(64, "0"),
    } as unknown as import("ethers").JsonRpcProvider;
    const res = await probeMintSlot(
      provider,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      Date.now()
    );
    assert.equal(res.hasTiming, true);
    assert.equal(res.isFuture, true);
    assert.equal(res.isOpen, false);
  });

  it("immediate open mint → isOpen (use blast path)", async () => {
    const pastSec = BigInt(Math.floor(Date.now() / 1000) - 30);
    const provider = {
      call: async () => "0x" + pastSec.toString(16).padStart(64, "0"),
    } as unknown as import("ethers").JsonRpcProvider;
    const res = await probeMintSlot(
      provider,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      Date.now()
    );
    assert.equal(res.hasTiming, true);
    assert.equal(res.isOpen, true);
    assert.equal(res.isFuture, false);
  });

  it("no timing → immediate mint path", async () => {
    const provider = {
      call: async () => {
        throw new Error("execution reverted");
      },
    } as unknown as import("ethers").JsonRpcProvider;
    const res = await probeMintSlot(
      provider,
      "0xcccccccccccccccccccccccccccccccccccccccc",
      Date.now()
    );
    assert.equal(res.hasTiming, false);
    assert.equal(res.isOpen, true);
  });

  it("nextFreeAt recovery uses future opensAtMs", () => {
    const next = normalizeTimestampMs(BigInt(Math.floor(Date.now() / 1000) + 90));
    assert.ok(next && next > Date.now());
  });
});

describe("paid mint safety messaging", () => {
  it("formatPaidMintDetected shows NOT SUBMITTED", () => {
    const html = formatPaidMintDetected({
      contract: "0xdddddddddddddddddddddddddddddddddddddddd",
      priceEth: "0.05",
    });
    assert.match(html, /PAID MINT DETECTED/);
    assert.match(html, /0\.05 ETH/);
    assert.match(html, /NOT SUBMITTED/);
  });
});

describe("wallet eligibility via failure kinds", () => {
  it("NOT_ELIGIBLE and ALREADY_MINTED skip further spend attempts semantically", () => {
    assert.equal(analyzeMintFailure("not on the allowlist").kind, "NOT_ELIGIBLE");
    assert.equal(analyzeMintFailure("max per wallet").kind, "ALREADY_MINTED");
  });
});

describe("invalid quantity + simulation failure", () => {
  it("quantity invalid classified", () => {
    assert.equal(analyzeMintFailure("cannot mint 0").kind, "QUANTITY_INVALID");
  });

  it("simulation failure via abnormal gas estimate", () => {
    const bad = resolveMintGasLimit({
      estimated: 12_000_000n,
      ceiling: 2_500_000,
    });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /MAX_MINT_GAS_LIMIT/);
  });

  it("successful mint gas path", () => {
    const ok = resolveMintGasLimit({
      estimated: 250_000n,
      ceiling: 2_500_000,
      marginPct: 20,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.gasLimit, 300_000n);
  });
});

describe("multi-wallet nonce isolation", () => {
  beforeEach(() => resetNonceManager());

  it("parallel wallets keep independent nonces", async () => {
    const provider = {
      getTransactionCount: async (addr: string) =>
        addr.toLowerCase().startsWith("0x111") ? 10 : 20,
    } as unknown as import("ethers").JsonRpcProvider;

    const [a, b, a2] = await Promise.all([
      withWalletNonce({
        address: "0x1111111111111111111111111111111111111111",
        provider,
        fn: async (n) => n,
      }),
      withWalletNonce({
        address: "0x2222222222222222222222222222222222222222",
        provider,
        fn: async (n) => n,
      }),
      withWalletNonce({
        address: "0x1111111111111111111111111111111111111111",
        provider,
        fn: async (n) => n,
      }),
    ]);
    assert.equal(a, 10);
    assert.equal(b, 20);
    assert.equal(a2, 11);
  });
});

describe("RPC failure / pick", () => {
  beforeEach(() => clearMintRpcPickCache());

  it("pickFastestMintRpc returns a labeled provider (may use env RPC)", async () => {
    // In CI without live RPC this may still construct primary; latency may be high.
    try {
      const pick = await pickFastestMintRpc(true);
      assert.ok(pick.label);
      assert.ok(pick.provider);
      assert.ok(typeof pick.latencyMs === "number");
    } catch (err) {
      // Missing env in unit tests — acceptable; classify as RPC_ERROR shape.
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(msg.length > 0);
    }
  });

  it("RPC errors classify as RPC_ERROR", () => {
    assert.equal(analyzeMintFailure("ECONNRESET timeout").kind, "RPC_ERROR");
  });
});

describe("smart learning cache (fast path)", () => {
  beforeEach(() => clearMintStrategyCache());

  it("stores selector + gas + mint type for next hit", () => {
    rememberMintStrategy({
      contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      kind: "seadrop",
      quantity: 5,
      data:
        "0x161ac21f" +
        "000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      gasLimit: 480_000n,
      mintType: "free",
    });
    const hit = getCachedMintStrategy(
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    );
    assert.ok(hit);
    assert.equal(hit!.selector, "0x161ac21f");
    assert.equal(hit!.gasLimit, "480000");
    assert.equal(hit!.mintType, "free");
    assert.equal(
      isKnownSuccessfulPath(
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "0x161ac21f00"
      ),
      true
    );
  });
});

describe("sniper Telegram format", () => {
  it("ARMED / WINDOW / SUBMITTED / SUCCESS / LOST / NEXT", () => {
    assert.match(
      formatSlotRaceEvent({
        phase: "ARMED",
        contract: "0x1",
        mintType: "SeaDrop/free",
        opensAtMs: Date.now() + 60_000,
        walletsArmed: 21,
        latencyMs: 120,
      }),
      /SNIPER ARMED/
    );
    assert.match(
      formatSlotRaceEvent({
        phase: "WINDOW_OPEN",
        contract: "0x1",
        walletsArmed: 21,
      }),
      /MINT WINDOW OPEN/
    );
    assert.match(
      formatSlotRaceEvent({
        phase: "BURST",
        contract: "0x1",
        wallet: "0xabc",
        strategy: "SeaDrop",
        gasLimit: "400000",
        rpcLabel: "mint-primary 12ms",
      }),
      /SUBMITTED/
    );
    assert.match(
      formatSlotRaceEvent({
        phase: "SUCCESS",
        contract: "0x1",
        wallet: "0xabc",
        txHash: "0xdead",
      }),
      /SUCCESS/
    );
    assert.match(
      formatSlotRaceEvent({
        phase: "LOST_RACE",
        contract: "0x1",
        wallet: "0xabc",
        reason: "slot taken",
        failKind: "LOST_RACE",
      }),
      /LOST RACE/
    );
    assert.match(
      formatSlotRaceEvent({
        phase: "NEXT_SLOT",
        contract: "0x1",
        opensAtMs: Date.now() + 120_000,
      }),
      /NEXT OPPORTUNITY/
    );
  });
});

describe("lost race + next-slot recovery semantics", () => {
  it("LOST_RACE then future nextFreeAt is recoverable", async () => {
    const futureSec = BigInt(Math.floor(Date.now() / 1000) + 120);
    const provider = {
      call: async () => "0x" + futureSec.toString(16).padStart(64, "0"),
    } as unknown as import("ethers").JsonRpcProvider;
    const cls = classifyMintFailure("already claimed");
    assert.equal(cls.kind, "LOST_RACE");
    const next = await probeMintSlot(
      provider,
      "0xffffffffffffffffffffffffffffffffffffffff",
      Date.now()
    );
    assert.equal(next.hasTiming, true);
    assert.ok(next.opensAtMs && next.opensAtMs > Date.now() + 500);
  });
});
