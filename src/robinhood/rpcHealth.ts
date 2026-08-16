export type TrackRpcIssue = {
  kind: "quota" | "rate_limit" | "unavailable";
  message: string;
};

/** Detect Alchemy / RPC "full" or throttled tracker errors. */
export function classifyTrackRpcError(err: unknown): TrackRpcIssue | null {
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
    lower.includes("402")
  ) {
    return { kind: "quota", message: msg.slice(0, 280) };
  }

  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate exceeded") ||
    lower.includes("request limit")
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

export function formatTrackRpcIssue(issue: TrackRpcIssue): string {
  const title =
    issue.kind === "quota"
      ? "Tracker RPC quota / capacity full"
      : issue.kind === "rate_limit"
        ? "Tracker RPC rate-limited"
        : "Tracker RPC unavailable";

  return [
    `<b>⚠️ ${title}</b>`,
    ``,
    `Whale tracking may miss free mints until this clears.`,
    `<b>Detail:</b> <code>${escapeHtml(issue.message)}</code>`,
    ``,
    `If TRACK_RPC_BACKUP_URL is set, bot will failover then return to Alchemy when healthy.`,
  ].join("\n");
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
