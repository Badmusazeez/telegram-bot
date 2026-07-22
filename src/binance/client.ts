import { config } from "../config";
import type { Candle, FuturesPair, Ticker24h } from "../types";

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  retries = 3
): Promise<T> {
  const url = new URL(path, `${config.binanceBaseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": "binance-futures-ai-trading-assistant/1.0",
      };
      if (config.binanceApiKey) {
        headers["X-MBX-APIKEY"] = config.binanceApiKey;
      }

      const res = await fetch(url, { headers });
      if (res.status === 418 || res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || "2");
        await sleep(Math.max(1000, retryAfter * 1000) * (attempt + 1));
        throw new RateLimitError(`Binance rate limited (${res.status})`);
      }
      if (res.status === 451) {
        throw new Error(
          "Binance blocked this IP/region (HTTP 451). Run the bot on a machine/VPN that can reach fapi.binance.com, or set BINANCE_FUTURES_BASE_URL to a reachable Futures endpoint."
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Binance HTTP ${res.status}: ${body.slice(0, 200)}`);
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

export async function fetchExchangePairs(): Promise<FuturesPair[]> {
  const data = await fetchJson<{
    symbols: Array<{
      symbol: string;
      pair: string;
      contractType: string;
      status: string;
      baseAsset: string;
      quoteAsset: string;
    }>;
  }>("/fapi/v1/exchangeInfo");

  return data.symbols
    .filter(
      (s) =>
        s.status === "TRADING" &&
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT"
    )
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      status: s.status,
      contractType: s.contractType,
    }));
}

export async function fetchTickers24h(): Promise<Ticker24h[]> {
  const data = await fetchJson<
    Array<{
      symbol: string;
      lastPrice: string;
      quoteVolume: string;
      priceChangePercent: string;
    }>
  >("/fapi/v1/ticker/24hr");

  return data.map((t) => ({
    symbol: t.symbol,
    lastPrice: Number(t.lastPrice),
    quoteVolume: Number(t.quoteVolume),
    priceChangePercent: Number(t.priceChangePercent),
  }));
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 150
): Promise<Candle[]> {
  const data = await fetchJson<
    Array<[number, string, string, string, string, string, number, string]>
  >("/fapi/v1/klines", { symbol, interval, limit });

  return data.map((row) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
    quoteVolume: Number(row[7]),
  }));
}

export async function fetchFundingRate(symbol: string): Promise<number> {
  const data = await fetchJson<{
    symbol: string;
    lastFundingRate: string;
  }>("/fapi/v1/premiumIndex", { symbol });
  return Number(data.lastFundingRate);
}

export async function fetchOpenInterestHistory(
  symbol: string,
  period: string,
  limit: number
): Promise<Array<{ timestamp: number; sumOpenInterest: number }>> {
  const data = await fetchJson<
    Array<{
      symbol: string;
      sumOpenInterest: string;
      timestamp: number;
    }>
  >("/futures/data/openInterestHist", { symbol, period, limit });

  return data.map((d) => ({
    timestamp: d.timestamp,
    sumOpenInterest: Number(d.sumOpenInterest),
  }));
}

export async function fetchLongShortRatio(
  symbol: string,
  period: string,
  limit = 1
): Promise<number | null> {
  try {
    const data = await fetchJson<
      Array<{
        longShortRatio: string;
        timestamp: number;
      }>
    >("/futures/data/globalLongShortAccountRatio", {
      symbol,
      period,
      limit,
    });
    if (!data.length) return null;
    return Number(data[data.length - 1].longShortRatio);
  } catch {
    return null;
  }
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
    { length: Math.min(concurrency, items.length) },
    () => run()
  );
  await Promise.all(runners);
  return results;
}
