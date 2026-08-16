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
  /** Max blocks per eth_getLogs call (Alchemy Free = 10 on Robinhood). */
  getLogsMaxBlocks: number;
  defaultLookbackBlocks: number;
  defaultPollIntervalMs: number;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663n,
    defaultRpcUrl:
      "https://robinhood-mainnet.g.alchemy.com/v2/alch_ld9vD3xYwfRF3obL8qWT-",
    explorerTxUrl: (tx) => `https://robinhoodchain.blockscout.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://robinhoodchain.blockscout.com/address/${addr}`,
    openseaChain: "robinhood",
    alchemyNftNetwork: "robinhood-mainnet",
    // RH ≈ 100ms/block (~10 blk/s). Keep Alchemy CU low (Free tier 429s).
    // Blockscout watcher covers detection when getLogs is rate-limited.
    // 400 blocks/tick ≈ ~40s of chain; poll every 5s → catch-up under load.
    maxScanBlocks: 400,
    getLogsMaxBlocks: 10,
    // Fresh start / restart lookback (~90s).
    defaultLookbackBlocks: 900,
    // Gentler Alchemy polling — Blockscout is the fast path for signals.
    defaultPollIntervalMs: 5_000,
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
