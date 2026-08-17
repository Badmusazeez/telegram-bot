import { config } from "../config";
import { getState, rememberTxFast } from "../store/state";
import type { NftPurchase } from "../types";
import {
  ZERO_ADDRESS,
  decodeNftFromMintCalldata,
  isMintLikeCalldata,
  valueFromWei,
} from "./mintDetect";
import type { PurchaseHandler } from "./monitor";

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
  tickCount: number;
} {
  return {
    lastOkAt,
    lastError,
    lastHitTx,
    tracked: getState().trackedWallets.length,
    tickCount,
  };
}

function explorerApiBase(): string {
  const txUrl = config.chain.explorerTxUrl("0x");
  const origin = txUrl.replace(/\/tx\/0x$/i, "");
  return `${origin}/api/v2`;
}

async function fetchJsonOnce<T>(url: string): Promise<{
  ok: boolean;
  status: number;
  data: T | null;
  err?: string;
}> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, err: `${res.status}` };
    }
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      err: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Retry on 5xx / timeout — Blockscout flaps under load. */
async function fetchJson<T>(url: string): Promise<T | null> {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    const result = await fetchJsonOnce<T>(url);
    if (result.ok && result.data) {
      lastOkAt = new Date().toISOString();
      lastError = null;
      return result.data;
    }
    lastError = result.err || `status ${result.status}`;
    const retryable =
      result.status === 0 ||
      result.status === 429 ||
      result.status >= 500;
    if (!retryable || i === attempts - 1) {
      if (i === 0 || !retryable) {
        console.warn(`[blockscout] ${lastError} ${url.slice(0, 100)}`);
      }
      return null;
    }
    await sleep(150 * (i + 1));
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function isMintLikeTx(tx: BsTx): boolean {
  const status = (tx.status || "").toLowerCase();
  const result = (tx.result || "").toLowerCase();
  if (status && status !== "ok" && status !== "success") return false;
  if (result && result !== "success" && result !== "ok") return false;

  return isMintLikeCalldata(
    tx.to?.hash,
    tx.raw_input,
    tx.method
  );
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

        const value = valueFromWei(tx.value);
        if (state.freeMintsOnly && value > 0) continue;

        const txHash = (tx.hash || "").toLowerCase();
        const input = (tx.raw_input || "").toLowerCase();
        const to = (tx.to?.hash || "").toLowerCase();
        const nft = decodeNftFromMintCalldata(input) || to || ZERO_ADDRESS;
        if (!txHash) continue;

        // Shared dedupe key with Alchemy / pending / tip-scan (one hit per mint tx).
        const dedupeKey = `${txHash}:${nft}:mint`;
        if (!rememberTxFast(dedupeKey)) continue;

        found.push({
          txHash,
          buyer,
          seller: ZERO_ADDRESS,
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
    `[blockscout] FAST watcher ${explorerApiBase()} every ${intervalMs}ms (lookback ${BOOT_LOOKBACK_MS / 1000}s, retries=3)`
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
