import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMintFailure,
  normalizeTimestampMs,
  probeMintSlot,
} from "./slotProbe";
import { resetNonceManager, withWalletNonce } from "./nonceManager";

describe("normalizeTimestampMs", () => {
  it("treats unix seconds as seconds", () => {
    const sec = 1_700_000_000n;
    const ms = normalizeTimestampMs(sec);
    assert.equal(ms, 1_700_000_000_000);
  });

  it("keeps millisecond timestamps", () => {
    const msIn = 1_700_000_000_000n;
    assert.equal(normalizeTimestampMs(msIn), 1_700_000_000_000);
  });

  it("rejects zero", () => {
    assert.equal(normalizeTimestampMs(0n), null);
  });
});

describe("classifyMintFailure", () => {
  it("detects LOST_RACE", () => {
    const a = classifyMintFailure("already claimed");
    assert.equal(a.kind, "LOST_RACE");
    assert.match(a.reason, /consumed the slot/i);
  });

  it("detects TOO_EARLY / future slot", () => {
    const a = classifyMintFailure("too early: nextFreeAt");
    assert.equal(a.kind, "TOO_EARLY");
  });

  it("detects SOLD_OUT", () => {
    assert.equal(classifyMintFailure("fully minted").kind, "SOLD_OUT");
  });

  it("maps bare reverted to LOST_RACE for slot machines", () => {
    assert.equal(classifyMintFailure("reverted").kind, "LOST_RACE");
  });

  it("does not mark insufficient funds as LOST_RACE", () => {
    assert.equal(classifyMintFailure("insufficient funds").kind, "OTHER");
  });
});

describe("probeMintSlot", () => {
  it("contracts without timing functions → immediate path", async () => {
    const provider = {
      call: async () => {
        throw new Error("execution reverted");
      },
    } as unknown as import("ethers").JsonRpcProvider;

    const res = await probeMintSlot(
      provider,
      "0x1111111111111111111111111111111111111111",
      Date.now()
    );
    assert.equal(res.hasTiming, false);
    assert.equal(res.source, "none");
    assert.equal(res.isOpen, true);
  });

  it("future slot → isFuture armed wait", async () => {
    const futureSec = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const provider = {
      call: async () => "0x" + futureSec.toString(16).padStart(64, "0"),
    } as unknown as import("ethers").JsonRpcProvider;

    const now = Date.now();
    const res = await probeMintSlot(
      provider,
      "0x2222222222222222222222222222222222222222",
      now
    );
    assert.equal(res.hasTiming, true);
    assert.equal(res.isFuture, true);
    assert.equal(res.isOpen, false);
    assert.ok(res.opensAtMs && res.opensAtMs > now);
  });

  it("immediate/open slot → isOpen", async () => {
    const pastSec = BigInt(Math.floor(Date.now() / 1000) - 60);
    const provider = {
      call: async () => "0x" + pastSec.toString(16).padStart(64, "0"),
    } as unknown as import("ethers").JsonRpcProvider;

    const res = await probeMintSlot(
      provider,
      "0x3333333333333333333333333333333333333333",
      Date.now()
    );
    assert.equal(res.hasTiming, true);
    assert.equal(res.isFuture, false);
    assert.equal(res.isOpen, true);
  });
});

describe("multiple wallets nonce isolation", () => {
  it("wallets never share nonces", async () => {
    resetNonceManager();
    const provider = {
      getTransactionCount: async (addr: string) =>
        addr.toLowerCase().startsWith("0xaaa") ? 1 : 5,
    } as unknown as import("ethers").JsonRpcProvider;

    const a = await withWalletNonce({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      provider,
      fn: async (n) => n,
    });
    const b = await withWalletNonce({
      address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      provider,
      fn: async (n) => n,
    });
    assert.equal(a, 1);
    assert.equal(b, 5);
  });
});
