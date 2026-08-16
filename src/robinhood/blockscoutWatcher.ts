import { formatEther } from "ethers";
import { config } from "../config";
import { getState, rememberTxFast } from "../store/state";
import type { NftPurchase } from "../types";
import type { PurchaseHandler } from "./monitor";

const ZERO = "0x0000000000000000000000000000000000000000";

type BlockscoutAddress = { hash?: string };
type BlockscoutToken = {
  address_hash?: string;
  address?: string;
  name?: string;
  type?: string;
};
type BlockscoutTransfer = {
  transaction_hash?: string;
  block_number?: number;
  timestamp?: string;
  type?: string;
  method?: string;
  from?: BlockscoutAddress;
  to?: BlockscoutAddress;
  token?: BlockscoutToken;
  total?: { token_id?: string; value?: string };
};

type BlockscoutTx = {
  hash?: string;
  status?: string;
  value?: string;
  timestamp?: string;
  from?: BlockscoutAddress;
  to?: BlockscoutAddress;
};

function explorerApiBase(): string {
  // chains.explorerTxUrl is …/tx/{hash} → strip to origin + /api/v2
  const txUrl = config.chain.explorerTxUrl("0x");
  const origin = txUrl.replace(/\/tx\/0x$/i, "");
  return `${origin}/api/v2`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.warn(`[blockscout] ${res.status} ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(
      `[blockscout] fetch failed: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}

async function fetchTokenTransfers(
  address: string
): Promise<BlockscoutTransfer[]> {
  const base = explorerApiBase();
  const url = `${base}/addresses/${address}/token-transfers?type=ERC-721%2CERC-1155`;
  const data = await fetchJson<{ items?: BlockscoutTransfer[] }>(url);
  return data?.items ?? [];
}

const txValueCache = new Map<string, number>();

async function fetchTxValueRobinhood(txHash: string): Promise<number> {
  const key = txHash.toLowerCase();
  const cached = txValueCache.get(key);
  if (cached !== undefined) return cached;

  const base = explorerApiBase();
  const data = await fetchJson<BlockscoutTx>(`${base}/transactions/${txHash}`);
  let value = 0;
  if (data?.value) {
    try {
      value = Number(formatEther(BigInt(data.value)));
    } catch {
      value = 0;
    }
  }
  txValueCache.set(key, value);
  if (txValueCache.size > 500) {
    const first = txValueCache.keys().next().value;
    if (first) txValueCache.delete(first);
  }
  return value;
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function tokenContract(item: BlockscoutTransfer): string {
  return (
    item.token?.address_hash ||
    item.token?.address ||
    ""
  ).toLowerCase();
}

function tokenIdOf(item: BlockscoutTransfer): string {
  return item.total?.token_id ?? item.total?.value ?? "0";
}

function isMintTransfer(item: BlockscoutTransfer): boolean {
  const from = (item.from?.hash || "").toLowerCase();
  if (from === ZERO) return true;
  return (item.type || "").toLowerCase() === "token_minting";
}

/** Per-wallet high-water mark (ms). First poll looks back ~5 minutes. */
const lastSeenTsByWallet = new Map<string, number>();
const BOOT_LOOKBACK_MS = 5 * 60_000;

/**
 * Blockscout token-transfer poller — survives Alchemy eth_getLogs 429s.
 * Dedupes with the Alchemy monitor via rememberTxFast (same key shape).
 */
export async function scanBlockscoutMints(): Promise<NftPurchase[]> {
  const state = getState();
  if (state.trackedWallets.length === 0) {
    return [];
  }

  const purchases: NftPurchase[] = [];
  const wallets = state.trackedWallets.map((w) => w.address.toLowerCase());

  // Sequential per wallet to stay gentle on Blockscout.
  for (const buyer of wallets) {
    const since =
      lastSeenTsByWallet.get(buyer) ?? Date.now() - BOOT_LOOKBACK_MS;
    let maxSeen = since;

    const items = await fetchTokenTransfers(buyer);
    for (const item of items) {
      const tsMs = parseIsoMs(item.timestamp);
      if (tsMs > 0) {
        if (tsMs <= since) continue;
        if (tsMs > maxSeen) maxSeen = tsMs;
      }

      if (!isMintTransfer(item)) continue;

      const to = (item.to?.hash || "").toLowerCase();
      if (to !== buyer) continue;

      const txHash = (item.transaction_hash || "").toLowerCase();
      const contract = tokenContract(item);
      const tokenId = tokenIdOf(item);
      if (!txHash || !contract) continue;

      const dedupeKey = `${txHash}:${contract}:${tokenId}`;
      if (!rememberTxFast(dedupeKey)) continue;

      const valueRobinhood = await fetchTxValueRobinhood(txHash);
      const isFreeMint = true; // from zero / token_minting
      const isPaid = valueRobinhood > 0;

      if (state.freeMintsOnly && isPaid) {
        continue;
      }

      const blockNumber = Number(item.block_number || 0);
      purchases.push({
        txHash,
        buyer,
        seller: ZERO,
        contract,
        tokenId,
        valueRobinhood,
        blockNumber: blockNumber || 0,
        timestamp: tsMs
          ? Math.floor(tsMs / 1000)
          : Math.floor(Date.now() / 1000),
        marketplace: "free-mint",
        collectionName: item.token?.name,
        isFreeMint,
        isPaid,
      });
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
          `[blockscout] detected ${purchases.length} mint transfer(s)`
        );
        enqueue(purchases);
      }
    } catch (err) {
      console.error(
        `[blockscout] scan failed:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      scanning = false;
    }
  };

  await tick();
  // Independent of Alchemy poll — keeps signals flowing under RPC 429.
  const intervalMs = Math.max(3_000, Math.min(config.pollIntervalMs, 8_000));
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  console.log(
    `[blockscout] watcher on ${explorerApiBase()} every ${intervalMs}ms`
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
