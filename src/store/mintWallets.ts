import { JsonRpcProvider, Wallet } from "ethers";
import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { shortAddress } from "./state";

export interface MintWalletRecord {
  address: string;
  privateKey: string;
  label: string;
  addedAt: string;
}

let wallets: MintWalletRecord[] = [];
let saveQueue: Promise<void> = Promise.resolve();
let sharedProvider: JsonRpcProvider | null = null;

function walletsPath(): string {
  return config.mintWalletsPath;
}

function provider(): JsonRpcProvider {
  // Mint wallets send txs on the mint RPC (Alchemy).
  if (!sharedProvider) {
    sharedProvider = new JsonRpcProvider(config.mintRpcUrl);
  }
  return sharedProvider;
}

function normalizeKey(key: string): string {
  const k = key.trim();
  if (!k) {
    throw new Error("Empty private key");
  }
  const with0x = k.startsWith("0x") ? k : `0x${k}`;
  const w = new Wallet(with0x);
  return w.privateKey;
}

async function persist(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    const file = walletsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(wallets, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  });
  await saveQueue;
}

export async function loadMintWallets(): Promise<MintWalletRecord[]> {
  try {
    const raw = await fs.readFile(walletsPath(), "utf8");
    const parsed = JSON.parse(raw) as MintWalletRecord[];
    wallets = Array.isArray(parsed) ? parsed : [];
  } catch {
    wallets = [];
  }

  const envKeys = [config.privateKey, ...config.privateKeys].filter(Boolean);

  for (const key of envKeys) {
    try {
      const normalized = normalizeKey(key);
      const address = new Wallet(normalized).address.toLowerCase();
      if (!wallets.some((w) => w.address === address)) {
        wallets.push({
          address,
          privateKey: normalized,
          label: shortAddress(address),
          addedAt: new Date().toISOString(),
        });
      }
    } catch {
      console.warn("[wallets] skipped invalid key from env");
    }
  }

  if (envKeys.length > 0) {
    await persist();
  }

  return wallets;
}

export function listMintWallets(): MintWalletRecord[] {
  return wallets.map((w) => ({ ...w }));
}

/** Addresses + labels only — never expose private keys to Telegram. */
export function listMintWalletPublic(): Array<{
  address: string;
  label: string;
  addedAt: string;
}> {
  return wallets.map(({ address, label, addedAt }) => ({
    address,
    label,
    addedAt,
  }));
}

export function getMintWalletCount(): number {
  return wallets.length;
}

export async function addMintWallet(
  privateKey: string,
  label?: string
): Promise<{ address: string; label: string }> {
  const normalized = normalizeKey(privateKey);
  const address = new Wallet(normalized).address.toLowerCase();
  const existing = wallets.find((w) => w.address === address);
  if (existing) {
    if (label) {
      existing.label = label;
      await persist();
    }
    return { address: existing.address, label: existing.label };
  }

  const record: MintWalletRecord = {
    address,
    privateKey: normalized,
    label: label?.trim() || shortAddress(address),
    addedAt: new Date().toISOString(),
  };
  wallets.push(record);
  await persist();
  return { address: record.address, label: record.label };
}

export async function removeMintWallet(address: string): Promise<boolean> {
  const normalized = address.trim().toLowerCase();
  const before = wallets.length;
  wallets = wallets.filter((w) => w.address !== normalized);
  if (wallets.length !== before) {
    await persist();
    return true;
  }
  return false;
}

export function getEthersWallets(): Wallet[] {
  return wallets.map((w) => new Wallet(w.privateKey, provider()));
}
