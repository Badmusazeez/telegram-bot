export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export async function fetchJson<T>(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: {
    headers?: Record<string, string>;
    retries?: number;
    label?: string;
  } = {}
): Promise<T> {
  const label = options.label ?? "Exchange";
  const retries = options.retries ?? 3;
  const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "futures-ai-trading-assistant/1.0",
          ...(options.headers ?? {}),
        },
      });
      if (res.status === 418 || res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || "2");
        await sleep(Math.max(1000, retryAfter * 1000) * (attempt + 1));
        throw new RateLimitError(`${label} rate limited (${res.status})`);
      }
      if (res.status === 451) {
        throw new Error(
          `${label} blocked this IP/region (HTTP 451). Try EXCHANGE=mexc or a VPN/VPS in an allowed country.`
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Simple concurrency pool for scanning many symbols. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => run()
  );
  await Promise.all(runners);
  return results;
}
