import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { config } from "../config";
import { getMintWalletCount, getEthersWallets } from "../store/mintWallets";
import { getState } from "../store/state";

let trackProvider: JsonRpcProvider | null = null;
let mintProvider: JsonRpcProvider | null = null;
let primaryWallet: Wallet | null = null;

/** Tracker RPC — whale monitoring / eth_getLogs (Alchemy). */
export function getProvider(): JsonRpcProvider {
  if (!trackProvider) {
    trackProvider = new JsonRpcProvider(config.trackRpcUrl);
  }
  return trackProvider;
}

/** Mint RPC — send txs / gas estimates (Chainstack). */
export function getMintProvider(): JsonRpcProvider {
  if (!mintProvider) {
    mintProvider = new JsonRpcProvider(config.mintRpcUrl);
  }
  return mintProvider;
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
