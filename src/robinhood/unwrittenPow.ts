import { Worker } from "node:worker_threads";
import path from "node:path";
import os from "node:os";
import { keccak256, concat, zeroPadValue, getBytes, toBeHex } from "ethers";

export type PowFound = {
  nonce: string;
  hash: string;
  tried: number;
};

const WORKER_PATH = path.join(__dirname, "unwrittenPowWorker.cjs");

/** Sync mine (tests / single-thread fallback). */
export function mineUnwrittenNonceSync(params: {
  seed: string;
  sender: string;
  target: bigint;
  start?: bigint;
  stride?: bigint;
  maxTries?: number;
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
 */
export async function mineUnwrittenNonce(params: {
  seed: string;
  sender: string;
  target: bigint;
  workers?: number;
  onProgress?: (tried: number) => void;
}): Promise<PowFound> {
  const n = Math.max(
    1,
    Math.min(params.workers ?? Math.max(2, (os.cpus()?.length || 2) - 1), 8)
  );

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    let settled = false;
    let triedTotal = 0;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const w of workers) void w.terminate();
      fn();
    };

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
