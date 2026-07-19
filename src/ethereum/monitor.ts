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
import { getProvider } from "./provider";

const ERC721_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";

export type PurchaseHandler = (purchase: NftPurchase) => Promise<void>;

async function enrichNft(
  contract: string,
  tokenId: string
): Promise<Pick<NftPurchase, "collectionName" | "tokenName" | "imageUrl">> {
  const network = config.chain.alchemyNftNetwork;
  const key = config.alchemyApiKey || extractAlchemyKey(config.ethRpcUrl);
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

function extractAlchemyKey(rpcUrl: string): string | null {
  const match = rpcUrl.match(/g\.alchemy\.com\/v2\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

async function estimatePurchaseValue(
  txHash: string,
  buyer: string
): Promise<{ valueEth: number; marketplace?: string }> {
  try {
    const provider = getProvider();
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      return { valueEth: 0 };
    }

    const market = marketplaceName(tx.to);
    let valueEth = 0;

    if (tx.from.toLowerCase() === buyer && tx.value > 0n) {
      valueEth = Number(formatEther(tx.value));
    } else if (tx.value > 0n) {
      valueEth = Number(formatEther(tx.value));
    }

    return { valueEth, marketplace: market };
  } catch {
    return { valueEth: 0 };
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

async function logsForBuyer(
  fromBlock: number,
  toBlock: number,
  buyer: string
): Promise<Log[]> {
  const provider = getProvider();
  const toTopic = zeroPadValue(buyer, 32);
  return provider.getLogs({
    fromBlock,
    toBlock,
    topics: [TRANSFER_TOPIC, null, toTopic],
  });
}

export async function scanForPurchases(): Promise<NftPurchase[]> {
  const state = getState();
  if (state.trackedWallets.length === 0) {
    return [];
  }

  const provider = getProvider();
  const latest = await provider.getBlockNumber();
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

  for (const wallet of state.trackedWallets) {
    let logs: Log[] = [];
    try {
      logs = await logsForBuyer(fromBlock, latest, wallet.address);
    } catch (err) {
      console.error(
        `[monitor] getLogs failed for ${wallet.address}:`,
        err instanceof Error ? err.message : err
      );
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

      const { valueEth, marketplace } = await estimatePurchaseValue(
        log.transactionHash,
        decoded.to
      );

      // Skip free mints; keep marketplace fills and secondary transfers in.
      if (decoded.from === ZERO && valueEth <= 0 && !marketplace) {
        continue;
      }

      const meta = await enrichNft(decoded.contract, decoded.tokenId);
      const block = await provider.getBlock(log.blockNumber);

      purchases.push({
        txHash: log.transactionHash,
        buyer: decoded.to,
        seller: decoded.from,
        contract: decoded.contract,
        tokenId: decoded.tokenId,
        valueEth,
        blockNumber: log.blockNumber,
        timestamp: block?.timestamp ?? Math.floor(Date.now() / 1000),
        marketplace: marketplace || (valueEth > 0 ? "on-chain" : "transfer"),
        ...meta,
      });
    }
  }

  await updateState((s) => {
    s.lastProcessedBlock = latest;
  });

  return purchases;
}

export function describeWallet(address: string): string {
  const wallet = getState().trackedWallets.find((w) => w.address === address);
  return wallet
    ? `${wallet.label} (${shortAddress(address)})`
    : shortAddress(address);
}

export async function startMonitor(
  onPurchase: PurchaseHandler
): Promise<() => void> {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const purchases = await scanForPurchases();
      for (const purchase of purchases) {
        await onPurchase(purchase);
      }
    } catch (err) {
      console.error("[monitor] scan failed:", err);
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
