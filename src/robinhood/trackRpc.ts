import { JsonRpcProvider } from "ethers";
import { config, rpcLabels } from "../config";
import { classifyTrackRpcError } from "./rpcHealth";

export type TrackRpcRole = "primary" | "backup";

export type TrackRpcSwitchEvent = {
  from: TrackRpcRole;
  to: TrackRpcRole;
  reason: string;
};

type SwitchHandler = (event: TrackRpcSwitchEvent) => Promise<void>;

let primary: JsonRpcProvider | null = null;
let backup: JsonRpcProvider | null = null;
let active: TrackRpcRole = "primary";
let onSwitch: SwitchHandler | null = null;

/** While on backup, retry primary after this many ms. */
const RECOVER_EVERY_MS = 2 * 60 * 1000;
/** Treat tracker calls slower than this as "slow" and failover. */
const SLOW_MS = 8_000;

let lastFailoverAt = 0;
let lastPrimaryProbeAt = 0;

function ensureProviders(): void {
  if (!primary) {
    primary = new JsonRpcProvider(config.trackRpcUrl);
  }
  if (!backup && config.trackBackupRpcUrl) {
    backup = new JsonRpcProvider(config.trackBackupRpcUrl);
  }
}

export function setTrackRpcSwitchHandler(handler: SwitchHandler | null): void {
  onSwitch = handler;
}

export function getActiveTrackRole(): TrackRpcRole {
  return active;
}

export function getTrackProvider(): JsonRpcProvider {
  ensureProviders();
  if (active === "backup" && backup) {
    return backup;
  }
  return primary!;
}

export function hasTrackBackup(): boolean {
  return Boolean(config.trackBackupRpcUrl);
}

function labelFor(role: TrackRpcRole): string {
  return role === "primary" ? rpcLabels.track : rpcLabels.trackBackup;
}

async function emitSwitch(
  from: TrackRpcRole,
  to: TrackRpcRole,
  reason: string
): Promise<void> {
  console.warn(
    `[track-rpc] switch ${from} → ${to} (${reason}) | now=${labelFor(to)}`
  );
  if (onSwitch) {
    await onSwitch({ from, to, reason });
  }
}

function shouldFailover(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Range-limit errors are config issues, not "RPC down".
  if (lower.includes("10 block") || lower.includes("block range")) {
    return false;
  }

  if (classifyTrackRpcError(err)) {
    return true;
  }

  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up") ||
    lower.includes("network error") ||
    lower.includes("server error") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504")
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`request timeout after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function switchTo(role: TrackRpcRole, reason: string): Promise<void> {
  if (active === role) return;
  if (role === "backup" && !backup) return;
  const from = active;
  active = role;
  if (role === "backup") {
    lastFailoverAt = Date.now();
  }
  await emitSwitch(from, role, reason);
}

/** Probe primary and move back when healthy. */
export async function maybeRecoverPrimary(): Promise<void> {
  ensureProviders();
  if (active !== "backup" || !primary) return;

  const now = Date.now();
  if (now - lastFailoverAt < RECOVER_EVERY_MS) return;
  if (now - lastPrimaryProbeAt < RECOVER_EVERY_MS) return;
  lastPrimaryProbeAt = now;

  try {
    await withTimeout(primary.getBlockNumber(), SLOW_MS);
    await switchTo("primary", "primary tracker healthy again");
  } catch (err) {
    console.warn(
      `[track-rpc] primary still unhealthy: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Run a tracker call on the active RPC.
 * On slow/fail of primary (Alchemy) → Chainstack backup.
 * While on backup, periodically try primary again.
 */
export async function withTrackRpc<T>(
  op: (provider: JsonRpcProvider) => Promise<T>
): Promise<T> {
  ensureProviders();
  await maybeRecoverPrimary();

  const role = active;
  const provider = getTrackProvider();

  try {
    return await withTimeout(op(provider), SLOW_MS);
  } catch (err) {
    if (role === "primary" && backup && shouldFailover(err)) {
      await switchTo(
        "backup",
        err instanceof Error ? err.message : String(err)
      );
      return await withTimeout(op(backup), SLOW_MS);
    }
    throw err;
  }
}
