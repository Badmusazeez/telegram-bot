import { config } from "../config";
import { getState, markScheduledMint } from "../store/state";
import type { ScheduledMint, ScheduledMintResult } from "../types";
import { mintSelectorLabel, resolveMintGasLimit } from "./mintGas";
import {
  invalidateWalletNonce,
  warmWalletNonce,
  withWalletNonce,
} from "./nonceManager";
import {
  gasIsAffordable,
  getAllMintWallets,
  getProvider,
} from "./provider";
import {
  checkMintWalletReadiness,
  clearWalletReadinessCache,
} from "./walletReady";
import type { Wallet } from "ethers";

export type ScheduleHandler = (
  job: ScheduledMint,
  result: ScheduledMintResult
) => Promise<void>;

/** Lead time for real pre-arm (gas + nonce). Fire path is SEND-ONLY. */
const DEFAULT_LEAD_MS = 30_000;
/** Jobs currently in sharp fine-wait (avoid double-fire from poll). */
const sharpArmed = new Set<string>();

type ArmedScheduledTx = {
  wallet: Wallet;
  to: string;
  data: string;
  valueWei: bigint;
  gasLimit: bigint;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run async work over items with bounded concurrency. */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

export function parseScheduleTime(raw: string): Date | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  // Relative: +30s / +10m / +2h / +1d
  const rel = text.match(/^\+(\d+)([smhd])$/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult =
      unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
    return new Date(Date.now() + amount * mult);
  }

  if (/^\d{10}$/.test(text)) {
    return new Date(Number(text) * 1000);
  }
  if (/^\d{13}$/.test(text)) {
    return new Date(Number(text));
  }

  const iso = new Date(text);
  if (!Number.isNaN(iso.getTime())) {
    return iso;
  }
  return null;
}

/** Resolve short mint presets or raw hex calldata. */
export function resolveCalldata(raw: string, buyer: string): string | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();
  if (lower === "mint") {
    return "0x1249c58b";
  }
  if (lower === "mint1") {
    return (
      "0xa0712d68" +
      "0000000000000000000000000000000000000000000000000000000000000001"
    );
  }

  void buyer;

  if (
    /^0x[0-9a-fA-F]+$/.test(text) &&
    text.length >= 10 &&
    text.length % 2 === 0
  ) {
    return text.toLowerCase();
  }
  return null;
}

/** Coarse then fine wait until exact fire time (sharp mode). */
async function waitUntilExact(fireAtMs: number): Promise<void> {
  for (;;) {
    const left = fireAtMs - Date.now();
    if (left <= 0) return;
    const wait =
      left > 200 ? Math.min(left - 100, 1_000) : Math.min(left, 10);
    await sleep(Math.max(3, wait));
  }
}

/**
 * Pre-arm during lead window: estimateGas + nonce warm.
 * Fire path must only send.
 */
async function prepareArmedTxs(
  job: ScheduledMint,
  wallets: Wallet[]
): Promise<ArmedScheduledTx[]> {
  const provider = getProvider();
  const valueWei = BigInt(job.valueWei || "0");
  const armed: ArmedScheduledTx[] = [];

  await mapPool(wallets, 6, async (wallet) => {
    try {
      await warmWalletNonce(wallet.address, provider).catch(() => undefined);
      let gasLimit: bigint;
      try {
        const estimated = await provider.estimateGas({
          from: wallet.address,
          to: job.to,
          data: job.data,
          value: valueWei,
        });
        const resolved = resolveMintGasLimit({
          estimated,
          ceiling: config.maxMintGasLimit,
          marginPct: 25,
        });
        if (!resolved.ok) {
          console.warn(
            `[schedule:arm] skip ${wallet.address.slice(0, 8)}… gas: ${resolved.reason}`
          );
          return;
        }
        gasLimit = resolved.gasLimit;
        console.log(
          `[schedule:arm] ${wallet.address.slice(0, 8)}… fn=${mintSelectorLabel(job.data)} ` +
            `estimate=${estimated} gasLimit=${gasLimit}`
        );
      } catch (err) {
        // Pre-window revert is common for timed stages — arm with safe ceiling.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          /revert|execution|not (yet |)?(live|open|started)|too early|before|closed/i.test(
            msg
          )
        ) {
          gasLimit = BigInt(
            Math.min(Math.floor(config.maxMintGasLimit * 0.35), 700_000)
          );
          console.log(
            `[schedule:arm] ${wallet.address.slice(0, 8)}… pre-window → gasLimit=${gasLimit}`
          );
        } else {
          console.warn(
            `[schedule:arm] skip ${wallet.address.slice(0, 8)}… ${msg.slice(0, 120)}`
          );
          return;
        }
      }
      armed.push({
        wallet,
        to: job.to,
        data: job.data,
        valueWei,
        gasLimit,
      });
    } catch (err) {
      console.warn(
        `[schedule:arm] prepare failed ${wallet.address.slice(0, 8)}… ${
          err instanceof Error ? err.message.slice(0, 120) : err
        }`
      );
    }
  });

  return armed;
}

/** Send-only burst — no estimateGas at fire. */
async function burstArmedSends(
  armed: ArmedScheduledTx[]
): Promise<
  Array<{
    address: string;
    ok: boolean;
    txHash?: string;
    error?: string;
  }>
> {
  const provider = getProvider();

  return Promise.all(
    armed.map(async (a, index) => {
      const address = a.wallet.address.toLowerCase();
      if (index > 0) await sleep(Math.min(index * 3, 40));
      try {
        const connected = a.wallet.connect(provider);
        const sent = await withWalletNonce({
          address,
          provider,
          fn: async (nonce) =>
            connected.sendTransaction({
              to: a.to,
              data: a.data,
              value: a.valueWei,
              gasLimit: a.gasLimit,
              nonce,
              chainId: Number(config.chain.chainId),
            }),
        });
        // Don't await receipt in the burst — that serializes latency.
        void sent.wait().catch(() => undefined);
        return { address, ok: true as const, txHash: sent.hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nonce/i.test(msg)) invalidateWalletNonce(address);
        return { address, ok: false as const, error: msg };
      }
    })
  );
}

/** Cold path (slower) — estimateGas then send; used if pre-arm produced nothing. */
async function sendOnWalletCold(
  wallet: Wallet,
  job: ScheduledMint
): Promise<{ address: string; ok: boolean; txHash?: string; error?: string }> {
  const address = wallet.address.toLowerCase();
  const provider = getProvider();
  const value = BigInt(job.valueWei || "0");
  try {
    const gasEstimate = await provider.estimateGas({
      from: wallet.address,
      to: job.to,
      data: job.data,
      value,
    });
    const resolved = resolveMintGasLimit({
      estimated: gasEstimate,
      ceiling: config.maxMintGasLimit,
      marginPct: 20,
    });
    if (!resolved.ok) {
      return { address, ok: false, error: resolved.reason };
    }

    const sent = await withWalletNonce({
      address,
      provider,
      fn: async (nonce) =>
        wallet.connect(provider).sendTransaction({
          to: job.to,
          data: job.data,
          value,
          gasLimit: resolved.gasLimit,
          nonce,
          chainId: Number(config.chain.chainId),
        }),
    });
    void sent.wait().catch(() => undefined);
    return { address, ok: true, txHash: sent.hash };
  } catch (err) {
    return {
      address,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeJobCold(job: ScheduledMint): Promise<ScheduledMintResult> {
  const state = getState();
  const wallets = getAllMintWallets();
  const value = BigInt(job.valueWei || "0");

  if (state.dryRun) {
    return {
      success: true,
      dryRun: true,
      reason: `DRY RUN — would mint on ${wallets.length || 0} wallet(s) at ${job.executeAt} to ${job.to}${
        value > 0n ? ` value=${value}` : ""
      }`,
    };
  }

  if (wallets.length === 0) {
    return {
      success: false,
      dryRun: false,
      reason: "No mint wallets configured. Use /addkey or PRIVATE_KEY(S).",
    };
  }

  if (!(await gasIsAffordable())) {
    return {
      success: false,
      dryRun: false,
      reason: `Gas above MAX_GAS_GWEI (${config.maxGasGwei}).`,
    };
  }

  const results = await Promise.all(
    wallets.map((w) => sendOnWalletCold(w, job))
  );
  const ok = results.filter((r) => r.ok);
  const summary = results
    .map(
      (r) =>
        `${r.address.slice(0, 6)}…${r.ok ? ` OK ${r.txHash?.slice(0, 10)}…` : ` FAIL (${r.error})`}`
    )
    .join(" | ");

  return {
    success: ok.length > 0,
    dryRun: false,
    reason:
      ok.length > 0
        ? `Cold mint on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `Cold mint failed on all ${wallets.length} wallet(s): ${summary}`,
    txHash: ok[0]?.txHash,
  };
}

async function runSharpJob(
  job: ScheduledMint,
  onDone: ScheduleHandler
): Promise<void> {
  if (sharpArmed.has(job.id)) return;
  sharpArmed.add(job.id);

  try {
    const fireAt = new Date(job.executeAt).getTime();
    const leadMs = job.leadMs ?? DEFAULT_LEAD_MS;
    const armAt = fireAt - leadMs;

    // Coarse wait until T-lead.
    while (Date.now() < armAt - 50) {
      const left = armAt - Date.now();
      await sleep(Math.min(Math.max(left - 25, 50), 2_000));
      const cur = getState().scheduledMints.find((j) => j.id === job.id);
      if (!cur || cur.status !== "pending") {
        console.log(`[schedule] sharp aborted ${job.id} status=${cur?.status}`);
        return;
      }
    }

    const state = getState();
    clearWalletReadinessCache();
    const allWallets = getAllMintWallets();
    const readiness = await checkMintWalletReadiness(allWallets);
    const wallets =
      readiness.ready.length > 0 ? readiness.ready : allWallets;

    console.log(
      `[schedule] ⚡ sharp PRE-ARM ${job.id} ` +
        `T-${Math.round(leadMs / 1000)}s → ${job.executeAt} · wallets=${wallets.length}/${allWallets.length}`
    );

    if (state.dryRun) {
      await waitUntilExact(fireAt);
      const result: ScheduledMintResult = {
        success: true,
        dryRun: true,
        reason: `DRY RUN — pre-armed ${wallets.length}/${allWallets.length} wallet(s) for sharp SEND-ONLY burst at ${job.executeAt}`,
      };
      await markScheduledMint(job.id, {
        status: "done",
        resultReason: result.reason,
        finishedAt: new Date().toISOString(),
      });
      await onDone(job, result);
      return;
    }

    if (wallets.length === 0) {
      await markScheduledMint(job.id, {
        status: "failed",
        resultReason: "No mint wallets configured.",
        finishedAt: new Date().toISOString(),
      });
      await onDone(job, {
        success: false,
        dryRun: false,
        reason: "No mint wallets configured.",
      });
      return;
    }

    // REAL PREP before window open (gas + nonce).
    const prepStarted = Date.now();
    let armed = await prepareArmedTxs(job, wallets);
    const prepMs = Date.now() - prepStarted;
    console.log(
      `[schedule] ✅ pre-armed ${armed.length}/${wallets.length} wallet(s) in ${prepMs}ms — waiting for exact open`
    );

    // Retry thin arms until ~1.5s before open.
    while (armed.length < wallets.length && Date.now() < fireAt - 1_500) {
      const have = new Set(armed.map((a) => a.wallet.address.toLowerCase()));
      const missing = wallets.filter((w) => !have.has(w.address.toLowerCase()));
      if (missing.length === 0) break;
      console.log(
        `[schedule] retry-arm ${missing.length} wallet(s) still missing…`
      );
      const more = await prepareArmedTxs(job, missing);
      armed = [...armed, ...more];
      await sleep(200);
    }

    await waitUntilExact(fireAt);

    const cur = getState().scheduledMints.find((j) => j.id === job.id);
    if (!cur || cur.status !== "pending") return;

    // Don't block the burst on disk I/O.
    void markScheduledMint(job.id, { status: "running" });

    if (armed.length === 0) {
      console.warn(`[schedule] ⚠️ no pre-armed txs — cold fallback (slower)`);
      const result = await executeJobCold(job);
      await markScheduledMint(job.id, {
        status: result.success ? "done" : "failed",
        resultReason: result.reason,
        resultTxHash: result.txHash,
        finishedAt: new Date().toISOString(),
      });
      await onDone(job, result);
      return;
    }

    console.log(
      `[schedule] 🚀 sharp SEND-ONLY BURST ${job.id} → ${armed.length} wallet(s)`
    );
    const burstStarted = Date.now();
    const results = await burstArmedSends(armed);
    const burstMs = Date.now() - burstStarted;
    const ok = results.filter((r) => r.ok);
    const summary = results
      .map(
        (r) =>
          `${r.address.slice(0, 6)}…${
            r.ok
              ? ` OK ${r.txHash?.slice(0, 10)}…`
              : ` FAIL (${r.error})`
          }`
      )
      .join(" | ");
    const firstOk = results.find((r) => r.ok && r.txHash);
    const result: ScheduledMintResult = {
      success: ok.length > 0,
      dryRun: false,
      reason:
        ok.length > 0
          ? `Sharp SEND-ONLY burst ${ok.length}/${armed.length} in ${burstMs}ms (pre-arm ${prepMs}ms): ${summary}`
          : `Sharp SEND-ONLY burst failed all ${armed.length} in ${burstMs}ms: ${summary}`,
      txHash: firstOk?.txHash,
    };

    await markScheduledMint(job.id, {
      status: result.success ? "done" : "failed",
      resultReason: result.reason,
      resultTxHash: result.txHash,
      finishedAt: new Date().toISOString(),
    });
    await onDone(job, result);
  } catch (err) {
    console.error(`[schedule] sharp failed ${job.id}:`, err);
    const reason = err instanceof Error ? err.message : String(err);
    await markScheduledMint(job.id, {
      status: "failed",
      resultReason: reason,
      finishedAt: new Date().toISOString(),
    });
    await onDone(job, { success: false, dryRun: false, reason });
  } finally {
    sharpArmed.delete(job.id);
  }
}

export async function startMintScheduler(
  onDone: ScheduleHandler
): Promise<() => void> {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const now = Date.now();
      const pending = getState().scheduledMints.filter(
        (j) => j.status === "pending"
      );

      for (const job of pending) {
        const fireAt = new Date(job.executeAt).getTime();
        const leadMs = job.leadMs ?? DEFAULT_LEAD_MS;
        const useSharp = job.sharpMode !== false; // default ON

        if (useSharp) {
          if (fireAt - now <= leadMs + 3_000 && !sharpArmed.has(job.id)) {
            void runSharpJob(job, onDone);
          }
          continue;
        }

        if (fireAt <= now && !sharpArmed.has(job.id)) {
          sharpArmed.add(job.id);
          try {
            await markScheduledMint(job.id, { status: "running" });
            console.log(`[schedule] cold running ${job.id} -> ${job.to}`);
            const result = await executeJobCold(job);
            await markScheduledMint(job.id, {
              status: result.success ? "done" : "failed",
              resultReason: result.reason,
              resultTxHash: result.txHash,
              finishedAt: new Date().toISOString(),
            });
            await onDone(job, result);
          } finally {
            sharpArmed.delete(job.id);
          }
        }
      }
    } catch (err) {
      console.error("[schedule] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, 1_000);
  void tick();

  console.log(
    "[schedule] sharp mode ON — T-30s REAL pre-arm (gas+nonce) → exact timer → SEND-ONLY burst"
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
