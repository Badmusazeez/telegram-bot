export type ChainKey = "ethereum";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: bigint;
  defaultRpcUrl: string;
  explorerTxUrl: (txHash: string) => string;
  explorerAddressUrl: (address: string) => string;
  /** OpenSea API chain slug used in /api/v2/orders/{chain}/... */
  openseaChain: string;
  /** Alchemy NFT API network segment, if supported. */
  alchemyNftNetwork?: string;
  /** Max blocks to scan in one poll. */
  maxScanBlocks: number;
  /** Max blocks per eth_getLogs call. */
  getLogsMaxBlocks: number;
  defaultLookbackBlocks: number;
  defaultPollIntervalMs: number;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1n,
    defaultRpcUrl: "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    explorerTxUrl: (tx) => `https://etherscan.io/tx/${tx}`,
    explorerAddressUrl: (addr) => `https://etherscan.io/address/${addr}`,
    openseaChain: "ethereum",
    alchemyNftNetwork: "eth-mainnet",
    maxScanBlocks: 200,
    getLogsMaxBlocks: 50,
    defaultLookbackBlocks: 20,
    defaultPollIntervalMs: 12_000,
  },
};

export function resolveChain(raw: string | undefined): ChainConfig {
  const key = (raw || "ethereum").trim().toLowerCase() as ChainKey;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN="${raw}". Use: ${Object.keys(CHAINS).join(", ")}`
    );
  }
  return chain;
}
