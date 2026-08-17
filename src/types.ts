export interface TrackedWallet {
  address: string;
  label: string;
  addedAt: string;
}

export interface NftPurchase {
  txHash: string;
  buyer: string;
  seller: string;
  contract: string;
  tokenId: string;
  valueRobinhood: number;
  blockNumber: number;
  timestamp: number;
  collectionName?: string;
  tokenName?: string;
  imageUrl?: string;
  marketplace?: string;
  /** True when Transfer is from the zero address (mint). */
  isFreeMint: boolean;
  /** True when the mint/buy tx carried native value > 0. */
  isPaid: boolean;
  /** Optional whale tx fields (Blockscout) so copy skips RPC lag. */
  sourceTo?: string;
  sourceData?: string;
}

/** NFT / collection watched for OpenSea price changes. */
export interface WatchedPriceItem {
  id: string;
  contract: string;
  /** Empty string means collection-floor watch only. */
  tokenId: string;
  label: string;
  lastPrice: number | null;
  lastCheckedAt: string | null;
  addedAt: string;
}

export type ScheduledMintStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface ScheduledMint {
  id: string;
  label: string;
  to: string;
  data: string;
  executeAt: string;
  createdAt: string;
  status: ScheduledMintStatus;
  sourceTxHash?: string;
  /** If set, mint calldata is rebuilt from OpenSea Drops API at fire time. */
  openSeaSlug?: string;
  resultTxHash?: string;
  resultReason?: string;
  finishedAt?: string;
}

export interface ScheduledMintResult {
  success: boolean;
  dryRun: boolean;
  reason: string;
  txHash?: string;
}

export interface BotState {
  trackedWallets: TrackedWallet[];
  copyEnabled: boolean;
  dryRun: boolean;
  freeMintsOnly: boolean;
  priceAlertsEnabled: boolean;
  priceAlertPct: number;
  maxBuyRobinhood: number;
  allowedCollections: string[];
  lastProcessedBlock: number;
  notifyChatIds: string[];
  recentTxHashes: string[];
  watchedPrices: WatchedPriceItem[];
  scheduledMints: ScheduledMint[];
}

export interface CopyResult {
  attempted: boolean;
  success: boolean;
  dryRun: boolean;
  reason: string;
  txHash?: string;
}

export interface PriceChangeAlert {
  item: WatchedPriceItem;
  oldPrice: number | null;
  newPrice: number;
  changePct: number | null;
  openSeaUrl: string;
}
