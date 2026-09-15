export type ChainKey = "ink" | "ink-sepolia";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: bigint;
  defaultRpcUrl: string;
  explorerTxUrl: (txHash: string) => string;
  explorerAddressUrl: (address: string) => string;
  /** OpenSea API chain slug */
  openseaChain: string;
  alchemyNftNetwork?: string;
  maxScanBlocks: number;
  getLogsMaxBlocks: number;
  defaultLookbackBlocks: number;
  defaultPollIntervalMs: number;
  /** Native gas token symbol (Ink uses ETH). */
  nativeSymbol: string;
}

/**
 * Ink (Kraken) — OP Stack L2, ETH gas.
 * Public RPCs: https://docs.inkonchain.com/general/network-information
 */
export const CHAINS: Record<ChainKey, ChainConfig> = {
  ink: {
    key: "ink",
    name: "Ink",
    chainId: 57073n,
    defaultRpcUrl: "https://rpc-gel.inkonchain.com",
    explorerTxUrl: (tx) => `https://explorer.inkonchain.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://explorer.inkonchain.com/address/${addr}`,
    openseaChain: "ink",
    maxScanBlocks: 300,
    getLogsMaxBlocks: 50,
    defaultLookbackBlocks: 600,
    defaultPollIntervalMs: 3_000,
    nativeSymbol: "ETH",
  },
  "ink-sepolia": {
    key: "ink-sepolia",
    name: "Ink Sepolia",
    chainId: 763373n,
    defaultRpcUrl: "https://rpc-gel-sepolia.inkonchain.com",
    explorerTxUrl: (tx) => `https://explorer-sepolia.inkonchain.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://explorer-sepolia.inkonchain.com/address/${addr}`,
    openseaChain: "ink",
    maxScanBlocks: 300,
    getLogsMaxBlocks: 50,
    defaultLookbackBlocks: 600,
    defaultPollIntervalMs: 3_000,
    nativeSymbol: "ETH",
  },
};

export function resolveChain(raw: string | undefined): ChainConfig {
  const key = (raw || "ink").trim().toLowerCase() as ChainKey;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN="${raw}". Use: ${Object.keys(CHAINS).join(", ")}`
    );
  }
  return chain;
}
