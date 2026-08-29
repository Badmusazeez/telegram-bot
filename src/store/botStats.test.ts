import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMonthlyStatsPlain,
  parseWalletOkFail,
  type MonthlyBotStats,
} from "../store/botStats";

describe("parseWalletOkFail", () => {
  it("parses N/M wallet reasons", () => {
    assert.deepEqual(
      parseWalletOkFail("SeaDrop minted on 7/21 wallet(s): …"),
      { ok: 7, fail: 14 }
    );
    assert.deepEqual(parseWalletOkFail("Sharp SEND-ONLY burst 3/5 in 40ms"), {
      ok: 3,
      fail: 2,
    });
    assert.deepEqual(
      parseWalletOkFail("Snipe done: 4/7 ready wallet(s) hold NFT"),
      { ok: 4, fail: 3 }
    );
  });
});

describe("formatMonthlyStatsPlain", () => {
  it("matches the Telegram Stats layout", () => {
    const stats: MonthlyBotStats = {
      month: "2026-08",
      mintsOk: 12,
      mintsFailed: 8486,
      disbursements: 1668,
      sweeps: 4,
      tracks: 9,
    };
    const text = formatMonthlyStatsPlain(stats);
    assert.equal(
      text,
      [
        "📊 Stats",
        "Mints OK: 12",
        "Mints failed: 8486",
        "Disbursements: 1668",
        "Sweeps: 4",
        "Tracks: 9",
      ].join("\n")
    );
  });
});
