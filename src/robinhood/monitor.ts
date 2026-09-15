import { Interface, Log, formatEther, id, zeroPadValue } from "ethers";
import { config } from "../config";
import {
  getState,
  rememberTxFast,
  shortAddress,
  updateState,
} from "../store/state";
import type { NftPurchase } from "../types";
import { marketplaceName } from "./marketplaces";
import { classifyTrackRpcError, isNonArchiveRpcError, NON_ARCHIVE_LOOKBACK_BLOCKS, type TrackRpcIssue } from "./rpcHealth";
import { withTrackRpc } from "./trackRpc";

const ERC721_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";

export type PurchaseHandler = (purchase: NftPurchase) => Promise<void>;
export type RpcIssueHandler = (issue: TrackRpcIssue) => Promise<void>;

async function enrichNft(
  contract: string,
  tokenId: string
): Promise<Pick<NftPurchase, "collectionName" | "tokenName" | "imageUrl">> {
  const network = config.chain.alchemyNftNetwork;
  const key = config.alchemyApiKey || extractAlchemyKey(config.trackRpcUrl);
  if (!key || !network) {
    return {};
  }

  try {
    const url = `https://${network}.g.alchemy.com/nft/v3/${key}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}&refreshCache=false`;
    const res = await fetch(url);
    if (!res.ok) {
      return {};
    }
    const data = (await res.json()) as {
      name?: string;
      image?: { cachedUrl?: string; originalUrl?: string };
      contract?: { name?: string };
    };
    return {
      collectionName: data.contract?.name,
      tokenName: data.name,
      imageUrl: data.image?.cachedUrl || data.image?.originalUrl,
    };
  } catch {
    return {};
  }
}

/** Fill collection/token metadata + block time (safe to run parallel with mint). */
export async function enrichPurchase(
  purchase: NftPurchase
): Promise<NftPurchase> {
  try {
    const [meta, block] = await Promise.all([
      enrichNft(purchase.contract, purchase.tokenId),
      withTrackRpc((provider) => provider.getBlock(purchase.blockNumber)).catch(
        () => null
      ),
    ]);
    return {
      ...purchase,
      ...meta,
      timestamp: block?.timestamp ?? purchase.timestamp,
    };
  } catch {
    return purchase;
  }
}

function extractAlchemyKey(rpcUrl: string): string | null {
  const match = rpcUrl.match(/g\.alchemy\.com\/v2\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

async function estimatePurchaseValue(
  txHash: string,
  buyer: string
): Promise<{ valueRobinhood: number; marketplace?: string }> {
  try {
    const tx = await withTrackRpc((provider) =>
      provider.getTransaction(txHash)
    );
    if (!tx) {
      return { valueRobinhood: 0 };
    }

    const market = marketplaceName(tx.to);
    let valueRobinhood = 0;

    if (tx.from.toLowerCase() === buyer && tx.value > 0n) {
      valueRobinhood = Number(formatEther(tx.value));
    } else if (tx.value > 0n) {
      valueRobinhood = Number(formatEther(tx.value));
    }

    return { valueRobinhood, marketplace: market };
  } catch {
    return { valueRobinhood: 0 };
  }
}

function decodeTransfer(log: Log): {
  from: string;
  to: string;
  tokenId: string;
  contract: string;
} | null {
  try {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 4) {
      return null;
    }
    const parsed = ERC721_IFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed) {
      return null;
    }
    return {
      from: String(parsed.args.from).toLowerCase(),
      to: String(parsed.args.to).toLowerCase(),
      tokenId: parsed.args.tokenId.toString(),
      contract: log.address.toLowerCase(),
    };
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One getLogs for ALL tracked wallets (topic OR on `to`).
 * Robinhood ~100ms/block — scanning wallets one-by-one was too slow and missed mints.
 */
async function logsForTrackedChunk(
  fromBlock: number,
  toBlock: number,
  buyerTopics: string[]
): Promise<Log[]> {
  if (toBlock - fromBlock + 1 > 10) {
    toBlock = fromBlock + 9;
  }

  const toFilter = buyerTopics.length === 1 ? buyerTopics[0] : buyerTopics;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await withTrackRpc((provider) =>
        provider.getLogs({
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, null, toFilter],
        })
      );
    } catch (err) {
      lastErr = err;
      // Non-archive plans fail every retry for old ranges — fail fast.
      if (isNonArchiveRpcError(err)) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        (msg.includes("10 block") || /block range/i.test(msg)) &&
        toBlock > fromBlock
      ) {
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const left = await logsForTrackedChunk(fromBlock, mid, buyerTopics);
        const right = await logsForTrackedChunk(mid + 1, toBlock, buyerTopics);
        return [...left, ...right];
      }
      // Some RPCs reject large topic OR lists — fall back to per-wallet.
      if (
        buyerTopics.length > 1 &&
        (/query returned more than|too many|response size|payload/i.test(msg) ||
          msg.includes("413"))
      ) {
        const parts: Log[] = [];
        for (const t of buyerTopics) {
          parts.push(
            ...(await logsForTrackedChunk(fromBlock, toBlock, [t]))
          );
        }
        return parts;
      }
      const rateLimited = /429|rate limit|capacity|too many requests/i.test(
        msg
      );
      console.warn(
        `[monitor] getLogs retry ${attempt}/3 blocks ${fromBlock}-${toBlock}: ${msg}`
      );
      // Back off hard on Alchemy 429 — Blockscout watcher still detects mints.
      await sleep(rateLimited ? 2_500 * attempt : 500 * attempt);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function logsForTrackedWallets(
  fromBlock: number,
  toBlock: number,
  buyers: string[]
): Promise<Log[]> {
  const chunkSize = Math.min(10, Math.max(1, config.chain.getLogsMaxBlocks));
  const buyerTopics = buyers.map((b) => zeroPadValue(b, 32));
  const all: Log[] = [];

  // Parallelize chunk fetches (bounded) so catch-up stays ahead of ~10 blk/s chain.
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    ranges.push({ start, end: Math.min(toBlock, start + chunkSize - 1) });
  }

  // Sequential chunks — parallel getLogs burns Alchemy CU and triggers 429s.
  for (const r of ranges) {
    all.push(...(await logsForTrackedChunk(r.start, r.end, buyerTopics)));
  }

  return all;
}

export async function scanForPurchases(
  onRpcIssue?: RpcIssueHandler
): Promise<NftPurchase[]> {
  const state = getState();
  if (state.trackedWallets.length === 0) {
    return [];
  }

  let latest: number;
  try {
    latest = await withTrackRpc((provider) => provider.getBlockNumber());
  } catch (err) {
    const issue = classifyTrackRpcError(err);
    if (issue && onRpcIssue) {
      await onRpcIssue(issue);
    }
    throw err;
  }

  // Leave 1 block cushion — tip block logs can still be incomplete on some RPCs.
  const tip = Math.max(0, latest - 1);

  // Chainstack Developer (non-archive) only serves ~100 recent blocks for
  // getLogs. If our cursor is further behind, jump into the live window or
  // we spin forever on "Archive… not available on your current plan".
  const minLiveFrom = Math.max(0, tip - NON_ARCHIVE_LOOKBACK_BLOCKS);

  let fromBlock = state.lastProcessedBlock
    ? state.lastProcessedBlock + 1
    : minLiveFrom;

  if (fromBlock < minLiveFrom) {
    console.warn(
      `[monitor] cursor ${fromBlock} is outside non-archive window — jumping to ${minLiveFrom} (tip ${tip})`
    );
    fromBlock = minLiveFrom;
  }

  if (fromBlock > tip) {
    return [];
  }

  /**
   * NEVER jump the cursor past unscanned live blocks.
   * Robinhood ≈ 10 blocks/sec — only advance through a bounded window per tick.
   */
  const maxScan = Math.min(
    Math.max(50, config.chain.maxScanBlocks),
    NON_ARCHIVE_LOOKBACK_BLOCKS
  );
  const toBlock = Math.min(tip, fromBlock + maxScan - 1);

  const buyers = state.trackedWallets.map((w) => w.address.toLowerCase());
  const buyerSet = new Set(buyers);

  let logs: Log[] = [];
  try {
    logs = await logsForTrackedWallets(fromBlock, toBlock, buyers);
  } catch (err) {
    console.error(
      `[monitor] getLogs failed blocks ${fromBlock}-${toBlock}:`,
      err instanceof Error ? err.message : err
    );
    const issue = classifyTrackRpcError(err);
    if (issue && onRpcIssue) {
      await onRpcIssue(issue);
    }
    // Archive plan errors: skip dead history and resume near tip next tick.
    if (isNonArchiveRpcError(err)) {
      const jumpTo = Math.max(0, tip - Math.floor(NON_ARCHIVE_LOOKBACK_BLOCKS / 2));
      console.warn(
        `[monitor] non-archive RPC — advancing cursor ${fromBlock} → ${jumpTo}`
      );
      await updateState((s) => {
        s.lastProcessedBlock = jumpTo;
      });
    }
    // Otherwise do not advance — retry same window.
    return [];
  }

  const purchases: NftPurchase[] = [];
  // Cache tx value lookups (721A multi-Transfer spam).
  const valueCache = new Map<
    string,
    { valueRobinhood: number; marketplace?: string }
  >();
  /** One free-mint signal per source tx (not per token). */
  const freeMintTxSeen = new Set<string>();

  for (const log of logs) {
    const decoded = decodeTransfer(log);
    if (!decoded) continue;
    if (!buyerSet.has(decoded.to)) continue;

    const txKey = log.transactionHash.toLowerCase();
    let valued = valueCache.get(txKey);
    if (!valued) {
      valued = await estimatePurchaseValue(log.transactionHash, decoded.to);
      valueCache.set(txKey, valued);
    }
    const { valueRobinhood, marketplace } = valued;

    const isFreeMint = decoded.from === ZERO && valueRobinhood <= 0;
    const isPaid = !isFreeMint && (valueRobinhood > 0 || !!marketplace);

    if (state.freeMintsOnly && !isFreeMint) {
      continue;
    }

    if (isFreeMint) {
      // Align with Blockscout dedupe — one copy attempt per mint tx.
      const mintKey = `${txKey}:${decoded.contract}:mint`;
      if (freeMintTxSeen.has(mintKey) || !rememberTxFast(mintKey)) {
        continue;
      }
      freeMintTxSeen.add(mintKey);
    } else {
      const dedupeKey = `${log.transactionHash}:${decoded.contract}:${decoded.tokenId}`;
      if (!rememberTxFast(dedupeKey)) continue;
    }

    purchases.push({
      txHash: log.transactionHash,
      buyer: decoded.to,
      seller: decoded.from,
      contract: decoded.contract,
      tokenId: decoded.tokenId,
      valueRobinhood,
      blockNumber: log.blockNumber,
      timestamp: Math.floor(Date.now() / 1000),
      marketplace: isFreeMint
        ? "free-mint"
        : marketplace || (valueRobinhood > 0 ? "on-chain" : "transfer"),
      isFreeMint,
      isPaid,
    });
  }

  // Advance only through the window we successfully scanned (never skip ahead).
  await updateState((s) => {
    s.lastProcessedBlock = toBlock;
  });

  if (toBlock < tip) {
    console.log(
      `[monitor] catch-up ${fromBlock}-${toBlock} (tip ${tip}, behind ${tip - toBlock} blocks)`
    );
  }

  return purchases;
}

export function describeWallet(address: string): string {
  const wallet = getState().trackedWallets.find((w) => w.address === address);
  return wallet
    ? `${wallet.label} (${shortAddress(address)})`
    : shortAddress(address);
}

export async function startMonitor(
  onPurchase: PurchaseHandler,
  onRpcIssue?: RpcIssueHandler
): Promise<() => void> {
  let stopped = false;
  let scanning = false;
  /** Handlers run in parallel so one mint never blocks another. */
  const enqueuePurchases = (purchases: NftPurchase[]) => {
    for (const purchase of purchases) {
      void (async () => {
        if (stopped) return;
        try {
          await onPurchase(purchase);
        } catch (err) {
          console.error(
            `[monitor] handler failed for ${purchase.txHash}:`,
            err instanceof Error ? err.message : err
          );
        }
      })();
    }
  };

  const tick = async () => {
    if (stopped || scanning) {
      return;
    }
    scanning = true;
    try {
      const purchases = await scanForPurchases(onRpcIssue);
      if (purchases.length > 0) {
        console.log(`[monitor] detected ${purchases.length} event(s)`);
        enqueuePurchases(purchases);
      }
    } catch (err) {
      console.error("[monitor] scan failed:", err);
      const issue = classifyTrackRpcError(err);
      if (issue && onRpcIssue) {
        await onRpcIssue(issue);
      }
    } finally {
      scanning = false;
    }
  };

  // Non-blocking first tick — Blockscout already covers live detection.
  void tick();
  // Catch up faster when behind: poll often; scan itself is the rate limiter.
  const timer = setInterval(() => {
    void tick();
  }, config.pollIntervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
