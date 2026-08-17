/** Lightweight pipeline latency marks for mint copy path. */

export type LatencyMarks = Record<string, number>;

export class PipelineTimer {
  readonly t0: number;
  private marks: LatencyMarks = {};

  constructor(detectedAtMs?: number) {
    const now = Date.now();
    this.t0 = detectedAtMs && detectedAtMs > 0 && detectedAtMs <= now
      ? detectedAtMs
      : now;
    this.marks.detect = this.t0;
  }

  mark(name: string): void {
    this.marks[name] = Date.now();
  }

  msSinceStart(name?: string): number {
    const t = name && this.marks[name] != null ? this.marks[name]! : Date.now();
    return t - this.t0;
  }

  delta(from: string, to: string): number | null {
    const a = this.marks[from];
    const b = this.marks[to];
    if (a == null || b == null) return null;
    return b - a;
  }

  /** Compact log line — never includes secrets. */
  summary(ok: boolean): string {
    const order = [
      "detect",
      "decode",
      "strategy",
      "simulate",
      "broadcast",
      "done",
    ];
    const parts: string[] = [];
    let prev = "detect";
    for (const name of order) {
      if (name === "detect") continue;
      if (this.marks[name] == null) continue;
      const d = this.delta(prev, name);
      if (d != null) parts.push(`${prev}→${name}=${d}ms`);
      prev = name;
    }
    const total = this.msSinceStart(this.marks.done != null ? "done" : undefined);
    return `[latency] total=${total}ms ${parts.join(" ")} result=${ok ? "ok" : "fail"}`;
  }
}

export function attachTimer(
  purchase: { _timer?: PipelineTimer },
  timer?: PipelineTimer
): PipelineTimer {
  if (purchase._timer) return purchase._timer;
  const t = timer ?? new PipelineTimer();
  purchase._timer = t;
  return t;
}
