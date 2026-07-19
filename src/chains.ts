export type ChainKey = "ethereum" | "robinhood";

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
  /** Max blocks to scan in one poll (L2s are much denser). */
  maxScanBlocks: number;
  defaultLookbackBlocks: number;
  defaultPollIntervalMs: number;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum Mainnet",
    chainId: 1n,
    defaultRpcUrl: "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    explorerTxUrl: (tx) => `https://etherscan.io/tx/${tx}`,
    explorerAddressUrl: (addr) => `https://etherscan.io/address/${addr}`,
    openseaChain: "ethereum",
    alchemyNftNetwork: "eth-mainnet",
    maxScanBlocks: 40,
    defaultLookbackBlocks: 8,
    defaultPollIntervalMs: 12_000,
  },
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663n,
    defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerTxUrl: (tx) => `https://robinhoodchain.blockscout.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://robinhoodchain.blockscout.com/address/${addr}`,
    openseaChain: "robinhood",
    // Alchemy NFT metadata may not be available on every RH endpoint.
    alchemyNftNetwork: undefined,
    // ~100ms blocks → scan a wider window per poll.
    maxScanBlocks: 400,
    defaultLookbackBlocks: 120,
    defaultPollIntervalMs: 5_000,
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
