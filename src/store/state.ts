import { promises as fs } from "fs";
import path from "path";
import { isAddress } from "ethers";
import { config } from "../config";
import type {
  BotState,
  ScheduledMint,
  ScheduledMintStatus,
  TrackedWallet,
  WatchedPriceItem,
} from "../types";

const DEFAULT_STATE: BotState = {
  trackedWallets: [],
  copyEnabled: config.copyEnabled,
  dryRun: config.dryRun,
  freeMintsOnly: config.freeMintsOnly,
  privateMintsEnabled: config.privateMintsEnabled,
  priceAlertsEnabled: config.priceAlertsEnabled,
  priceAlertPct: config.priceAlertPct,
  maxBuyEth: config.maxBuyEth,
  allowedCollections: [...config.allowedCollections],
  lastProcessedBlock: 0,
  notifyChatIds: [...config.allowedChatIds],
  recentTxHashes: [],
  watchedPrices: [],
  scheduledMints: [],
};

let state: BotState = structuredClone(DEFAULT_STATE);
let saveQueue: Promise<void> = Promise.resolve();

function migrateLegacyState(parsed: Partial<BotState> & Record<string, unknown>): Partial<BotState> {
  const next: Partial<BotState> & Record<string, unknown> = { ...parsed };
  if (next.privateMintsEnabled === undefined) {
    next.privateMintsEnabled = config.privateMintsEnabled;
  }
  // Older local drafts may omit valueWei on scheduled jobs.
  if (Array.isArray(next.scheduledMints)) {
    next.scheduledMints = (next.scheduledMints as ScheduledMint[]).map((j) => ({
      ...j,
      valueWei: j.valueWei ?? "0",
    }));
  }
  return next;
}

export async function loadState(): Promise<BotState> {
  try {
    const raw = await fs.readFile(config.statePath, "utf8");
    const parsed = migrateLegacyState(JSON.parse(raw) as Partial<BotState>);
    state = {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      trackedWallets: parsed.trackedWallets ?? [],
      freeMintsOnly: parsed.freeMintsOnly ?? config.freeMintsOnly,
      privateMintsEnabled:
        parsed.privateMintsEnabled ?? config.privateMintsEnabled,
      priceAlertsEnabled:
        parsed.priceAlertsEnabled ?? config.priceAlertsEnabled,
      priceAlertPct: parsed.priceAlertPct ?? config.priceAlertPct,
      maxBuyEth: parsed.maxBuyEth ?? config.maxBuyEth,
      allowedCollections: parsed.allowedCollections ?? [
        ...config.allowedCollections,
      ],
      notifyChatIds:
        parsed.notifyChatIds && parsed.notifyChatIds.length > 0
          ? parsed.notifyChatIds
          : [...config.allowedChatIds],
      recentTxHashes: parsed.recentTxHashes ?? [],
      watchedPrices: parsed.watchedPrices ?? [],
      scheduledMints: (parsed.scheduledMints ?? []).map((j) => ({
        ...j,
        valueWei: j.valueWei ?? "0",
      })),
    };
  } catch {
    state = structuredClone(DEFAULT_STATE);
    await persistState();
  }

  await seedTrackedWalletsFromEnv();
  return state;
}

/** Seed TRACKED_WALLETS from .env without wiping wallets added via Telegram. */
async function seedTrackedWalletsFromEnv(): Promise<void> {
  if (config.trackedWalletsEnv.length === 0) {
    return;
  }
  let changed = false;
  for (const entry of config.trackedWalletsEnv) {
    if (!isAddress(entry.address)) {
      console.warn(`[state] skipping invalid TRACKED_WALLETS address: ${entry.address}`);
      continue;
    }
    const normalized = normalizeAddress(entry.address);
    const existing = state.trackedWallets.find((w) => w.address === normalized);
    if (existing) {
      if (entry.label && entry.label !== existing.label) {
        existing.label = entry.label;
        changed = true;
      }
      continue;
    }
    state.trackedWallets.push({
      address: normalized,
      label: entry.label || shortAddress(normalized),
      addedAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) {
    await persistState();
  }
}

export function getState(): BotState {
  return state;
}

async function persistState(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(path.dirname(config.statePath), { recursive: true });
    await fs.writeFile(config.statePath, JSON.stringify(state, null, 2), "utf8");
  });
  await saveQueue;
}

export async function updateState(
  mutator: (current: BotState) => void
): Promise<BotState> {
  mutator(state);
  await persistState();
  return state;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export async function addTrackedWallet(
  address: string,
  label: string
): Promise<TrackedWallet> {
  const normalized = normalizeAddress(address);
  const existing = state.trackedWallets.find((w) => w.address === normalized);
  if (existing) {
    existing.label = label || existing.label;
    await persistState();
    return existing;
  }

  const wallet: TrackedWallet = {
    address: normalized,
    label: label || shortAddress(normalized),
    addedAt: new Date().toISOString(),
  };
  state.trackedWallets.push(wallet);
  await persistState();
  return wallet;
}

export async function removeTrackedWallet(address: string): Promise<boolean> {
  const normalized = normalizeAddress(address);
  const before = state.trackedWallets.length;
  state.trackedWallets = state.trackedWallets.filter(
    (w) => w.address !== normalized
  );
  if (state.trackedWallets.length !== before) {
    await persistState();
    return true;
  }
  return false;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function rememberTx(txHash: string): Promise<boolean> {
  const key = txHash.toLowerCase();
  if (state.recentTxHashes.includes(key)) {
    return false;
  }
  state.recentTxHashes.push(key);
  if (state.recentTxHashes.length > 500) {
    state.recentTxHashes = state.recentTxHashes.slice(-500);
  }
  await persistState();
  return true;
}

export async function registerNotifyChat(chatId: string): Promise<void> {
  if (!state.notifyChatIds.includes(chatId)) {
    state.notifyChatIds.push(chatId);
    await persistState();
  }
}

export function watchId(contract: string, tokenId = ""): string {
  return `${normalizeAddress(contract)}:${tokenId || "floor"}`;
}

export async function addWatchedPrice(params: {
  contract: string;
  tokenId?: string;
  label?: string;
}): Promise<WatchedPriceItem> {
  const contract = normalizeAddress(params.contract);
  const tokenId = params.tokenId?.trim() || "";
  const id = watchId(contract, tokenId);
  const existing = state.watchedPrices.find((w) => w.id === id);
  if (existing) {
    if (params.label) {
      existing.label = params.label;
      await persistState();
    }
    return existing;
  }

  const item: WatchedPriceItem = {
    id,
    contract,
    tokenId,
    label:
      params.label ||
      (tokenId
        ? `${shortAddress(contract)} #${tokenId}`
        : `${shortAddress(contract)} floor`),
    lastPrice: null,
    lastCheckedAt: null,
    addedAt: new Date().toISOString(),
  };
  state.watchedPrices.push(item);
  await persistState();
  return item;
}

export async function removeWatchedPrice(
  contract: string,
  tokenId = ""
): Promise<boolean> {
  const id = watchId(contract, tokenId);
  const before = state.watchedPrices.length;
  state.watchedPrices = state.watchedPrices.filter((w) => w.id !== id);
  if (state.watchedPrices.length !== before) {
    await persistState();
    return true;
  }
  return false;
}

export async function updateWatchedPrice(
  id: string,
  price: number
): Promise<void> {
  const item = state.watchedPrices.find((w) => w.id === id);
  if (!item) {
    return;
  }
  item.lastPrice = price;
  item.lastCheckedAt = new Date().toISOString();
  await persistState();
}

function newScheduleId(): string {
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function addScheduledMint(params: {
  label: string;
  to: string;
  data: string;
  executeAt: Date;
  sourceTxHash?: string;
  valueWei?: string;
}): Promise<ScheduledMint> {
  const job: ScheduledMint = {
    id: newScheduleId(),
    label: params.label,
    to: normalizeAddress(params.to),
    data: params.data.toLowerCase(),
    valueWei: params.valueWei ?? "0",
    executeAt: params.executeAt.toISOString(),
    createdAt: new Date().toISOString(),
    status: "pending",
    sourceTxHash: params.sourceTxHash?.toLowerCase(),
  };
  state.scheduledMints.push(job);
  await persistState();
  return job;
}

export async function cancelScheduledMint(id: string): Promise<boolean> {
  const job = state.scheduledMints.find((j) => j.id === id);
  if (!job || job.status !== "pending") {
    return false;
  }
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  job.resultReason = "Cancelled by user.";
  await persistState();
  return true;
}

export async function markScheduledMint(
  id: string,
  patch: {
    status: ScheduledMintStatus;
    resultReason?: string;
    resultTxHash?: string;
    finishedAt?: string;
  }
): Promise<void> {
  const job = state.scheduledMints.find((j) => j.id === id);
  if (!job) {
    return;
  }
  job.status = patch.status;
  if (patch.resultReason !== undefined) {
    job.resultReason = patch.resultReason;
  }
  if (patch.resultTxHash !== undefined) {
    job.resultTxHash = patch.resultTxHash;
  }
  if (patch.finishedAt !== undefined) {
    job.finishedAt = patch.finishedAt;
  }
  await persistState();
}
