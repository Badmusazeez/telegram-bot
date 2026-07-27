import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { config } from "../config";
import { getMintWalletCount, getEthersWallets } from "../store/mintWallets";
import { getState } from "../store/state";

let provider: JsonRpcProvider | null = null;
let primaryWallet: Wallet | null = null;

export function getProvider(): JsonRpcProvider {
  if (!provider) {
    provider = new JsonRpcProvider(config.rpcUrl);
  }
  return provider;
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
    primaryWallet = new Wallet(config.privateKey, getProvider());
  }
  return primaryWallet;
}

/** All mint wallets (multi-wallet). */
export function getAllMintWallets(): Wallet[] {
  return getEthersWallets();
}

export function mintWalletCount(): number {
  return getMintWalletCount();
}

export async function getNativeBalance(address: string): Promise<string> {
  const balance = await getProvider().getBalance(address);
  return formatEther(balance);
}

export async function gasIsAffordable(): Promise<boolean> {
  const fee = await getProvider().getFeeData();
  if (!fee.gasPrice) {
    return true;
  }
  const gwei = Number(fee.gasPrice) / 1e9;
  return gwei <= config.maxGasGwei;
}

export function currentMaxBuyRobinhood(): number {
  return getState().maxBuyRobinhood;
}
