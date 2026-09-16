export type ChainKey = "ethereum" | "eth";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: bigint;
  defaultRpcUrl: string;
  defaultBackupRpcUrl?: string;
  explorerTxUrl: (txHash: string) => string;
  explorerAddressUrl: (address: string) => string;
  /** OpenSea API chain slug */
  openseaChain: string;
  alchemyNftNetwork?: string;
  maxScanBlocks: number;
  getLogsMaxBlocks: number;
  defaultLookbackBlocks: number;
  defaultPollIntervalMs: number;
  nativeSymbol: string;
}

/**
 * Ethereum mainnet — Alchemy for track + mint.
 * Separate deploy from Robinhood / Arc / Ink bots.
 */
export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1n,
    defaultRpcUrl:
      "https://eth-mainnet.g.alchemy.com/v2/rII4SERrRQMo_H5GavFfo",
    explorerTxUrl: (tx) => `https://etherscan.io/tx/${tx}`,
    explorerAddressUrl: (addr) => `https://etherscan.io/address/${addr}`,
    openseaChain: "ethereum",
    alchemyNftNetwork: "eth-mainnet",
    // Alchemy eth_getLogs: keep chunks modest to avoid 429s.
    maxScanBlocks: 500,
    getLogsMaxBlocks: 100,
    defaultLookbackBlocks: 300,
    defaultPollIntervalMs: 4_000,
    nativeSymbol: "ETH",
  },
  // Alias
  eth: {
    key: "eth",
    name: "Ethereum",
    chainId: 1n,
    defaultRpcUrl:
      "https://eth-mainnet.g.alchemy.com/v2/rII4SERrRQMo_H5GavFfo",
    explorerTxUrl: (tx) => `https://etherscan.io/tx/${tx}`,
    explorerAddressUrl: (addr) => `https://etherscan.io/address/${addr}`,
    openseaChain: "ethereum",
    alchemyNftNetwork: "eth-mainnet",
    maxScanBlocks: 500,
    getLogsMaxBlocks: 100,
    defaultLookbackBlocks: 300,
    defaultPollIntervalMs: 4_000,
    nativeSymbol: "ETH",
  },
};

export function resolveChain(raw: string | undefined): ChainConfig {
  const key = (raw || "ethereum").trim().toLowerCase() as ChainKey;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN="${raw}". Use: ethereum (or eth)`
    );
  }
  return chain;
}
