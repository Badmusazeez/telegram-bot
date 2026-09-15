/**
 * Arc native gas is USDC (~$1). Prefer 1:1 USD; optional live quote later.
 */

let cached: { usd: number; atMs: number } | null = null;
const CACHE_MS = 300_000;

export function resetNativeUsdCache(): void {
  cached = null;
}

/** USDC/USD ≈ 1. Cached so callers share one value. */
export async function fetchNativeUsdPrice(): Promise<number | null> {
  if (cached && Date.now() - cached.atMs < CACHE_MS) {
    return cached.usd;
  }
  cached = { usd: 1, atMs: Date.now() };
  return 1;
}

export function formatUsd(amountUsd: number): string {
  if (!Number.isFinite(amountUsd)) return "$?";
  const abs = Math.abs(amountUsd);
  if (abs >= 1000) return `$${amountUsd.toFixed(0)}`;
  if (abs >= 1) return `$${amountUsd.toFixed(2)}`;
  if (abs >= 0.01) return `$${amountUsd.toFixed(2)}`;
  if (abs > 0) return `$${amountUsd.toFixed(4)}`;
  return "$0.00";
}

/** e.g. `12.500000 USDC ($12.50)` */
export function formatNativeWithUsd(
  nativeAmount: number,
  usdPrice: number | null,
  symbol = "USDC"
): string {
  if (!Number.isFinite(nativeAmount)) {
    return `? ${symbol}`;
  }
  const amt =
    nativeAmount >= 1
      ? nativeAmount.toFixed(4)
      : nativeAmount.toFixed(6);
  if (usdPrice == null || !Number.isFinite(usdPrice) || usdPrice <= 0) {
    return `${amt} ${symbol}`;
  }
  return `${amt} ${symbol} (${formatUsd(nativeAmount * usdPrice)})`;
}

export function nativeToUsd(
  nativeAmount: number,
  usdPrice: number | null
): number | null {
  if (
    !Number.isFinite(nativeAmount) ||
    usdPrice == null ||
    !Number.isFinite(usdPrice) ||
    usdPrice <= 0
  ) {
    return null;
  }
  return nativeAmount * usdPrice;
}
