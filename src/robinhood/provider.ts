import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";

let provider: JsonRpcProvider | null = null;
let wallet: Wallet | null = null;

export function getProvider(): JsonRpcProvider {
  if (!provider) {
    provider = new JsonRpcProvider(config.rpcUrl);
  }
  return provider;
}

export function getWallet(): Wallet | null {
  if (!config.privateKey) {
    return null;
  }
  if (!wallet) {
    wallet = new Wallet(config.privateKey, getProvider());
  }
  return wallet;
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
