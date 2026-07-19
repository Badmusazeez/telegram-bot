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
}

export interface BotState {
  trackedWallets: TrackedWallet[];
  copyEnabled: boolean;
  dryRun: boolean;
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
