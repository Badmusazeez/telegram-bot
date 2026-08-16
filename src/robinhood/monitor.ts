import { Interface, Log, formatEther, id, zeroPadValue } from "ethers";
import { config } from "../config";
import {
  getState,
  rememberTx,
  shortAddress,
  updateState,
} from "../store/state";
import type { NftPurchase } from "../types";
import { marketplaceName } from "./marketplaces";
import { classifyTrackRpcError, type TrackRpcIssue } from "./rpcHealth";
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

async function logsForBuyerChunk(
  fromBlock: number,
  toBlock: number,
  buyer: string
): Promise<Log[]> {
  // Inclusive range must stay within Alchemy Free's 10-block cap.
  if (toBlock - fromBlock + 1 > 10) {
    toBlock = fromBlock + 9;
  }

  const toTopic = zeroPadValue(buyer, 32);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await withTrackRpc((provider) =>
        provider.getLogs({
          fromBlock,
          toBlock,
          topics: [TRANSFER_TOPIC, null, toTopic],
        })
      );
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // If Alchemy rejects the range, split in half and recurse.
      if (
        msg.includes("10 block") &&
        toBlock > fromBlock
      ) {
        const mid = Math.floor((fromBlock + toBlock) / 2);
        const left = await logsForBuyerChunk(fromBlock, mid, buyer);
        const right = await logsForBuyerChunk(mid + 1, toBlock, buyer);
        return [...left, ...right];
      }
      console.warn(
        `[monitor] getLogs retry ${attempt}/3 for ${buyer} blocks ${fromBlock}-${toBlock}: ${msg}`
      );
      await sleep(800 * attempt);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function logsForBuyer(
  fromBlock: number,
  toBlock: number,
  buyer: string
): Promise<Log[]> {
  // Alchemy Free tier caps eth_getLogs at 10 blocks on Robinhood.
  const chunkSize = Math.min(10, Math.max(1, config.chain.getLogsMaxBlocks));
  const all: Log[] = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(toBlock, start + chunkSize - 1);
    const part = await logsForBuyerChunk(start, end, buyer);
    all.push(...part);
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

  let fromBlock = state.lastProcessedBlock
    ? state.lastProcessedBlock + 1
    : Math.max(0, latest - config.lookbackBlocks);

  const maxScan = config.chain.maxScanBlocks;
  if (latest - fromBlock > maxScan) {
    fromBlock = latest - maxScan;
  }
  if (fromBlock > latest) {
    return [];
  }

  const purchases: NftPurchase[] = [];
  let scanOk = true;

  for (const wallet of state.trackedWallets) {
    let logs: Log[] = [];
    try {
      logs = await logsForBuyer(fromBlock, latest, wallet.address);
    } catch (err) {
      scanOk = false;
      console.error(
        `[monitor] getLogs failed for ${wallet.address}:`,
        err instanceof Error ? err.message : err
      );
      const issue = classifyTrackRpcError(err);
      if (issue && onRpcIssue) {
        await onRpcIssue(issue);
      } else {
        console.error(
          "[monitor] Tip: Alchemy Free allows max 10 blocks per eth_getLogs. Use TRACK_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY"
        );
      }
      continue;
    }

    for (const log of logs) {
      const decoded = decodeTransfer(log);
      if (!decoded) {
        continue;
      }

      const dedupeKey = `${log.transactionHash}:${decoded.contract}:${decoded.tokenId}`;
      const isNew = await rememberTx(dedupeKey);
      if (!isNew) {
        continue;
      }

      const { valueRobinhood, marketplace } = await estimatePurchaseValue(
        log.transactionHash,
        decoded.to
      );

      // Free mint = mint Transfer (from zero) with no native payment.
      // Do NOT require !marketplace — OpenSea/Scatter paths must still copy.
      const isFreeMint = decoded.from === ZERO && valueRobinhood <= 0;
      const isPaid = !isFreeMint && (valueRobinhood > 0 || !!marketplace);

      if (state.freeMintsOnly && !isFreeMint) {
        continue;
      }

      // Speed path: do NOT await NFT metadata / block before copy-mint.
      // Enrichment happens in parallel with auto-mint (see enrichPurchase).
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
  }

  // Don't skip blocks when RPC fails — retry same window next poll.
  if (scanOk) {
    await updateState((s) => {
      s.lastProcessedBlock = latest;
    });
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
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const purchases = await scanForPurchases(onRpcIssue);
      for (const purchase of purchases) {
        await onPurchase(purchase);
      }
    } catch (err) {
      console.error("[monitor] scan failed:", err);
      const issue = classifyTrackRpcError(err);
      if (issue && onRpcIssue) {
        await onRpcIssue(issue);
      }
    } finally {
      running = false;
    }
  };

  await tick();
  const timer = setInterval(() => {
    void tick();
  }, config.pollIntervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
