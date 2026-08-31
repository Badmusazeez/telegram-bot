import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";

export type MonthlyBotStats = {
  /** YYYY-MM (UTC) */
  month: string;
  mintsOk: number;
  mintsFailed: number;
  /** Live mint txs broadcast (gas left wallets). */
  disbursements: number;
  /** Successful copy / schedule / snipe / claim sessions. */
  sweeps: number;
  /** Tracked-whale mint detections. */
  tracks: number;
  /** Sum of gasLimit (estimateGas-based) across successful mint txs. */
  gasUsedEstimate: number;
};

type StatsFile = {
  months: Record<string, MonthlyBotStats>;
};

const emptyMonth = (month: string): MonthlyBotStats => ({
  month,
  mintsOk: 0,
  mintsFailed: 0,
  disbursements: 0,
  sweeps: 0,
  tracks: 0,
  gasUsedEstimate: 0,
});

let cache: StatsFile = { months: {} };
let loaded = false;
let saveQueue: Promise<void> = Promise.resolve();

function statsPath(): string {
  return path.join(path.dirname(config.statePath), "bot-stats.json");
}

export function currentMonthKey(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function loadBotStats(): Promise<StatsFile> {
  if (loaded) return cache;
  try {
    const raw = await fs.readFile(statsPath(), "utf8");
    const parsed = JSON.parse(raw) as StatsFile;
    cache = { months: parsed.months ?? {} };
  } catch {
    cache = { months: {} };
  }
  loaded = true;
  return cache;
}

async function persist(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(path.dirname(statsPath()), { recursive: true });
    await fs.writeFile(statsPath(), JSON.stringify(cache, null, 2), "utf8");
  });
  await saveQueue;
}

function ensureMonth(month: string): MonthlyBotStats {
  if (!cache.months[month]) {
    cache.months[month] = emptyMonth(month);
  } else if (cache.months[month]!.gasUsedEstimate == null) {
    cache.months[month]!.gasUsedEstimate = 0;
  }
  return cache.months[month]!;
}

export type StatsDelta = Partial<
  Pick<
    MonthlyBotStats,
    | "mintsOk"
    | "mintsFailed"
    | "disbursements"
    | "sweeps"
    | "tracks"
    | "gasUsedEstimate"
  >
>;

/** Increment monthly counters (fire-and-forget safe). */
export async function recordBotStats(delta: StatsDelta): Promise<void> {
  await loadBotStats();
  const row = ensureMonth(currentMonthKey());
  if (delta.mintsOk) row.mintsOk += Math.max(0, Math.floor(delta.mintsOk));
  if (delta.mintsFailed) {
    row.mintsFailed += Math.max(0, Math.floor(delta.mintsFailed));
  }
  if (delta.disbursements) {
    row.disbursements += Math.max(0, Math.floor(delta.disbursements));
  }
  if (delta.sweeps) row.sweeps += Math.max(0, Math.floor(delta.sweeps));
  if (delta.tracks) row.tracks += Math.max(0, Math.floor(delta.tracks));
  if (delta.gasUsedEstimate) {
    row.gasUsedEstimate += Math.max(0, Math.floor(delta.gasUsedEstimate));
  }
  await persist();
}

export async function getMonthlyStats(
  month = currentMonthKey()
): Promise<MonthlyBotStats> {
  await loadBotStats();
  const row = cache.months[month];
  if (!row) return emptyMonth(month);
  return {
    ...emptyMonth(month),
    ...row,
    gasUsedEstimate: row.gasUsedEstimate ?? 0,
  };
}

/** Parse "N/M wallet(s)" style reasons into ok/fail counts. */
export function parseWalletOkFail(reason: string): {
  ok: number;
  fail: number;
} | null {
  const patterns = [
    /(\d+)\s*\/\s*(\d+)\s*(?:ready\s*)?wallet/i,
    /burst\s+(\d+)\s*\/\s*(\d+)/i,
    /SEND-ONLY burst\s+(\d+)\s*\/\s*(\d+)/i,
    /Snipe done:\s*(\d+)\s*\/\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = reason.match(re);
    if (!m) continue;
    const ok = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(ok) || !Number.isFinite(total) || total < 0) continue;
    return { ok: Math.max(0, ok), fail: Math.max(0, total - ok) };
  }
  return null;
}

/**
 * Record a mint session (copy / schedule / claim / snipe).
 * Dry-run sessions are ignored.
 */
export async function recordMintSession(params: {
  dryRun: boolean;
  success: boolean;
  attempted?: boolean;
  reason?: string;
  /** Explicit wallet-level counts when known. */
  okWallets?: number;
  failWallets?: number;
  /** Sum of gasLimit across successful wallet txs (estimateGas-based). */
  gasUsedEstimate?: number | bigint;
}): Promise<void> {
  if (params.dryRun) return;
  if (params.attempted === false) return;

  let ok = params.okWallets;
  let fail = params.failWallets;
  if ((ok == null || fail == null) && params.reason) {
    const parsed = parseWalletOkFail(params.reason);
    if (parsed) {
      ok = parsed.ok;
      fail = parsed.fail;
    }
  }
  if (ok == null && fail == null) {
    if (params.success) {
      ok = 1;
      fail = 0;
    } else {
      ok = 0;
      fail = 1;
    }
  }
  ok = ok ?? 0;
  fail = fail ?? 0;

  const gas =
    params.gasUsedEstimate != null
      ? Number(
          typeof params.gasUsedEstimate === "bigint"
            ? params.gasUsedEstimate
            : params.gasUsedEstimate
        )
      : 0;

  await recordBotStats({
    mintsOk: ok,
    mintsFailed: fail,
    disbursements: ok, // live mint txs that left the wallets
    sweeps: params.success ? 1 : 0,
    gasUsedEstimate: Number.isFinite(gas) && gas > 0 ? gas : 0,
  });
}

/** Whale detection from a tracked wallet. */
export async function recordTrackHit(): Promise<void> {
  await recordBotStats({ tracks: 1 });
}

/** Format gas units for Telegram (e.g. 12450000 → 12,450,000). */
export function formatGasUsedEstimate(gas: number): string {
  const n = Math.max(0, Math.floor(gas || 0));
  return n.toLocaleString("en-US");
}

export function formatMonthlyStatsMessage(
  stats: MonthlyBotStats,
  opts?: { trackedWallets?: number }
): string {
  const tracks =
    opts?.trackedWallets != null ? opts.trackedWallets : stats.tracks;
  return [
    `📊 <b>Stats</b> <i>(${stats.month} UTC)</i>`,
    `Mints OK: ${stats.mintsOk}`,
    `Mints failed: ${stats.mintsFailed}`,
    `Disbursements: ${stats.disbursements}`,
    `Sweeps: ${stats.sweeps}`,
    `Tracks: ${tracks}`,
    `Gas used (est): ${formatGasUsedEstimate(stats.gasUsedEstimate ?? 0)}`,
  ].join("\n");
}

/** Plain-text twin of the screenshot style (+ gas). */
export function formatMonthlyStatsPlain(stats: MonthlyBotStats): string {
  return [
    `📊 Stats`,
    `Mints OK: ${stats.mintsOk}`,
    `Mints failed: ${stats.mintsFailed}`,
    `Disbursements: ${stats.disbursements}`,
    `Sweeps: ${stats.sweeps}`,
    `Tracks: ${stats.tracks}`,
    `Gas used (est): ${formatGasUsedEstimate(stats.gasUsedEstimate ?? 0)}`,
  ].join("\n");
}
