import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { config } from "../config";
import { getMintWalletCount, getEthersWallets } from "../store/mintWallets";
import { getState } from "../store/state";
import { getTrackProvider } from "./trackRpc";

let mintProvider: JsonRpcProvider | null = null;
let primaryWallet: Wallet | null = null;

/** Active tracker RPC (Alchemy). Optional backup via TRACK_RPC_BACKUP_URL. */
export function getProvider(): JsonRpcProvider {
  return getTrackProvider();
}

/** Mint RPC — send txs / gas estimates (Chainstack). */
export function getMintProvider(): JsonRpcProvider {
  if (!mintProvider) {
    mintProvider = new JsonRpcProvider(config.mintRpcUrl);
  }
  return mintProvider;
}

/** Optional mint backup RPC when configured. */
export function getMintBackupProvider(): JsonRpcProvider | null {
  if (!config.mintBackupRpcUrl) return null;
  return new JsonRpcProvider(config.mintBackupRpcUrl);
}

/** Primary wallet (first configured) — used for status display. */
export function getWallet(): Wallet | null {
  const all = getAllMintWallets();
  if (all.length > 0) {
    return all[0];
  }
  if (!config.privateKey) {
    return null;
  }
  if (!primaryWallet) {
    primaryWallet = new Wallet(config.privateKey, getMintProvider());
  }
  return primaryWallet;
}

/** All mint wallets connected to the mint RPC. */
export function getAllMintWallets(): Wallet[] {
  return getEthersWallets();
}

export function mintWalletCount(): number {
  return getMintWalletCount();
}

export async function getNativeBalance(address: string): Promise<string> {
  const balance = await getMintProvider().getBalance(address);
  return formatEther(balance);
}

/** Minimum native balance required to attempt a mint (covers gas). */
const MIN_MINT_BALANCE_WEI = 50_000_000_000_000n; // 0.00005 ETH
void MIN_MINT_BALANCE_WEI;

/**
 * Return wallets with enough RH gas to mint.
 * Uses shared readiness cache (one balance pass per mint window).
 * On RPC balance errors, KEEP the wallet (optimistic).
 */
export async function getFundedMintWallets(
  wallets?: Wallet[]
): Promise<{ funded: Wallet[]; skippedEmpty: number }> {
  const all = wallets ?? getAllMintWallets();
  const { getFundedFromReadiness } = await import("./walletReady");
  const { funded, skippedEmpty } = await getFundedFromReadiness(all);
  console.log(
    `[wallets] funded=${funded.length}/${all.length} skippedEmpty=${skippedEmpty}`
  );
  return { funded, skippedEmpty };
}

export async function gasIsAffordable(): Promise<boolean> {
  const fee = await getMintProvider().getFeeData();
  if (!fee.gasPrice) {
    return true;
  }
  const gwei = Number(fee.gasPrice) / 1e9;
  return gwei <= config.maxGasGwei;
}

export function currentMaxBuyRobinhood(): number {
  return getState().maxBuyRobinhood;
}
