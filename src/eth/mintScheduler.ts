import { config } from "../config";
import {
  getState,
  markScheduledMint,
} from "../store/state";
import type { ScheduledMint, ScheduledMintResult } from "../types";
import {
  gasIsAffordable,
  getAllMintWallets,
  getProvider,
} from "./provider";
import type { Wallet } from "ethers";

export type ScheduleHandler = (
  job: ScheduledMint,
  result: ScheduledMintResult
) => Promise<void>;

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
      unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
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
    // mint()
    return "0x1249c58b";
  }
  if (lower === "mint1") {
    // mint(uint256) with qty=1
    return (
      "0xa0712d68" +
      "0000000000000000000000000000000000000000000000000000000000000001"
    );
  }

  // buyer kept for future address-bound presets
  void buyer;

  if (/^0x[0-9a-fA-F]+$/.test(text) && text.length >= 10 && text.length % 2 === 0) {
    return text.toLowerCase();
  }
  return null;
}

async function sendOnWallet(
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

    if (gasEstimate > BigInt(config.maxMintGasLimit)) {
      return {
        address,
        ok: false,
        error: `gas ${gasEstimate} > MAX_MINT_GAS_LIMIT`,
      };
    }

    const sent = await wallet.sendTransaction({
      to: job.to,
      data: job.data,
      value,
      gasLimit: (gasEstimate * 120n) / 100n,
    });
    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      return {
        address,
        ok: false,
        txHash: sent.hash,
        error: `reverted ${sent.hash}`,
      };
    }

    return { address, ok: true, txHash: sent.hash };
  } catch (err) {
    return {
      address,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function executeJob(job: ScheduledMint): Promise<ScheduledMintResult> {
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

  const results = await Promise.all(wallets.map((w) => sendOnWallet(w, job)));
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
        ? `Scheduled mint on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `Scheduled mint failed on all ${wallets.length} wallet(s): ${summary}`,
    txHash: ok[0]?.txHash,
  };
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
      const due = getState().scheduledMints.filter(
        (j) => j.status === "pending" && new Date(j.executeAt).getTime() <= now
      );

      for (const job of due) {
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
      }
    } catch (err) {
      console.error("[schedule] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, 2_000);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
