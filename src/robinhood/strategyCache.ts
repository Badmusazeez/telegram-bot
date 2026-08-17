/**
 * Fast-path cache: remember which mint strategy worked for a contract
 * so the next hit skips rediscovery.
 *
 * Does NOT change SeaDrop blast mechanics — only prioritizes strategy order.
 */

export type StrategyKind = "seadrop" | "opensea" | "replay" | "public";

export type CachedMintStrategy = {
  contract: string;
  kind: StrategyKind;
  /** Best known quantity that worked (max mint). */
  quantity?: number;
  /** Destination (SeaDrop / NFT / multicall). */
  to?: string;
  hits: number;
  updatedAt: number;
};

const cache = new Map<string, CachedMintStrategy>();
const MAX_ENTRIES = 200;

function key(contract: string): string {
  return contract.toLowerCase();
}

export function rememberMintStrategy(entry: {
  contract: string;
  kind: StrategyKind;
  quantity?: number;
  to?: string;
}): void {
  const k = key(entry.contract);
  if (!k.startsWith("0x") || k.length !== 42) return;
  const prev = cache.get(k);
  cache.set(k, {
    contract: k,
    kind: entry.kind,
    quantity: entry.quantity ?? prev?.quantity,
    to: (entry.to || prev?.to || "").toLowerCase() || undefined,
    hits: (prev?.hits ?? 0) + 1,
    updatedAt: Date.now(),
  });
  if (cache.size > MAX_ENTRIES) {
    // Drop oldest
    const oldest = [...cache.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt
    )[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

export function getCachedMintStrategy(
  contract: string
): CachedMintStrategy | null {
  return cache.get(key(contract)) ?? null;
}

/** Prefer known-good strategy kinds first; always keep full set. */
export function orderedStrategyKinds(
  contract: string,
  available: StrategyKind[]
): StrategyKind[] {
  const cached = getCachedMintStrategy(contract);
  if (!cached || !available.includes(cached.kind)) {
    return available;
  }
  return [
    cached.kind,
    ...available.filter((k) => k !== cached.kind),
  ];
}

/** Test helper */
export function clearMintStrategyCache(): void {
  cache.clear();
}

export function mintStrategyCacheSize(): number {
  return cache.size;
}
