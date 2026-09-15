export type ChainKey = "arc" | "arc-testnet";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: bigint;
  defaultRpcUrl: string;
  explorerTxUrl: (txHash: string) => string;
  explorerAddressUrl: (address: string) => string;
  /** OpenSea API chain slug (if/when OpenSea lists Arc). */
  openseaChain: string;
  alchemyNftNetwork?: string;
  maxScanBlocks: number;
  getLogsMaxBlocks: number;
  defaultLookbackBlocks: number;
  defaultPollIntervalMs: number;
  /** Native gas token symbol (Arc uses USDC). */
  nativeSymbol: string;
}

/**
 * Arc (Circle) — EVM L2 with USDC as native gas.
 * Public RPCs for now; swap TRACK/MINT URLs later without code changes.
 */
export const CHAINS: Record<ChainKey, ChainConfig> = {
  arc: {
    key: "arc",
    name: "Arc",
    chainId: 5042n,
    defaultRpcUrl: "https://rpc.arc-scan.org",
    explorerTxUrl: (tx) => `https://explorer.arc.io/tx/${tx}`,
    explorerAddressUrl: (addr) => `https://explorer.arc.io/address/${addr}`,
    openseaChain: "arc",
    maxScanBlocks: 300,
    getLogsMaxBlocks: 50,
    defaultLookbackBlocks: 600,
    defaultPollIntervalMs: 3_000,
    nativeSymbol: "USDC",
  },
  "arc-testnet": {
    key: "arc-testnet",
    name: "Arc Testnet",
    chainId: 5042002n,
    defaultRpcUrl: "https://rpc.testnet.arc.io",
    explorerTxUrl: (tx) => `https://testnet.arcscan.app/tx/${tx}`,
    explorerAddressUrl: (addr) =>
      `https://testnet.arcscan.app/address/${addr}`,
    openseaChain: "arc-testnet",
    maxScanBlocks: 300,
    getLogsMaxBlocks: 50,
    defaultLookbackBlocks: 600,
    defaultPollIntervalMs: 3_000,
    nativeSymbol: "USDC",
  },
};

export function resolveChain(raw: string | undefined): ChainConfig {
  const key = (raw || "arc").trim().toLowerCase() as ChainKey;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(
      `Unsupported CHAIN="${raw}". Use: ${Object.keys(CHAINS).join(", ")}`
    );
  }
  return chain;
}
