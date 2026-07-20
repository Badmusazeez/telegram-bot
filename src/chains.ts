export type ChainKey = "robinhood";

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
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663n,
    defaultRpcUrl: "https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY",
    explorerTxUrl: (tx) => `https://robinhoodchain.blockscout.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://robinhoodchain.blockscout.com/address/${addr}`,
    openseaChain: "robinhood",
    alchemyNftNetwork: "robinhood-mainnet",
    maxScanBlocks: 200,
    defaultLookbackBlocks: 80,
    defaultPollIntervalMs: 8_000,
  },
};

export function resolveChain(raw: string | undefined): ChainConfig {
  const key = (raw || "robinhood").trim().toLowerCase() as ChainKey;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN="${raw}". Use: ${Object.keys(CHAINS).join(", ")}`
    );
  }
  return chain;
}
