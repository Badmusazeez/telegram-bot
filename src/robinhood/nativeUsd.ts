/**
 * Ink native gas is ETH. USD via Ink Blockscout coin_price.
 */

const BLOCKSCOUT_STATS = "https://explorer.inkonchain.com/api/v2/stats";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let cached: { usd: number; atMs: number } | null = null;
const CACHE_MS = 60_000;

export function resetNativeUsdCache(): void {
  cached = null;
}

/** ETH/USD for native gas. Cached ~60s. Null if fetch fails. */
export async function fetchNativeUsdPrice(): Promise<number | null> {
  if (cached && Date.now() - cached.atMs < CACHE_MS) {
    return cached.usd;
  }
  try {
    const res = await fetch(BLOCKSCOUT_STATS, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        accept: "application/json",
        "user-agent": UA,
        referer: "https://explorer.inkonchain.com/",
      },
    });
    if (!res.ok) return cached?.usd ?? null;
    const body = (await res.json()) as { coin_price?: string | null };
    const usd = Number(body.coin_price);
    if (!Number.isFinite(usd) || usd <= 0) return cached?.usd ?? null;
    cached = { usd, atMs: Date.now() };
    return usd;
  } catch {
    return cached?.usd ?? null;
  }
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

/** e.g. `0.001234 ETH ($3.10)` */
export function formatNativeWithUsd(
  nativeAmount: number,
  usdPrice: number | null,
  symbol = "ETH"
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
