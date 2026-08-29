import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatGasUsedEstimate,
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
      gasUsedEstimate: 12_450_000,
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
        "Gas used (est): 12,450,000",
      ].join("\n")
    );
  });
});

describe("formatGasUsedEstimate", () => {
  it("formats thousands with commas", () => {
    assert.equal(formatGasUsedEstimate(0), "0");
    assert.equal(formatGasUsedEstimate(12_450_000), "12,450,000");
  });
});
