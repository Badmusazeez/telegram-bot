/** Detect Chainstack (and similar) "no archive" plan errors. */
export function isNonArchiveRpcError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  return (
    lower.includes("archive, debug and trace") ||
    lower.includes("not available on your current plan") ||
    lower.includes("requires archive") ||
    /-32002/.test(lower)
  );
}

/**
 * Max blocks behind tip that non-archive Chainstack nodes can serve for
 * eth_getLogs / eth_getBlockByNumber(full). Empirically ~100 on Developer.
 */
export const NON_ARCHIVE_LOOKBACK_BLOCKS = 80;
