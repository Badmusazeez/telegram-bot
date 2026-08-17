import { formatEther } from "ethers";
import { config } from "../config";
import { getState, rememberTxFast } from "../store/state";
import type { NftPurchase } from "../types";
import type { PurchaseHandler } from "./monitor";

const ZERO = "0x0000000000000000000000000000000000000000";

/** SeaDrop / common free-mint selectors seen on Robinhood. */
const MINT_SELECTORS = new Set([
  "0x161ac21f", // SeaDrop mintPublic (RH)
  "0x9b4f3f25", // SeaDrop mintPublic (legacy)
  "0x26db764c",
  "0xa0712d68", // mint(uint256)
  "0x94bf804d",
  "0x40c10f19",
  "0x1249c58b", // mint()
  "0x2db11544",
]);

type BsAddress = { hash?: string };
type BsTx = {
  hash?: string;
  timestamp?: string;
  method?: string;
  value?: string;
  status?: string;
  result?: string;
  raw_input?: string;
  from?: BsAddress;
  to?: BsAddress;
  block?: number | null;
  block_number?: number | null;
};

/** Per-wallet high-water mark (ms). */
const lastSeenTsByWallet = new Map<string, number>();
const BOOT_LOOKBACK_MS = 30 * 60_000;

let lastOkAt: string | null = null;
let lastError: string | null = null;
let lastHitTx: string | null = null;
let tickCount = 0;

export function getBlockscoutStatus(): {
  lastOkAt: string | null;
  lastError: string | null;
  lastHitTx: string | null;
  tracked: number;
} {
  return {
    lastOkAt,
    lastError,
    lastHitTx,
    tracked: getState().trackedWallets.length,
  };
}

function explorerApiBase(): string {
  const txUrl = config.chain.explorerTxUrl("0x");
  const origin = txUrl.replace(/\/tx\/0x$/i, "");
  return `${origin}/api/v2`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      lastError = `${res.status}`;
      console.warn(`[blockscout] ${res.status} ${url.slice(0, 120)}`);
      return null;
    }
    lastOkAt = new Date().toISOString();
    lastError = null;
    return (await res.json()) as T;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[blockscout] fetch failed: ${lastError}`);
    return null;
  }
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function valueRobinhood(raw?: string): number {
  if (!raw || raw === "0") return 0;
  try {
    return Number(formatEther(BigInt(raw)));
  } catch {
    return 0;
  }
}

function decodeNftFromCalldata(input?: string): string | null {
  const data = (input || "").toLowerCase();
  if (data.length < 10 + 64) return null;
  const selector = data.slice(0, 10);
  if (selector === "0x161ac21f" || selector === "0x9b4f3f25") {
    return `0x${data.slice(10 + 24, 10 + 64)}`;
  }
  return null;
}

function isMintLikeTx(tx: BsTx): boolean {
  const status = (tx.status || "").toLowerCase();
  const result = (tx.result || "").toLowerCase();
  if (status && status !== "ok" && status !== "success") return false;
  if (result && result !== "success" && result !== "ok") return false;

  const method = (tx.method || "").toLowerCase();
  if (
    method.includes("mint") ||
    method.includes("claim") ||
    method.includes("drop")
  ) {
    return true;
  }
  const sel = (tx.raw_input || "").slice(0, 10).toLowerCase();
  return MINT_SELECTORS.has(sel);
}

async function fetchRecentTxs(address: string): Promise<BsTx[]> {
  const base = explorerApiBase();
  const data = await fetchJson<{ items?: BsTx[] }>(
    `${base}/addresses/${address}/transactions`
  );
  return data?.items ?? [];
}

/**
 * Fast path: poll all tracked wallets' recent txs in parallel.
 * One purchase per mint tx (not per token).
 */
export async function scanBlockscoutMints(): Promise<NftPurchase[]> {
  const state = getState();
  if (state.trackedWallets.length === 0) {
    return [];
  }

  const wallets = state.trackedWallets.map((w) => w.address.toLowerCase());
  const purchases: NftPurchase[] = [];

  const results = await Promise.all(
    wallets.map(async (buyer) => {
      const since =
        lastSeenTsByWallet.get(buyer) ?? Date.now() - BOOT_LOOKBACK_MS;
      let maxSeen = since;
      const found: NftPurchase[] = [];

      const txs = await fetchRecentTxs(buyer);
      for (const tx of txs) {
        const tsMs = parseIsoMs(tx.timestamp);
        if (tsMs > 0) {
          if (tsMs > maxSeen) maxSeen = tsMs;
          if (tsMs <= since) continue;
        }

        const from = (tx.from?.hash || "").toLowerCase();
        if (from && from !== buyer) continue;
        if (!isMintLikeTx(tx)) continue;

        const value = valueRobinhood(tx.value);
        if (state.freeMintsOnly && value > 0) continue;

        const txHash = (tx.hash || "").toLowerCase();
        const input = (tx.raw_input || "").toLowerCase();
        const to = (tx.to?.hash || "").toLowerCase();
        const nft = decodeNftFromCalldata(input) || to || ZERO;
        if (!txHash) continue;

        // Shared dedupe key with Alchemy monitor (one hit per mint tx).
        const dedupeKey = `${txHash}:${nft}:mint`;
        if (!rememberTxFast(dedupeKey)) continue;

        found.push({
          txHash,
          buyer,
          seller: ZERO,
          contract: nft,
          tokenId: "0",
          valueRobinhood: value,
          blockNumber: Number(tx.block ?? tx.block_number ?? 0),
          timestamp: tsMs
            ? Math.floor(tsMs / 1000)
            : Math.floor(Date.now() / 1000),
          marketplace: "free-mint",
          isFreeMint: true,
          isPaid: value > 0,
          sourceTo: to || undefined,
          sourceData: input || undefined,
        });
        lastHitTx = txHash;
      }

      lastSeenTsByWallet.set(buyer, maxSeen);
      return found;
    })
  );

  for (const batch of results) purchases.push(...batch);
  return purchases;
}

export async function startBlockscoutWatcher(
  onPurchase: PurchaseHandler
): Promise<() => void> {
  let stopped = false;
  let scanning = false;

  const wallets = getState().trackedWallets;
  console.log(
    `[blockscout] starting — tracked=${wallets.length}` +
      (wallets.length
        ? ` [${wallets.map((w) => w.address.slice(0, 8) + "…").join(", ")}]`
        : " ⚠️ NONE — use /track 0x…")
  );

  const fire = (purchase: NftPurchase) => {
    // Parallel — never serialize free-mint copies behind each other.
    void (async () => {
      if (stopped) return;
      try {
        await onPurchase(purchase);
      } catch (err) {
        console.error(
          `[blockscout] handler failed for ${purchase.txHash}:`,
          err instanceof Error ? err.message : err
        );
      }
    })();
  };

  const tick = async () => {
    if (stopped || scanning) return;
    scanning = true;
    tickCount += 1;
    try {
      const purchases = await scanBlockscoutMints();
      if (purchases.length > 0) {
        console.log(
          `[blockscout] detected ${purchases.length} mint tx(s): ${purchases
            .map((p) => p.txHash.slice(0, 10))
            .join(", ")}`
        );
        for (const p of purchases) fire(p);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[blockscout] scan failed:`, lastError);
    } finally {
      scanning = false;
    }
  };

  void tick();
  // Aggressive poll — RH free mints sell out in seconds.
  const intervalMs = 1_500;
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  console.log(
    `[blockscout] FAST watcher ${explorerApiBase()} every ${intervalMs}ms (lookback ${BOOT_LOOKBACK_MS / 1000}s)`
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
