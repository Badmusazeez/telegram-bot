import { config } from "../config";

export type RpcIssueKind = "quota" | "rate_limit" | "unavailable";

export type RpcIssue = {
  kind: RpcIssueKind;
  message: string;
};

export type RpcRole = "track" | "mint";

/**
 * Strip raw tx hex dumps before classifying — otherwise substrings like
 * "402" inside RLP/calldata falsely look like HTTP 402 / quota errors.
 */
function sanitizeRpcMessage(raw: string): string {
  return raw
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/data=["']?0x[0-9a-fA-F]+["']?/gi, "data=<hex>")
    .replace(/0x[0-9a-fA-F]{64,}/g, "0x…")
    .slice(0, 400);
}

/** Detect Alchemy / Chainstack / RPC "full" or throttled errors. */
export function classifyRpcError(err: unknown): RpcIssue | null {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = sanitizeRpcMessage(raw);
  const lower = msg.toLowerCase();

  // Normal mint/tx failures — never treat as RPC quota.
  if (
    lower.includes("nonce has already been used") ||
    lower.includes("nonce too low") ||
    lower.includes("already known") ||
    lower.includes("replacement transaction underpriced") ||
    lower.includes("execution reverted") ||
    /\breverted\b/.test(lower) ||
    lower.includes("insufficient funds") ||
    lower.includes("intrinsic gas too low")
  ) {
    return null;
  }

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
    /\bhttp\s*402\b/.test(lower) ||
    /\bstatus(?:\s*code)?\s*402\b/.test(lower) ||
    lower.includes("out of credits") ||
    lower.includes("no credits") ||
    (lower.includes("insufficient funds for") && lower.includes("plan"))
  ) {
    return { kind: "quota", message: msg.slice(0, 220) };
  }

  if (
    /\b429\b/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate exceeded") ||
    lower.includes("request limit") ||
    lower.includes("limit exceeded") ||
    lower.includes("over rate") ||
    lower.includes("try_again_in")
  ) {
    return { kind: "rate_limit", message: msg.slice(0, 220) };
  }

  if (
    /\b503\b/.test(lower) ||
    /\b502\b/.test(lower) ||
    lower.includes("overloaded") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable")
  ) {
    return { kind: "unavailable", message: msg.slice(0, 220) };
  }

  return null;
}

export { isNonArchiveRpcError, NON_ARCHIVE_LOOKBACK_BLOCKS } from "./rpcArchive";

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
      ? `Update <code>TRACK_RPC_URL</code> / <code>ALCHEMY_API_KEY</code> in VPS <code>.env</code> (or rely on <code>TRACK_RPC_BACKUP_URL</code> Chainstack failover), then: <code>pm2 restart robinhood-nft-bot --update-env</code>`
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
