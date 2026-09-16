/**
 * Rate-aware RPC gate: concurrency cap, cooldown from try_again_in / -32005,
 * and simple latency tracking. Does NOT raise provider limits — it slows
 * ourselves so all wallets can finish instead of 2/N succeeding.
 */

export type RpcGateStats = {
  inflight: number;
  cooldownUntil: number;
  lastLatencyMs: number | null;
  lastError: string | null;
  totalOk: number;
  totalRateLimited: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse Chainstack/Alchemy try_again_in (ms). */
export function parseTryAgainMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    !/-32005|rps limit|try_again_in|too many requests|rate limit|429|throughput/.test(
      lower
    )
  ) {
    return null;
  }
  const m = msg.match(/try_again_in["\s:]*([0-9.]+)\s*ms/i);
  if (m) {
    const ms = Math.ceil(Number(m[1]));
    if (Number.isFinite(ms) && ms > 0) return Math.min(Math.max(ms, 50), 5_000);
  }
  return 400;
}

export function isRpcRateLimitError(err: unknown): boolean {
  return parseTryAgainMs(err) != null;
}

export function isMissingRevertData(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /missing revert data/.test(msg) ||
    /cannot estimate gas/.test(msg) ||
    /eth_estimategas.*error/.test(msg)
  );
}

export class RpcGate {
  readonly label: string;
  private maxConcurrent: number;
  private inflight = 0;
  private queue: Array<() => void> = [];
  private cooldownUntil = 0;
  private lastLatencyMs: number | null = null;
  private lastError: string | null = null;
  private totalOk = 0;
  private totalRateLimited = 0;

  constructor(label: string, maxConcurrent = 5) {
    this.label = label;
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  stats(): RpcGateStats {
    return {
      inflight: this.inflight,
      cooldownUntil: this.cooldownUntil,
      lastLatencyMs: this.lastLatencyMs,
      lastError: this.lastError,
      totalOk: this.totalOk,
      totalRateLimited: this.totalRateLimited,
    };
  }

  noteRateLimit(err: unknown): void {
    const wait = parseTryAgainMs(err) ?? 400;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + wait);
    this.totalRateLimited += 1;
    this.lastError = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
  }

  private async acquire(): Promise<void> {
    for (;;) {
      const cool = this.cooldownUntil - Date.now();
      if (cool > 0) await sleep(cool);
      if (this.inflight < this.maxConcurrent) {
        this.inflight += 1;
        return;
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
  }

  private release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    const t0 = Date.now();
    try {
      const result = await fn();
      this.lastLatencyMs = Date.now() - t0;
      this.totalOk += 1;
      return result;
    } catch (err) {
      this.lastLatencyMs = Date.now() - t0;
      if (isRpcRateLimitError(err)) {
        this.noteRateLimit(err);
      } else {
        this.lastError =
          err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
      }
      throw err;
    } finally {
      this.release();
    }
  }
}

const gates = new Map<string, RpcGate>();

export function getMintRpcGate(): RpcGate {
  let g = gates.get("mint");
  if (!g) {
    // Chainstack free/dev ≈ 25 RPS; keep headroom for estimateGas+send per wallet.
    g = new RpcGate("mint", 5);
    gates.set("mint", g);
  }
  return g;
}

export function getOpenSeaGate(): RpcGate {
  let g = gates.get("opensea");
  if (!g) {
    g = new RpcGate("opensea", 2);
    gates.set("opensea", g);
  }
  return g;
}

/** Run async work over items with a concurrency cap (order not guaranteed). */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/** Test helpers */
export function resetRpcGatesForTests(): void {
  gates.clear();
}
