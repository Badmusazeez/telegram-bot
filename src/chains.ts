export type ChainKey = "ink";

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

/**
 * Ink mainnet (Kraken OP Stack L2).
 * Chain ID 57073 — gas token is ETH. Not related to Robinhood Chain.
 */
export const CHAINS: Record<ChainKey, ChainConfig> = {
  ink: {
    key: "ink",
    name: "Ink",
    chainId: 57073n,
    // Public Gelato RPC (no key). Prefer Alchemy ink-mainnet for production.
    defaultRpcUrl: "https://rpc-gel.inkonchain.com",
    explorerTxUrl: (tx) => `https://explorer.inkonchain.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://explorer.inkonchain.com/address/${addr}`,
    openseaChain: "ink",
    alchemyNftNetwork: "ink-mainnet",
    maxScanBlocks: 400,
    getLogsMaxBlocks: 100,
    defaultLookbackBlocks: 40,
    defaultPollIntervalMs: 4_000,
  },
};

const ALIASES: Record<string, ChainKey> = {
  ink: "ink",
  inkchain: "ink",
  inkonchain: "ink",
};

export function resolveChain(raw: string | undefined): ChainConfig {
  const normalized = (raw || "ink").trim().toLowerCase();
  const key = (ALIASES[normalized] || normalized) as ChainKey;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN="${raw}". This bot is Ink-only. Use: ink`
    );
  }
  return chain;
}
