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
  valueEth: number;
  blockNumber: number;
  timestamp: number;
  collectionName?: string;
  tokenName?: string;
  imageUrl?: string;
  marketplace?: string;
  /** True when Transfer is from the zero address (mint). */
  isFreeMint: boolean;
  /** True when mint has native value > 0 (private / paid mint). */
  isPrivateMint: boolean;
  /** True when the mint/buy tx carried native value > 0. */
  isPaid: boolean;
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
  /** Native ETH value to send with the mint (wei as decimal string). */
  valueWei: string;
  executeAt: string;
  createdAt: string;
  status: ScheduledMintStatus;
  sourceTxHash?: string;
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
  /** When true, only 0-ETH free mints. When false, also private/paid mints under maxBuyEth. */
  freeMintsOnly: boolean;
  /** Allow copying private/paid mints (from 0x0 with value > 0) under maxBuyEth. */
  privateMintsEnabled: boolean;
  priceAlertsEnabled: boolean;
  priceAlertPct: number;
  maxBuyEth: number;
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
