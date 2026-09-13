import { Worker } from "node:worker_threads";
import path from "node:path";
import os from "node:os";
import { keccak256, concat, zeroPadValue, getBytes, toBeHex } from "ethers";

export type PowFound = {
  nonce: string;
  hash: string;
  tried: number;
};

export class PowAbortedError extends Error {
  constructor(message = "PoW aborted (depth/seed changed)") {
    super(message);
    this.name = "PowAbortedError";
  }
}

const WORKER_PATH = path.join(__dirname, "unwrittenPowWorker.cjs");

/** Sync mine (tests / single-thread fallback). */
export function mineUnwrittenNonceSync(params: {
  seed: string;
  sender: string;
  target: bigint;
  start?: bigint;
  stride?: bigint;
  maxTries?: number;
  shouldStop?: () => boolean;
}): PowFound | null {
  const prefix = concat([
    getBytes(params.seed),
    zeroPadValue(params.sender, 32),
  ]);
  let nonce = params.start ?? 0n;
  const stride = params.stride ?? 1n;
  const maxTries = params.maxTries ?? 5_000_000;
  let tried = 0;
  while (tried < maxTries) {
    if (params.shouldStop?.()) return null;
    const hash = keccak256(
      concat([prefix, zeroPadValue(toBeHex(nonce), 32)])
    );
    tried++;
    if (BigInt(hash) < params.target) {
      return { nonce: nonce.toString(), hash, tried };
    }
    nonce += stride;
  }
  return null;
}

/**
 * Mine a valid nonce with N CPU workers (matches theunwritten.xyz worker).
 * Pass `signal` / `shouldStop` to abort early when on-chain depth moves.
 */
export async function mineUnwrittenNonce(params: {
  seed: string;
  sender: string;
  target: bigint;
  workers?: number;
  onProgress?: (tried: number) => void;
  signal?: AbortSignal;
  shouldStop?: () => boolean | Promise<boolean>;
  /** How often to poll shouldStop (ms). Default 1500. */
  stopPollMs?: number;
}): Promise<PowFound> {
  if (params.signal?.aborted || (await params.shouldStop?.())) {
    throw new PowAbortedError();
  }

  const n = Math.max(
    1,
    Math.min(params.workers ?? Math.max(2, (os.cpus()?.length || 2) - 1), 8)
  );

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    let settled = false;
    let triedTotal = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      params.signal?.removeEventListener("abort", onAbort);
      for (const w of workers) void w.terminate();
      fn();
    };

    const onAbort = () => {
      done(() => reject(new PowAbortedError()));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    if (params.shouldStop) {
      const ms = params.stopPollMs ?? 1_500;
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            if (await params.shouldStop?.()) {
              done(() => reject(new PowAbortedError()));
            }
          } catch {
            // ignore poll errors
          }
        })();
      }, ms);
      pollTimer.unref?.();
    }

    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_PATH, {
        workerData: {
          seed: params.seed,
          sender: params.sender,
          target: params.target.toString(),
          start: String(i),
          stride: String(n),
          maxTries: 120_000_000,
        },
      });
      workers.push(w);
      w.on("message", (msg: {
        type: string;
        nonce?: string;
        hash?: string;
        tried?: number;
      }) => {
        if (msg.type === "progress") {
          triedTotal += msg.tried || 0;
          params.onProgress?.(triedTotal);
          return;
        }
        if (msg.type === "found" && msg.nonce && msg.hash) {
          done(() =>
            resolve({
              nonce: msg.nonce!,
              hash: msg.hash!,
              tried: msg.tried || 0,
            })
          );
          return;
        }
        if (msg.type === "exhausted") {
          triedTotal += msg.tried || 0;
        }
      });
      w.on("error", (err) => done(() => reject(err)));
    }

    setTimeout(() => {
      done(() => reject(new Error("PoW timed out after 20 minutes")));
    }, 20 * 60_000).unref?.();
  });
}
