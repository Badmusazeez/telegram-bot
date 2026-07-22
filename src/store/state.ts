import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { BotState, Side, TradeSignal } from "../types";

const defaultState = (): BotState => ({
  notifyChatIds: [],
  paused: false,
  stats: {
    lastScanAt: null,
    lastScanDurationMs: 0,
    pairsScanned: 0,
    signalsFound: 0,
    alertsSent: 0,
    errors: 0,
    running: false,
    lastError: null,
  },
  recentSignalIds: [],
  lastSignals: {},
});

let state: BotState = defaultState();

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export async function loadState(): Promise<BotState> {
  try {
    if (fs.existsSync(config.statePath)) {
      const raw = JSON.parse(fs.readFileSync(config.statePath, "utf8")) as Partial<BotState>;
      state = {
        ...defaultState(),
        ...raw,
        stats: { ...defaultState().stats, ...(raw.stats ?? {}) },
        lastSignals: raw.lastSignals ?? {},
        recentSignalIds: raw.recentSignalIds ?? [],
        notifyChatIds: raw.notifyChatIds ?? [],
      };
    } else {
      state = defaultState();
      await saveState();
    }
  } catch {
    state = defaultState();
  }
  return state;
}

export async function saveState(): Promise<void> {
  ensureDir(config.statePath);
  fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2), "utf8");
}

export function getState(): BotState {
  return state;
}

export async function updateState(
  mutator: (s: BotState) => void
): Promise<BotState> {
  mutator(state);
  await saveState();
  return state;
}

export async function registerNotifyChat(chatId: string): Promise<void> {
  await updateState((s) => {
    if (!s.notifyChatIds.includes(chatId)) {
      s.notifyChatIds.push(chatId);
    }
  });
}

export function isOnCooldown(symbol: string, side: Side, now = Date.now()): boolean {
  const prev = state.lastSignals[symbol];
  if (!prev) return false;
  if (prev.side !== side) return false;
  return now - prev.at < config.signalCooldownMs;
}

export async function rememberSignal(signal: TradeSignal): Promise<void> {
  await updateState((s) => {
    s.lastSignals[signal.symbol] = { side: signal.side, at: signal.createdAt };
    s.recentSignalIds = [signal.id, ...s.recentSignalIds].slice(0, 100);
    s.stats.signalsFound += 1;
  });
}

export async function markAlertSent(): Promise<void> {
  await updateState((s) => {
    s.stats.alertsSent += 1;
  });
}

export async function setPaused(paused: boolean): Promise<void> {
  await updateState((s) => {
    s.paused = paused;
  });
}
