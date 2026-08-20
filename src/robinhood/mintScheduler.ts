import { config } from "../config";
import {
  getState,
  markScheduledMint,
} from "../store/state";
import type { ScheduledMint, ScheduledMintResult } from "../types";
import {
  buildOpenSeaDropMintTx,
  fetchOpenSeaDrop,
} from "./openseaDrop";
import { openSeaStageMaxPerWallet } from "./multiMint";
import { maxMintQuantityLadder } from "./mintQuantity";
import { resolveMintGasLimit, mintSelectorLabel } from "./mintGas";
import {
  gasIsAffordable,
  getAllMintWallets,
  getMintProvider,
} from "./provider";
import { withWalletNonce, invalidateWalletNonce } from "./nonceManager";
import type { Wallet } from "ethers";

export type ScheduleHandler = (
  job: ScheduledMint,
  result: ScheduledMintResult
) => Promise<void>;

const DEFAULT_LEAD_MS = 15_000;
/** Jobs currently in sharp fine-wait (avoid double-fire from poll). */
const sharpArmed = new Set<string>();

export function parseScheduleTime(raw: string): Date | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  // Relative: +30s / +10m / +2h
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

  // Unix seconds
  if (/^\d{10}$/.test(text)) {
    return new Date(Number(text) * 1000);
  }

  // Unix ms
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
  if (lower === "mintmax" || lower === "max") {
    const q = maxMintQuantityLadder()[0] || 50;
    return "0xa0712d68" + BigInt(q).toString(16).padStart(64, "0");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Coarse then fine wait until exact fire time (sharp mode). */
async function waitUntilExact(fireAtMs: number): Promise<void> {
  for (;;) {
    const left = fireAtMs - Date.now();
    if (left <= 0) return;
    const wait =
      left > 200 ? Math.min(left - 100, 1_000) : Math.min(left, 20);
    await sleep(Math.max(5, wait));
  }
}

async function sendOnWallet(
  wallet: Wallet,
  params: { to: string; data: string; valueWei?: bigint }
): Promise<{ address: string; ok: boolean; txHash?: string; error?: string }> {
  const address = wallet.address.toLowerCase();
  const provider = getMintProvider();
  const value = params.valueWei ?? 0n;
  try {
    const estimated = await provider.estimateGas({
      from: wallet.address,
      to: params.to,
      data: params.data,
      value,
    });

    const resolved = resolveMintGasLimit({
      estimated,
      ceiling: config.maxMintGasLimit,
      marginPct: 20,
    });
    console.log(
      `[schedule:gas] fn=${mintSelectorLabel(params.data)} estimateGas=${estimated} ` +
        `ceiling=${resolved.ceiling} gasLimit=${resolved.ok ? resolved.gasLimit : 0}`
    );
    if (!resolved.ok) {
      return { address, ok: false, error: resolved.reason };
    }

    const connected = wallet.connect(provider);
    const sent = await withWalletNonce({
      address,
      provider,
      fn: async (nonce) =>
        connected.sendTransaction({
          to: params.to,
          data: params.data,
          value,
          gasLimit: resolved.gasLimit,
          nonce,
          chainId: Number(config.chain.chainId),
        }),
    });
    void sent.wait().catch(() => undefined);
    return { address, ok: true, txHash: sent.hash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/nonce/i.test(msg)) invalidateWalletNonce(address);
    return { address, ok: false, error: msg };
  }
}

function stagePriceWei(price?: string): bigint {
  if (!price) return 0n;
  try {
    return BigInt(price);
  } catch {
    return 0n;
  }
}

async function resolveJobTxForWallet(
  job: ScheduledMint,
  wallet: Wallet
): Promise<{ to: string; data: string; valueWei: bigint; quantity?: number }> {
  if (job.openSeaSlug) {
    const drop = await fetchOpenSeaDrop(job.openSeaSlug);
    const stage =
      (drop.is_minting && drop.active_stage) ||
      drop.stages.find((s) => stagePriceWei(s.price) === 0n) ||
      drop.active_stage ||
      null;
    if (!stage) {
      throw new Error("No OpenSea drop stage for scheduled mint");
    }
    if (stagePriceWei(stage.price) > 0n) {
      throw new Error("OpenSea stage is paid — free-mint only");
    }
    const target = openSeaStageMaxPerWallet(stage);
    const ladder = maxMintQuantityLadder(target).filter((q) => q <= target);
    let lastErr: Error | null = null;
    for (const quantity of ladder) {
      try {
        const built = await buildOpenSeaDropMintTx({
          slug: job.openSeaSlug,
          minter: wallet.address,
          quantity,
        });
        if (built.valueWei > 0n) {
          throw new Error(
            `OpenSea mint requires payment (${built.valueWei} wei) — free-mint only.`
          );
        }
        return { ...built, quantity };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr || new Error("OpenSea scheduled max mint failed");
  }
  return { to: job.to, data: job.data, valueWei: 0n };
}

async function executeJob(job: ScheduledMint): Promise<ScheduledMintResult> {
  const state = getState();
  const wallets = getAllMintWallets();

  if (state.dryRun) {
    return {
      success: true,
      dryRun: true,
      reason: `DRY RUN — sharp burst would MAX-mint on ${wallets.length || 0} wallet(s) at ${job.executeAt} to ${job.to}${
        job.openSeaSlug ? ` (OpenSea drop ${job.openSeaSlug})` : ""
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

  // Parallel burst across all mint wallets (nonce-safe per wallet).
  const results = await Promise.all(
    wallets.map(async (w, index) => {
      if (index > 0) await sleep(Math.min(index * 12, 250));
      try {
        const tx = await resolveJobTxForWallet(job, w);
        const sent = await sendOnWallet(w, tx);
        return {
          ...sent,
          detail: tx.quantity ? `x${tx.quantity}` : undefined,
        };
      } catch (err) {
        return {
          address: w.address.toLowerCase(),
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );
  const ok = results.filter((r) => r.ok);
  const summary = results
    .map(
      (r) =>
        `${r.address.slice(0, 6)}…${
          r.ok
            ? ` OK ${r.txHash?.slice(0, 10)}…${r.detail ? ` ${r.detail}` : ""}`
            : ` FAIL (${r.error})`
        }`
    )
    .join(" | ");

  const firstOk = results.find((r) => r.ok && r.txHash);

  return {
    success: ok.length > 0,
    dryRun: false,
    reason:
      ok.length > 0
        ? `Sharp burst MAX mint on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `Sharp burst failed on all ${wallets.length} wallet(s): ${summary}`,
    txHash: firstOk && "txHash" in firstOk ? firstOk.txHash : undefined,
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
      // Cancelled?
      const cur = getState().scheduledMints.find((j) => j.id === job.id);
      if (!cur || cur.status !== "pending") {
        console.log(`[schedule] sharp aborted ${job.id} status=${cur?.status}`);
        return;
      }
    }

    console.log(
      `[schedule] ⚡ sharp armed #${job.scheduleNumber ?? "?"} ` +
        `T-${Math.round(leadMs / 1000)}s → ${job.executeAt}`
    );

    await waitUntilExact(fireAt);

    const cur = getState().scheduledMints.find((j) => j.id === job.id);
    if (!cur || cur.status !== "pending") return;

    await markScheduledMint(job.id, { status: "running" });
    console.log(`[schedule] 🚀 sharp BURST ${job.id} -> ${job.to}`);
    const result = await executeJob(job);
    await markScheduledMint(job.id, {
      status: result.success ? "done" : "failed",
      resultReason: result.reason,
      resultTxHash: result.txHash,
      finishedAt: new Date().toISOString(),
    });
    await onDone(job, result);
  } catch (err) {
    console.error(`[schedule] sharp failed ${job.id}:`, err);
    await markScheduledMint(job.id, {
      status: "failed",
      resultReason: err instanceof Error ? err.message : String(err),
      finishedAt: new Date().toISOString(),
    });
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
          // Arm when within lead window (+ small buffer for poll lag).
          if (fireAt - now <= leadMs + 3_000 && !sharpArmed.has(job.id)) {
            void runSharpJob(job, onDone);
          }
          continue;
        }

        // Legacy non-sharp: fire when due (2s poll).
        if (fireAt <= now && !sharpArmed.has(job.id)) {
          sharpArmed.add(job.id);
          try {
            await markScheduledMint(job.id, { status: "running" });
            console.log(`[schedule] running ${job.id} -> ${job.to}`);
            const result = await executeJob(job);
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
    "[schedule] sharp mode ON — T-15s exact timer + burst (Keep the bot running)"
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
