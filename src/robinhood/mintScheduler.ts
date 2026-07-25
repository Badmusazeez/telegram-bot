import { config } from "../config";
import {
  getState,
  markScheduledMint,
} from "../store/state";
import type { ScheduledMint, ScheduledMintResult } from "../types";
import { gasIsAffordable, getProvider, getWallet } from "./provider";

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

async function executeJob(job: ScheduledMint): Promise<ScheduledMintResult> {
  const state = getState();

  if (state.dryRun) {
    return {
      success: true,
      dryRun: true,
      reason: `DRY RUN — would mint at ${job.executeAt} to ${job.to}`,
    };
  }

  const wallet = getWallet();
  if (!wallet) {
    return {
      success: false,
      dryRun: false,
      reason: "PRIVATE_KEY missing — cannot run scheduled mint.",
    };
  }

  if (!(await gasIsAffordable())) {
    return {
      success: false,
      dryRun: false,
      reason: `Gas above MAX_GAS_GWEI (${config.maxGasGwei}).`,
    };
  }

  const provider = getProvider();
  try {
    const gasEstimate = await provider.estimateGas({
      from: wallet.address,
      to: job.to,
      data: job.data,
      value: 0n,
    });

    if (gasEstimate > BigInt(config.maxMintGasLimit)) {
      return {
        success: false,
        dryRun: false,
        reason: `Gas estimate ${gasEstimate} exceeds MAX_MINT_GAS_LIMIT.`,
      };
    }

    const sent = await wallet.sendTransaction({
      to: job.to,
      data: job.data,
      value: 0n,
      gasLimit: (gasEstimate * 120n) / 100n,
    });
    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      return {
        success: false,
        dryRun: false,
        reason: `Scheduled mint reverted: ${sent.hash}`,
        txHash: sent.hash,
      };
    }

    return {
      success: true,
      dryRun: false,
      reason: "Scheduled mint succeeded.",
      txHash: sent.hash,
    };
  } catch (err) {
    return {
      success: false,
      dryRun: false,
      reason: `Scheduled mint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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
