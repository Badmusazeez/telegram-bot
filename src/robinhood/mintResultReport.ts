/**
 * Classify per-wallet mint outcomes for Telegram reporting.
 */

export type MintFailBucket =
  | "success"
  | "rpc_rate_limited"
  | "opensea_rate_limited"
  | "contract_rejected"
  | "empty"
  | "low_gas"
  | "ineligible"
  | "other";

export type MintWalletOutcome = {
  address: string;
  bucket: MintFailBucket;
  ok: boolean;
  txHash?: string;
  error?: string;
};

export type MintResultStats = {
  configured: number;
  fundedReady: number;
  empty: number;
  lowGas: number;
  ineligible: number;
  submitted: number;
  successful: number;
  rpcRateLimited: number;
  openSeaRateLimited: number;
  contractRejected: number;
  other: number;
};

export function classifyMintError(error?: string): MintFailBucket {
  const lower = (error || "").toLowerCase();
  if (!lower) return "other";
  if (/opensea.*429|http 429|resource rate limit|opensea rate/i.test(lower)) {
    return "opensea_rate_limited";
  }
  if (
    /-32005|rps limit|try_again_in|too many requests|rate limit|429|throughput/i.test(
      lower
    )
  ) {
    return "rpc_rate_limited";
  }
  if (
    /empty wallet|0 balance|insufficient gas|low native|low.?gas/i.test(lower)
  ) {
    return /empty|0 balance/.test(lower) ? "empty" : "low_gas";
  }
  if (
    /not eligible|already minted|allowlist|whitelist|proof|max per wallet/i.test(
      lower
    )
  ) {
    return "ineligible";
  }
  if (
    /reverted|execution reverted|sold out|not started|ended|payment required|wrong calldata/i.test(
      lower
    ) &&
    !/missing revert data/.test(lower)
  ) {
    return "contract_rejected";
  }
  // missing revert data alone is ambiguous — count as other unless clearly contract
  return "other";
}

export function buildMintResultStats(params: {
  configured: number;
  fundedReady: number;
  empty: number;
  lowGas?: number;
  ineligible?: number;
  outcomes: MintWalletOutcome[];
}): MintResultStats {
  const submitted = params.outcomes.length;
  const successful = params.outcomes.filter((o) => o.ok).length;
  let rpcRateLimited = 0;
  let openSeaRateLimited = 0;
  let contractRejected = 0;
  let other = 0;
  for (const o of params.outcomes) {
    if (o.ok) continue;
    const b = o.bucket !== "other" ? o.bucket : classifyMintError(o.error);
    if (b === "rpc_rate_limited") rpcRateLimited += 1;
    else if (b === "opensea_rate_limited") openSeaRateLimited += 1;
    else if (b === "contract_rejected") contractRejected += 1;
    else other += 1;
  }
  return {
    configured: params.configured,
    fundedReady: params.fundedReady,
    empty: params.empty,
    lowGas: params.lowGas ?? 0,
    ineligible: params.ineligible ?? 0,
    submitted,
    successful,
    rpcRateLimited,
    openSeaRateLimited,
    contractRejected,
    other,
  };
}

export function formatMintResultStats(stats: MintResultStats): string {
  const lines = [
    `Mint result:`,
    `${stats.configured} configured`,
    `${stats.fundedReady} funded/ready`,
    stats.empty ? `${stats.empty} empty` : "",
    stats.lowGas ? `${stats.lowGas} low-gas` : "",
    stats.ineligible ? `${stats.ineligible} ineligible` : "",
    `${stats.submitted} submitted`,
    `${stats.successful} successful`,
    stats.rpcRateLimited ? `${stats.rpcRateLimited} RPC rate-limited` : "",
    stats.openSeaRateLimited
      ? `${stats.openSeaRateLimited} OpenSea rate-limited`
      : "",
    stats.contractRejected
      ? `${stats.contractRejected} contract rejected`
      : "",
    stats.other ? `${stats.other} other` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export function formatMintResultHtml(stats: MintResultStats): string {
  return [
    `<b>Mint result</b>`,
    `<b>Total wallets:</b> ${stats.configured}`,
    `<b>Funded/ready:</b> ${stats.fundedReady}`,
    `<b>Empty:</b> ${stats.empty}`,
    stats.lowGas ? `<b>Low gas:</b> ${stats.lowGas}` : "",
    stats.ineligible ? `<b>Ineligible:</b> ${stats.ineligible}` : "",
    `<b>Submitted:</b> ${stats.submitted}`,
    `<b>Successful:</b> ${stats.successful}`,
    `<b>RPC rate-limited:</b> ${stats.rpcRateLimited}`,
    `<b>OpenSea rate-limited:</b> ${stats.openSeaRateLimited}`,
    `<b>Contract rejected:</b> ${stats.contractRejected}`,
    `<b>Other:</b> ${stats.other}`,
  ]
    .filter(Boolean)
    .join("\n");
}
