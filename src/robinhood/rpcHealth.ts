import { config } from "../config";

export type RpcIssueKind = "quota" | "rate_limit" | "unavailable";

export type RpcIssue = {
  kind: RpcIssueKind;
  message: string;
};

export type RpcRole = "track" | "mint";

/** Detect Alchemy / Chainstack / RPC "full" or throttled errors. */
export function classifyRpcError(err: unknown): RpcIssue | null {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Don't treat the known 10-block free-tier range rule as "RPC full".
  if (lower.includes("10 block") || lower.includes("block range")) {
    return null;
  }

  if (
    lower.includes("compute units") ||
    lower.includes("monthly capacity") ||
    lower.includes("exceeded its compute") ||
    lower.includes("cu limit") ||
    lower.includes("throughput") ||
    lower.includes("capacity limit") ||
    lower.includes("quota") ||
    lower.includes("payment required") ||
    lower.includes("402") ||
    lower.includes("credit") ||
    lower.includes("insufficient funds for") && lower.includes("plan")
  ) {
    return { kind: "quota", message: msg.slice(0, 280) };
  }

  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate exceeded") ||
    lower.includes("request limit") ||
    lower.includes("limit exceeded") ||
    lower.includes("over rate")
  ) {
    return { kind: "rate_limit", message: msg.slice(0, 280) };
  }

  if (
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable")
  ) {
    return { kind: "unavailable", message: msg.slice(0, 280) };
  }

  return null;
}

/** @deprecated use classifyRpcError */
export function classifyTrackRpcError(err: unknown): RpcIssue | null {
  return classifyRpcError(err);
}

export type TrackRpcIssue = RpcIssue;

function providerNameForRole(role: RpcRole): "ALCHEMY" | "CHAINSTACK" | "RPC" {
  const url =
    role === "track" ? config.trackRpcUrl : config.mintRpcUrl;
  const lower = url.toLowerCase();
  if (lower.includes("alchemy")) return "ALCHEMY";
  if (lower.includes("chainstack")) return "CHAINSTACK";
  return "RPC";
}

/**
 * Clear Telegram alert when Alchemy / Chainstack hits its limit.
 * Example: CHANGE YOUR ALCHEMY RPC, IT HAS REACHED ITS LIMIT
 */
export function formatRpcLimitAlert(
  role: RpcRole,
  issue: RpcIssue
): string {
  const provider = providerNameForRole(role);
  const roleLabel = role === "track" ? "TRACKING (Alchemy)" : "MINTING (Chainstack)";

  return [
    `<b>🚨 CHANGE YOUR ${provider} RPC, IT HAS REACHED ITS LIMIT</b>`,
    ``,
    `<b>Which:</b> ${roleLabel}`,
    `<b>Problem:</b> ${
      issue.kind === "quota"
        ? "quota / capacity / CU limit"
        : issue.kind === "rate_limit"
          ? "rate limit (429)"
          : "RPC unavailable / overloaded"
    }`,
    `<b>Detail:</b> <code>${escapeHtml(issue.message)}</code>`,
    ``,
    role === "track"
      ? `Update <code>TRACK_RPC_URL</code> / <code>ALCHEMY_API_KEY</code> in VPS <code>.env</code>, then: <code>pm2 restart robinhood-nft-bot --update-env</code>`
      : `Update <code>MINT_RPC_URL</code> in VPS <code>.env</code>, then: <code>pm2 restart robinhood-nft-bot --update-env</code>`,
    ``,
    `Blockscout detection may still catch free mints while you swap the RPC.`,
  ].join("\n");
}

/** @deprecated use formatRpcLimitAlert("track", issue) */
export function formatTrackRpcIssue(issue: RpcIssue): string {
  return formatRpcLimitAlert("track", issue);
}

export function formatTrackRpcSwitch(event: {
  from: string;
  to: string;
  reason: string;
}): string {
  if (event.to === "backup") {
    return [
      `<b>🔀 Tracker failover</b>`,
      `Alchemy primary is slow/down → using <b>backup RPC</b>.`,
      `<b>Reason:</b> <code>${escapeHtml(event.reason.slice(0, 200))}</code>`,
      `Bot will auto-switch back to Alchemy when it recovers.`,
    ].join("\n");
  }
  return [
    `<b>✅ Tracker recovered</b>`,
    `Switched back to <b>Alchemy</b> tracker.`,
    `<b>Detail:</b> <code>${escapeHtml(event.reason.slice(0, 200))}</code>`,
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
