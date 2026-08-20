/**
 * Fetch Alchemy + Chainstack RPC quota / usage for Telegram reports.
 *
 * Exact % requires:
 *   ALCHEMY_ADMIN_KEY  → Admin Usage API (percentUsed)
 *   CHAINSTACK_API_KEY → Platform API node-usage (+ CHAINSTACK_MONTHLY_RU_LIMIT)
 *
 * Without those keys, live-probes the RPC URLs and maps monthly-capacity
 * 429s to 100% FULL so you still get actionable alerts.
 */

import { config, rpcLabels } from "../config";

export type RpcQuotaStatus =
  | "OK"
  | "FULL"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type ProviderQuota = {
  provider: "Alchemy" | "Chainstack";
  role: "track" | "mint";
  rpcLabel: string;
  /** 0–100+ when known; null when unknown. */
  percentUsed: number | null;
  used?: number;
  limit?: number;
  unit?: string;
  remaining?: number;
  status: RpcQuotaStatus;
  latencyMs: number | null;
  detail: string;
  source: "admin_api" | "platform_api" | "live_probe";
};

export type RpcQuotaReport = {
  at: string;
  alchemy: ProviderQuota;
  chainstack: ProviderQuota;
};

async function probeJsonRpc(
  url: string
): Promise<{
  ok: boolean;
  latencyMs: number;
  status: RpcQuotaStatus;
  detail: string;
  httpStatus: number | null;
}> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    let errMsg = "";
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string; code?: number };
        result?: string;
      };
      errMsg = json.error?.message || "";
      if (json.result) {
        return {
          ok: true,
          latencyMs,
          status: "OK",
          detail: `block ${json.result}`,
          httpStatus: res.status,
        };
      }
    } catch {
      errMsg = text.slice(0, 200);
    }

    const lower = `${errMsg} ${text}`.toLowerCase();
    if (
      /monthly capacity|compute units|cu limit|capacity limit|out of credits|quota/i.test(
        lower
      ) ||
      res.status === 402
    ) {
      return {
        ok: false,
        latencyMs,
        status: "FULL",
        detail: errMsg.slice(0, 180) || `HTTP ${res.status}`,
        httpStatus: res.status,
      };
    }
    if (res.status === 429 || /rate limit|too many requests|throughput/i.test(lower)) {
      return {
        ok: false,
        latencyMs,
        status: "RATE_LIMITED",
        detail: errMsg.slice(0, 180) || `HTTP ${res.status}`,
        httpStatus: res.status,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        latencyMs,
        status: "UNAVAILABLE",
        detail: errMsg.slice(0, 180) || `HTTP ${res.status}`,
        httpStatus: res.status,
      };
    }
    return {
      ok: false,
      latencyMs,
      status: "UNKNOWN",
      detail: errMsg.slice(0, 180) || "no result",
      httpStatus: res.status,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      status: "UNAVAILABLE",
      detail: err instanceof Error ? err.message.slice(0, 180) : String(err),
      httpStatus: null,
    };
  }
}

async function fetchAlchemyAdminUsage(): Promise<Partial<ProviderQuota> | null> {
  const key = config.alchemyAdminKey;
  if (!key) return null;
  try {
    const res = await fetch("https://admin-api.alchemy.com/v1/usage/summary", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        detail: `Admin API HTTP ${res.status}: ${text.slice(0, 120)}`,
        source: "admin_api",
        status: "UNKNOWN",
      };
    }
    const json = JSON.parse(text) as {
      data?: {
        usageLimit?: {
          unit?: string;
          limit?: string | number;
          used?: string | number;
          remaining?: string | number;
          percentUsed?: number;
        };
      };
    };
    const ul = json.data?.usageLimit;
    if (!ul) {
      return {
        detail: "Admin API: no usageLimit in response",
        source: "admin_api",
        status: "UNKNOWN",
      };
    }
    const used = Number(ul.used);
    const limit = Number(ul.limit);
    const remaining = Number(ul.remaining);
    const percentUsed =
      typeof ul.percentUsed === "number"
        ? ul.percentUsed
        : limit > 0 && Number.isFinite(used)
          ? Math.round((used / limit) * 1000) / 10
          : null;
    const status: RpcQuotaStatus =
      percentUsed != null && percentUsed >= 100
        ? "FULL"
        : percentUsed != null && percentUsed >= 90
          ? "OK"
          : "OK";
    return {
      percentUsed,
      used: Number.isFinite(used) ? used : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      remaining: Number.isFinite(remaining) ? remaining : undefined,
      unit: ul.unit || "CU",
      status: percentUsed != null && percentUsed >= 100 ? "FULL" : status,
      detail:
        percentUsed != null
          ? `${formatNum(used)} / ${formatNum(limit)} ${ul.unit || "CU"}`
          : "usageLimit present but percent unknown",
      source: "admin_api",
    };
  } catch (err) {
    return {
      detail: `Admin API error: ${
        err instanceof Error ? err.message.slice(0, 120) : String(err)
      }`,
      source: "admin_api",
      status: "UNKNOWN",
    };
  }
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

async function fetchChainstackUsage(): Promise<Partial<ProviderQuota> | null> {
  const key = config.chainstackApiKey;
  if (!key) return null;
  try {
    const res = await fetch(
      "https://api.chainstack.com/v2/reporting/node-usage/?page_size=100",
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      return {
        detail: `Platform API HTTP ${res.status}: ${text.slice(0, 120)}`,
        source: "platform_api",
        status: "UNKNOWN",
      };
    }
    const json = JSON.parse(text) as {
      totals?: {
        request_units?: number | string;
        requestUnits?: number | string;
        rus?: number | string;
      };
      results?: Array<{
        request_units?: number | string;
        requestUnits?: number | string;
      }>;
    };

    let used = Number(
      json.totals?.request_units ??
        json.totals?.requestUnits ??
        json.totals?.rus ??
        NaN
    );
    if (!Number.isFinite(used) && Array.isArray(json.results)) {
      used = json.results.reduce((sum, row) => {
        const v = Number(row.request_units ?? row.requestUnits ?? 0);
        return sum + (Number.isFinite(v) ? v : 0);
      }, 0);
    }

    const limit = config.chainstackMonthlyRuLimit;
    if (!Number.isFinite(used)) {
      return {
        detail: "Platform API: could not parse request units",
        source: "platform_api",
        status: "UNKNOWN",
      };
    }
    const percentUsed =
      limit > 0 ? Math.round((used / limit) * 1000) / 10 : null;
    return {
      percentUsed,
      used,
      limit,
      remaining: limit > 0 ? Math.max(0, limit - used) : undefined,
      unit: "RU",
      status:
        percentUsed != null && percentUsed >= 100
          ? "FULL"
          : percentUsed != null && percentUsed >= 0
            ? "OK"
            : "UNKNOWN",
      detail: `${formatNum(used)} / ${formatNum(limit)} RU (billing period)`,
      source: "platform_api",
    };
  } catch (err) {
    return {
      detail: `Platform API error: ${
        err instanceof Error ? err.message.slice(0, 120) : String(err)
      }`,
      source: "platform_api",
      status: "UNKNOWN",
    };
  }
}

function fromProbe(
  provider: "Alchemy" | "Chainstack",
  role: "track" | "mint",
  rpcLabel: string,
  probe: Awaited<ReturnType<typeof probeJsonRpc>>,
  missingKeyHint: string
): ProviderQuota {
  const percentUsed = probe.status === "FULL" ? 100 : null;
  return {
    provider,
    role,
    rpcLabel,
    percentUsed,
    status: probe.status,
    latencyMs: probe.latencyMs,
    unit: provider === "Alchemy" ? "CU" : "RU",
    detail:
      probe.status === "FULL"
        ? `MONTHLY CAPACITY EXCEEDED — ${probe.detail}`
        : probe.status === "OK"
          ? `live OK · ${missingKeyHint}`
          : probe.detail,
    source: "live_probe",
  };
}

export async function collectRpcQuotaReport(): Promise<RpcQuotaReport> {
  const [alchemyProbe, chainstackProbe, alchemyAdmin, chainstackApi] =
    await Promise.all([
      probeJsonRpc(config.trackRpcUrl),
      probeJsonRpc(config.mintRpcUrl),
      fetchAlchemyAdminUsage(),
      fetchChainstackUsage(),
    ]);

  let alchemy: ProviderQuota;
  if (alchemyAdmin && alchemyAdmin.percentUsed != null) {
    alchemy = {
      provider: "Alchemy",
      role: "track",
      rpcLabel: rpcLabels.track,
      percentUsed: alchemyAdmin.percentUsed ?? null,
      used: alchemyAdmin.used,
      limit: alchemyAdmin.limit,
      remaining: alchemyAdmin.remaining,
      unit: alchemyAdmin.unit || "CU",
      status:
        alchemyAdmin.status ||
        (alchemyProbe.status === "FULL" ? "FULL" : "OK"),
      latencyMs: alchemyProbe.latencyMs,
      detail: alchemyAdmin.detail || "",
      source: "admin_api",
    };
    // Live probe can still override to FULL if Admin API lags.
    if (alchemyProbe.status === "FULL") {
      alchemy.status = "FULL";
      alchemy.percentUsed = Math.max(alchemy.percentUsed ?? 0, 100);
      alchemy.detail = `${alchemy.detail} · live: FULL`;
    }
  } else {
    alchemy = fromProbe(
      "Alchemy",
      "track",
      rpcLabels.track,
      alchemyProbe,
      alchemyAdmin?.detail
        ? alchemyAdmin.detail
        : "set ALCHEMY_ADMIN_KEY for exact CU %"
    );
  }

  let chainstack: ProviderQuota;
  if (chainstackApi && chainstackApi.percentUsed != null) {
    chainstack = {
      provider: "Chainstack",
      role: "mint",
      rpcLabel: rpcLabels.mint,
      percentUsed: chainstackApi.percentUsed ?? null,
      used: chainstackApi.used,
      limit: chainstackApi.limit,
      remaining: chainstackApi.remaining,
      unit: "RU",
      status: chainstackApi.status || "OK",
      latencyMs: chainstackProbe.latencyMs,
      detail: chainstackApi.detail || "",
      source: "platform_api",
    };
    if (chainstackProbe.status === "FULL") {
      chainstack.status = "FULL";
      chainstack.percentUsed = Math.max(chainstack.percentUsed ?? 0, 100);
    }
  } else {
    chainstack = fromProbe(
      "Chainstack",
      "mint",
      rpcLabels.mint,
      chainstackProbe,
      chainstackApi?.detail
        ? chainstackApi.detail
        : "set CHAINSTACK_API_KEY for exact RU %"
    );
  }

  return {
    at: new Date().toISOString(),
    alchemy,
    chainstack,
  };
}

export function formatRpcQuotaReport(report: RpcQuotaReport): string {
  const line = (q: ProviderQuota): string[] => {
    const pct =
      q.percentUsed != null
        ? `<b>${q.percentUsed}%</b> used`
        : `<b>unknown %</b>`;
    const statusEmoji =
      q.status === "FULL"
        ? "🔴"
        : q.status === "RATE_LIMITED"
          ? "🟠"
          : q.status === "OK"
            ? "🟢"
            : "⚪";
    return [
      `${statusEmoji} <b>${q.provider}</b> (${q.role})`,
      `<b>Limit:</b> ${pct}${
        q.used != null && q.limit != null
          ? ` · ${formatNum(q.used)} / ${formatNum(q.limit)} ${q.unit || ""}`
          : ""
      }`,
      `<b>Status:</b> ${q.status}`,
      q.latencyMs != null ? `<b>Latency:</b> ${q.latencyMs}ms` : "",
      `<b>RPC:</b> <code>${esc(q.rpcLabel)}</code>`,
      `<b>Detail:</b> ${esc(q.detail.slice(0, 200))}`,
      ``,
    ].filter((x) => x !== "");
  };

  return [
    `<b>📊 RPC quota report</b>`,
    `<i>${esc(report.at)} · every 6h</i>`,
    ``,
    ...line(report.alchemy),
    ...line(report.chainstack),
    `<i>Exact % needs ALCHEMY_ADMIN_KEY + CHAINSTACK_API_KEY in .env</i>`,
  ].join("\n");
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
