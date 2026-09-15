import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRpcQuotaReport, type RpcQuotaReport } from "./rpcQuota";

describe("formatRpcQuotaReport", () => {
  it("shows percent for both providers", () => {
    const report: RpcQuotaReport = {
      at: "2026-08-20T16:00:00.000Z",
      alchemy: {
        provider: "Alchemy",
        role: "track",
        rpcLabel: "https://…alchemy…/v2/***",
        percentUsed: 42.5,
        used: 4_250_000,
        limit: 10_000_000,
        unit: "CU",
        status: "OK",
        latencyMs: 55,
        detail: "4.25M / 10M CU",
        source: "admin_api",
      },
      chainstack: {
        provider: "Chainstack",
        role: "mint",
        rpcLabel: "https://…chainstack…/***",
        percentUsed: 12,
        used: 360_000,
        limit: 3_000_000,
        unit: "RU",
        status: "OK",
        latencyMs: 80,
        detail: "360k / 3M RU",
        source: "platform_api",
      },
    };
    const html = formatRpcQuotaReport(report);
    assert.match(html, /RPC quota report/);
    assert.match(html, /42\.5%/);
    assert.match(html, /12%/);
    assert.match(html, /Alchemy/);
    assert.match(html, /Chainstack/);
  });

  it("shows 100% FULL for monthly capacity", () => {
    const report: RpcQuotaReport = {
      at: "2026-08-20T16:00:00.000Z",
      alchemy: {
        provider: "Alchemy",
        role: "track",
        rpcLabel: "alchemy/*** ",
        percentUsed: 100,
        status: "FULL",
        latencyMs: 30,
        detail: "MONTHLY CAPACITY EXCEEDED",
        source: "live_probe",
      },
      chainstack: {
        provider: "Chainstack",
        role: "mint",
        rpcLabel: "chainstack/*** ",
        percentUsed: null,
        status: "OK",
        latencyMs: 40,
        detail: "live OK",
        source: "live_probe",
      },
    };
    const html = formatRpcQuotaReport(report);
    assert.match(html, /100%/);
    assert.match(html, /FULL/);
    assert.match(html, /unknown %/);
  });
});
