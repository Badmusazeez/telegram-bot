/**
 * Dynamic mint gas limits — estimate-driven with safety ceiling.
 * Never use a blind hardcoded gasLimit as a fake eth_estimateGas result.
 */

export type MintGasResolution =
  | {
      ok: true;
      estimated: bigint;
      gasLimit: bigint;
      marginPct: number;
      ceiling: number;
    }
  | {
      ok: false;
      estimated: bigint;
      gasLimit: bigint;
      marginPct: number;
      ceiling: number;
      reason: string;
    };

/** Default absolute ceiling for complex mints. */
export const DEFAULT_MAX_MINT_GAS_LIMIT = 2_500_000;

/** Safety margin on top of eth_estimateGas (percent). */
export const DEFAULT_GAS_MARGIN_PCT = 20;

/**
 * Resolve final gasLimit from a real eth_estimateGas result.
 * - Rejects if estimate alone exceeds the absolute ceiling.
 * - Applies marginPct, then caps gasLimit at the ceiling.
 */
export function resolveMintGasLimit(params: {
  estimated: bigint;
  ceiling: number;
  marginPct?: number;
}): MintGasResolution {
  const marginPct =
    params.marginPct != null && Number.isFinite(params.marginPct)
      ? Math.max(0, Math.min(50, Math.floor(params.marginPct)))
      : DEFAULT_GAS_MARGIN_PCT;
  const ceiling =
    Number.isFinite(params.ceiling) && params.ceiling > 0
      ? Math.floor(params.ceiling)
      : DEFAULT_MAX_MINT_GAS_LIMIT;

  const estimated = params.estimated;
  if (estimated <= 0n) {
    return {
      ok: false,
      estimated,
      gasLimit: 0n,
      marginPct,
      ceiling,
      reason: `invalid estimateGas ${estimated}`,
    };
  }

  if (estimated > BigInt(ceiling)) {
    return {
      ok: false,
      estimated,
      gasLimit: 0n,
      marginPct,
      ceiling,
      reason: `estimateGas ${estimated} exceeds MAX_MINT_GAS_LIMIT ${ceiling} (abnormal)`,
    };
  }

  const withMargin = (estimated * BigInt(100 + marginPct)) / 100n;
  const gasLimit = withMargin > BigInt(ceiling) ? BigInt(ceiling) : withMargin;

  return {
    ok: true,
    estimated,
    gasLimit,
    marginPct,
    ceiling,
  };
}

/** Detect mint function selector for diagnostics. */
export function mintSelectorLabel(data: string | null | undefined): string {
  const sel = (data || "").slice(0, 10).toLowerCase();
  const known: Record<string, string> = {
    "0x161ac21f": "SeaDrop.mintPublic",
    "0x9b4f3f25": "SeaDrop.mintPublic(legacy)",
    "0xa0712d68": "mint(uint256)",
    "0x1249c58b": "mint()",
    "0x8ab53447": "mintFree()",
    "0x40c10f19": "mint(address,uint256)",
    "0x94bf804d": "mint(address,uint256)",
    "0x2db11544": "claim(uint256)",
    "0x26db764c": "mintPublic?",
  };
  return known[sel] || sel || "(no data)";
}
