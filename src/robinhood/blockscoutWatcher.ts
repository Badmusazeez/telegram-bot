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
  "0x26db764c", // mint{value,to,qty} variants
  "0xa0712d68", // mint(uint256)
  "0x94bf804d", // mint(uint256,address)
  "0x40c10f19", // mint(address,uint256)
  "0x1249c58b", // mint()
  "0x2db11544", // claim variants
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
type BsToken = {
  address_hash?: string;
  address?: string;
  name?: string;
};
type BsTransfer = {
  transaction_hash?: string;
  block_number?: number;
  timestamp?: string;
  type?: string;
  from?: BsAddress;
  to?: BsAddress;
  token?: BsToken;
  total?: { token_id?: string; value?: string };
};

/** Per-wallet high-water mark (ms). */
const lastSeenTsByWallet = new Map<string, number>();
/** Boot lookback — long enough to catch mints during slow Alchemy startup. */
const BOOT_LOOKBACK_MS = 20 * 60_000;

let lastOkAt: string | null = null;
let lastError: string | null = null;
let lastHitTx: string | null = null;

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
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      lastError = `${res.status} ${url}`;
      console.warn(`[blockscout] ${lastError}`);
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
  // SeaDrop mintPublic(nftContract, ...) — first arg is the collection.
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

async function fetchTokenTransfers(address: string): Promise<BsTransfer[]> {
  const base = explorerApiBase();
  // Prefer ERC-721 only — combined type filter sometimes 500s on Blockscout.
  const primary = await fetchJson<{ items?: BsTransfer[] }>(
    `${base}/addresses/${address}/token-transfers?type=ERC-721`
  );
  if (primary?.items) return primary.items;
  const fallback = await fetchJson<{ items?: BsTransfer[] }>(
    `${base}/addresses/${address}/token-transfers?type=ERC-1155`
  );
  return fallback?.items ?? [];
}

/**
 * Prefer one purchase per mint tx (not per token) so copy/Telegram fire once, fast.
 */
export async function scanBlockscoutMints(): Promise<NftPurchase[]> {
  const state = getState();
  if (state.trackedWallets.length === 0) {
    return [];
  }

  const purchases: NftPurchase[] = [];
  const wallets = state.trackedWallets.map((w) => w.address.toLowerCase());

  for (const buyer of wallets) {
    const since =
      lastSeenTsByWallet.get(buyer) ?? Date.now() - BOOT_LOOKBACK_MS;
    let maxSeen = since;
    const seenTxThisScan = new Set<string>();

    // 1) Primary: wallet transactions (catches SeaDrop mintPublic immediately)
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
      if (!txHash || seenTxThisScan.has(txHash)) continue;
      seenTxThisScan.add(txHash);

      const nft =
        decodeNftFromCalldata(tx.raw_input) ||
        (tx.to?.hash || "").toLowerCase() ||
        ZERO;

      // Dedupe with Alchemy monitor (token-level keys still unique via :0)
      const dedupeKey = `${txHash}:${nft}:mint`;
      if (!rememberTxFast(dedupeKey)) continue;

      const blockNumber = Number(tx.block ?? tx.block_number ?? 0);
      purchases.push({
        txHash,
        buyer,
        seller: ZERO,
        contract: nft,
        tokenId: "0",
        valueRobinhood: value,
        blockNumber,
        timestamp: tsMs
          ? Math.floor(tsMs / 1000)
          : Math.floor(Date.now() / 1000),
        marketplace: "free-mint",
        isFreeMint: true,
        isPaid: value > 0,
      });
      lastHitTx = txHash;
    }

    // 2) Backup: token mint transfers (covers mints not labeled mint* in method)
    const transfers = await fetchTokenTransfers(buyer);
    for (const item of transfers) {
      const tsMs = parseIsoMs(item.timestamp);
      if (tsMs > 0) {
        if (tsMs > maxSeen) maxSeen = tsMs;
        if (tsMs <= since) continue;
      }

      const from = (item.from?.hash || "").toLowerCase();
      const to = (item.to?.hash || "").toLowerCase();
      const isMint =
        from === ZERO || (item.type || "").toLowerCase() === "token_minting";
      if (!isMint || to !== buyer) continue;

      const txHash = (item.transaction_hash || "").toLowerCase();
      const contract = (
        item.token?.address_hash ||
        item.token?.address ||
        ""
      ).toLowerCase();
      if (!txHash || !contract) continue;
      if (seenTxThisScan.has(txHash)) continue;
      seenTxThisScan.add(txHash);

      // Skip if tx-path already reserved this mint
      if (!rememberTxFast(`${txHash}:${contract}:mint`)) continue;

      if (state.freeMintsOnly) {
        // Assume free when Transfer from zero; paid mints still mint from zero
        // but tx path above already filtered value>0 when method is mint-like.
      }

      purchases.push({
        txHash,
        buyer,
        seller: ZERO,
        contract,
        tokenId: item.total?.token_id ?? "0",
        valueRobinhood: 0,
        blockNumber: Number(item.block_number || 0),
        timestamp: tsMs
          ? Math.floor(tsMs / 1000)
          : Math.floor(Date.now() / 1000),
        marketplace: "free-mint",
        collectionName: item.token?.name,
        isFreeMint: true,
        isPaid: false,
      });
      lastHitTx = txHash;
    }

    lastSeenTsByWallet.set(buyer, maxSeen);
  }

  return purchases;
}

export async function startBlockscoutWatcher(
  onPurchase: PurchaseHandler
): Promise<() => void> {
  let stopped = false;
  let scanning = false;
  let handleTail: Promise<void> = Promise.resolve();

  const wallets = getState().trackedWallets;
  console.log(
    `[blockscout] starting — tracked=${wallets.length}` +
      (wallets.length
        ? ` [${wallets.map((w) => w.address.slice(0, 8) + "…").join(", ")}]`
        : " ⚠️ NONE — use /track 0x…")
  );

  const enqueue = (purchases: NftPurchase[]) => {
    for (const purchase of purchases) {
      handleTail = handleTail
        .then(async () => {
          if (stopped) return;
          try {
            await onPurchase(purchase);
          } catch (err) {
            console.error(
              `[blockscout] handler failed for ${purchase.txHash}:`,
              err instanceof Error ? err.message : err
            );
          }
        })
        .catch(() => {
          // keep queue alive
        });
    }
  };

  const tick = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const purchases = await scanBlockscoutMints();
      if (purchases.length > 0) {
        console.log(
          `[blockscout] detected ${purchases.length} mint tx(s): ${purchases
            .map((p) => p.txHash.slice(0, 10))
            .join(", ")}`
        );
        enqueue(purchases);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[blockscout] scan failed:`, lastError);
    } finally {
      scanning = false;
    }
  };

  // Do NOT block bot startup on the first scan.
  void tick();
  const intervalMs = Math.max(2_500, Math.min(config.pollIntervalMs, 5_000));
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  console.log(
    `[blockscout] watcher on ${explorerApiBase()} every ${intervalMs}ms (lookback ${BOOT_LOOKBACK_MS / 1000}s)`
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
