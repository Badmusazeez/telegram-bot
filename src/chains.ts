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
      "https://robinhood-mainnet.g.alchemy.com/v2/eVuaN-ufVXjtvufzC9Tiu",
    explorerTxUrl: (tx) => `https://robinhoodchain.blockscout.com/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://robinhoodchain.blockscout.com/address/${addr}`,
    openseaChain: "robinhood",
    alchemyNftNetwork: "robinhood-mainnet",
    // RH ≈ 100ms/block (~10 blk/s). Scan windows must stay ahead of the tip
    // without JUMPING (jumping permanently skips mints). 2000 ≈ ~3+ min/tick.
    maxScanBlocks: 2000,
    getLogsMaxBlocks: 10,
    // Fresh start / restart lookback (~2 min).
    defaultLookbackBlocks: 1200,
    // Scan often; copy/Telegram no longer block the scan loop.
    defaultPollIntervalMs: 2_500,
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
