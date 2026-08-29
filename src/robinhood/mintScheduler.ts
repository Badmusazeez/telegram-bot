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
import {
  withWalletNonce,
  invalidateWalletNonce,
  warmWalletNonce,
} from "./nonceManager";
import {
  checkMintWalletReadiness,
  clearWalletReadinessCache,
} from "./walletReady";
import {
  getMintRpcGate,
  mapPool,
  parseTryAgainMs,
  isMissingRevertData,
} from "./rpcGate";
import type { Wallet } from "ethers";
import { recordMintSession } from "../store/botStats";

export type ScheduleHandler = (
  job: ScheduledMint,
  result: ScheduledMintResult
) => Promise<void>;

/** Lead time for real pre-arm (OpenSea builder + gas). Was 15s wait-only. */
const DEFAULT_LEAD_MS = 30_000;
/** Jobs currently in sharp fine-wait (avoid double-fire from poll). */
const sharpArmed = new Set<string>();

type ArmedScheduledTx = {
  wallet: Wallet;
  to: string;
  data: string;
  valueWei: bigint;
  gasLimit: bigint;
  quantity?: number;
};

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
      left > 200 ? Math.min(left - 100, 1_000) : Math.min(left, 10);
    await sleep(Math.max(3, wait));
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
    // Prefer qty 1 first for FCFS WL (fastest path), then ladder up if allowed.
    const ladder = [
      ...new Set(
        [1, ...maxMintQuantityLadder(target)].filter((q) => q <= target)
      ),
    ].sort((a, b) => a - b);
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

/**
 * Pre-arm during lead window: OpenSea mint builder + estimateGas + nonce warm.
 * Fire path must only send.
 */
async function prepareArmedTxs(
  job: ScheduledMint,
  wallets: Wallet[]
): Promise<ArmedScheduledTx[]> {
  const provider = getMintProvider();
  const gate = getMintRpcGate();

  // Warm drop cache once (shared).
  if (job.openSeaSlug) {
    try {
      await fetchOpenSeaDrop(job.openSeaSlug);
    } catch (err) {
      console.warn(
        `[schedule:arm] drop prefetch failed: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  const built = await mapPool(wallets, 4, async (wallet) => {
    try {
      const tx = await resolveJobTxForWallet(job, wallet);
      return { wallet, tx, error: null as string | null };
    } catch (err) {
      return {
        wallet,
        tx: null as null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const armed: ArmedScheduledTx[] = [];
  await mapPool(
    built.filter((b) => b.tx),
    6,
    async (item) => {
      const wallet = item.wallet;
      const tx = item.tx!;
      try {
        await warmWalletNonce(wallet.address, provider).catch(() => undefined);
        let gasLimit: bigint;
        try {
          const estimated = await gate.run(() =>
            provider.estimateGas({
              from: wallet.address,
              to: tx.to,
              data: tx.data,
              value: tx.valueWei,
            })
          );
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
            `[schedule:arm] ${wallet.address.slice(0, 8)}… fn=${mintSelectorLabel(tx.data)} ` +
              `qty=${tx.quantity ?? "?"} estimate=${estimated} gasLimit=${gasLimit}`
          );
        } catch (err) {
          // Pre-window revert is common for timed stages — arm with safe ceiling.
          const msg = err instanceof Error ? err.message : String(err);
          if (
            /revert|execution|not (yet |)?(live|open|started)|too early|before/i.test(
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
          to: tx.to,
          data: tx.data,
          valueWei: tx.valueWei,
          gasLimit,
          quantity: tx.quantity,
        });
      } catch (err) {
        console.warn(
          `[schedule:arm] prepare failed ${wallet.address.slice(0, 8)}… ${
            err instanceof Error ? err.message.slice(0, 120) : err
          }`
        );
      }
    }
  );

  for (const b of built) {
    if (!b.tx && b.error) {
      console.warn(
        `[schedule:arm] build failed ${b.wallet.address.slice(0, 8)}… ${b.error.slice(0, 120)}`
      );
    }
  }

  return armed;
}

/** Send-only burst — no OpenSea, no estimateGas. */
async function burstArmedSends(
  armed: ArmedScheduledTx[]
): Promise<
  Array<{
    address: string;
    ok: boolean;
    txHash?: string;
    error?: string;
    detail?: string;
  }>
> {
  const provider = getMintProvider();
  const gate = getMintRpcGate();

  return Promise.all(
    armed.map(async (a, index) => {
      const address = a.wallet.address.toLowerCase();
      if (index > 0) await sleep(Math.min(index * 3, 40));
      try {
        const connected = a.wallet.connect(provider);
        const sent = await gate.run(() =>
          withWalletNonce({
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
          })
        );
        void sent.wait().catch(() => undefined);
        return {
          address,
          ok: true as const,
          txHash: sent.hash,
          detail: a.quantity ? `x${a.quantity}` : undefined,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nonce/i.test(msg)) invalidateWalletNonce(address);
        const waitMs = parseTryAgainMs(err);
        if (waitMs != null && waitMs < 400) {
          await sleep(waitMs);
          try {
            const connected = a.wallet.connect(provider);
            const sent = await gate.run(() =>
              withWalletNonce({
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
              })
            );
            void sent.wait().catch(() => undefined);
            return {
              address,
              ok: true as const,
              txHash: sent.hash,
              detail: a.quantity ? `x${a.quantity}` : undefined,
            };
          } catch (err2) {
            return {
              address,
              ok: false as const,
              error: err2 instanceof Error ? err2.message : String(err2),
            };
          }
        }
        if (isMissingRevertData(err)) {
          return {
            address,
            ok: false,
            error: "missing revert data (ambiguous)",
          };
        }
        return { address, ok: false, error: msg };
      }
    })
  );
}

/** Cold path (non-sharp / fallback if arm produced nothing). */
async function executeJobCold(job: ScheduledMint): Promise<ScheduledMintResult> {
  const state = getState();
  const allWallets = getAllMintWallets();
  clearWalletReadinessCache();
  const readiness = await checkMintWalletReadiness(allWallets);
  const wallets =
    readiness.ready.length > 0 ? readiness.ready : allWallets;

  if (state.dryRun) {
    return {
      success: true,
      dryRun: true,
      reason: `DRY RUN — would mint on ${wallets.length}/${allWallets.length} wallet(s) at ${job.executeAt} to ${job.to}${
        job.openSeaSlug ? ` (OpenSea drop ${job.openSeaSlug})` : ""
      } (empty=${readiness.empty.length})`,
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

  const armed = await prepareArmedTxs(job, wallets);
  if (armed.length === 0) {
    return {
      success: false,
      dryRun: false,
      reason: "Could not prepare any wallet txs (OpenSea/gas).",
    };
  }

  const results = await burstArmedSends(armed);
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
        ? `Burst mint on ${ok.length}/${armed.length} armed (${allWallets.length} configured): ${summary}`
        : `Burst failed on all ${armed.length} armed wallets: ${summary}`,
    txHash: firstOk?.txHash,
  };
}

async function executeJob(job: ScheduledMint): Promise<ScheduledMintResult> {
  return executeJobCold(job);
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
      `[schedule] ⚡ sharp PRE-ARM #${job.scheduleNumber ?? "?"} ` +
        `T-${Math.round(leadMs / 1000)}s → ${job.executeAt} · wallets=${wallets.length}`
    );

    if (state.dryRun) {
      await waitUntilExact(fireAt);
      const result: ScheduledMintResult = {
        success: true,
        dryRun: true,
        reason: `DRY RUN — pre-armed ${wallets.length}/${allWallets.length} wallet(s) for sharp burst at ${job.executeAt}${
          job.openSeaSlug ? ` (OpenSea ${job.openSeaSlug})` : ""
        }`,
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
      return;
    }

    // REAL PREP before window open (OpenSea + gas + nonce).
    const prepStarted = Date.now();
    let armed = await prepareArmedTxs(job, wallets);
    const prepMs = Date.now() - prepStarted;
    console.log(
      `[schedule] ✅ pre-armed ${armed.length}/${wallets.length} wallet(s) in ${prepMs}ms — waiting for exact open`
    );

    // Retry thin arms until ~1.5s before open (OpenSea 429 recovery).
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
      void recordMintSession({
        dryRun: result.dryRun,
        success: result.success,
        attempted: true,
        reason: result.reason,
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
              ? ` OK ${r.txHash?.slice(0, 10)}…${r.detail ? ` ${r.detail}` : ""}`
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
    void recordMintSession({
      dryRun: result.dryRun,
      success: result.success,
      attempted: true,
      reason: result.reason,
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
          if (fireAt - now <= leadMs + 3_000 && !sharpArmed.has(job.id)) {
            void runSharpJob(job, onDone);
          }
          continue;
        }

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
            void recordMintSession({
              dryRun: result.dryRun,
              success: result.success,
              attempted: true,
              reason: result.reason,
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
    "[schedule] sharp mode ON — T-30s REAL pre-arm (OpenSea+gas) → exact timer → SEND-ONLY burst"
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
