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
}

export interface BotState {
  trackedWallets: TrackedWallet[];
  copyEnabled: boolean;
  dryRun: boolean;
  freeMintsOnly: boolean;
  maxBuyRobinhood: number;
  allowedCollections: string[];
  lastProcessedBlock: number;
  notifyChatIds: string[];
  recentTxHashes: string[];
}

export interface CopyResult {
  attempted: boolean;
  success: boolean;
  dryRun: boolean;
  reason: string;
  txHash?: string;
}
