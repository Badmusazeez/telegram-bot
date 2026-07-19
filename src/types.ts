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
  /** True when the mint/buy tx carried ETH value > 0. */
  isPaid: boolean;
}

export interface BotState {
  trackedWallets: TrackedWallet[];
  copyEnabled: boolean;
  dryRun: boolean;
  freeMintsOnly: boolean;
  maxBuyEth: number;
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
