import { config } from "../config";
import type { Candle, FuturesPair, Ticker24h } from "../types";
import { fetchJson, RateLimitError, sleep } from "./http";

function base(): string {
  return config.mexcBaseUrl;
}

const INTERVAL_MAP: Record<string, string> = {
  "1m": "Min1",
  "5m": "Min5",
  "15m": "Min15",
  "30m": "Min30",
  "1h": "Min60",
  "4h": "Hour4",
  "1d": "Day1",
};

const INTERVAL_SECONDS: Record<string, number> = {
  Min1: 60,
  Min5: 300,
  Min15: 900,
  Min30: 1800,
  Min60: 3600,
  Hour4: 14400,
  Day1: 86400,
};

/** Normalize BTCUSDT / btc-usdt → BTC_USDT for MEXC contracts. */
export function toMexcSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace("-", "_");
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}_USDT`;
  if (s.endsWith("USD")) return `${s.slice(0, -3)}_USD`;
  return s;
}

function toMexcInterval(tf: string): string {
  const mapped = INTERVAL_MAP[tf];
  if (!mapped) {
    throw new Error(
      `TIMEFRAME=${tf} is not supported on MEXC. Use one of: ${Object.keys(INTERVAL_MAP).join(", ")}`
    );
  }
  return mapped;
}

type MexcOk<T> = { success: boolean; code: number; data: T; message?: string };

/** Global spacing so we stay under MEXC public rate limits (code 510). */
let lastRequestAt = 0;
const MIN_GAP_MS = 120; // ~8 req/s max across the process

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastRequestAt + MIN_GAP_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function mexc<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  retries = 5
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await throttle();
      const json = await fetchJson<MexcOk<T>>(base(), path, params, {
        label: "MEXC",
        retries: 1,
      });

      // 510 = too frequent; 501 = system busy
      if (json.code === 510 || json.code === 501) {
        throw new RateLimitError(
          `MEXC rate limited (code=${json.code}) ${json.message ?? ""}`.trim()
        );
      }
      if (!json.success && json.code !== 0) {
        throw new Error(`MEXC API error code=${json.code}`);
      }
      return json.data;
    } catch (err) {
      lastError = err;
      const isRate =
        err instanceof RateLimitError ||
        (err instanceof Error && /code=510|rate limited|too frequent/i.test(err.message));
      if (attempt < retries && isRate) {
        await sleep(1000 * (attempt + 1) + Math.floor(Math.random() * 400));
        continue;
      }
      if (attempt < retries && !(err instanceof Error && /blocked this IP/i.test(err.message))) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchExchangePairs(): Promise<FuturesPair[]> {
  const data = await mexc<
    Array<{
      symbol: string;
      baseCoin: string;
      quoteCoin: string;
      state: number;
      futureType: number;
      apiAllowed?: boolean;
    }>
  >("/api/v1/contract/detail");

  return data
    .filter(
      (s) =>
        s.state === 0 &&
        s.futureType === 1 &&
        String(s.quoteCoin).toUpperCase() === "USDT" &&
        s.apiAllowed !== false &&
        // Skip stock-index style contracts that often rate-limit / misbehave
        !/_STOCK$/i.test(s.symbol) &&
        !s.symbol.includes("STOCK")
    )
    .map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseCoin,
      quoteAsset: s.quoteCoin,
      status: "TRADING",
      contractType: "PERPETUAL",
    }));
}

export async function fetchTickers24h(): Promise<Ticker24h[]> {
  const data = await mexc<
    Array<{
      symbol: string;
      lastPrice: number;
      amount24: number;
      riseFallRate: number;
      fundingRate?: number;
      holdVol?: number;
    }>
  >("/api/v1/contract/ticker");

  return data.map((t) => ({
    symbol: t.symbol,
    lastPrice: Number(t.lastPrice),
    quoteVolume: Number(t.amount24),
    priceChangePercent: Number(t.riseFallRate) * 100,
  }));
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 150
): Promise<Candle[]> {
  const mexcSymbol = toMexcSymbol(symbol);
  const mexcInterval = toMexcInterval(interval);
  const seconds = INTERVAL_SECONDS[mexcInterval] ?? 900;
  const end = Math.floor(Date.now() / 1000);
  const start = end - seconds * Math.max(limit, 50);

  const data = await mexc<{
    time: number[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    vol: number[];
    amount?: number[];
  }>(`/api/v1/contract/kline/${encodeURIComponent(mexcSymbol)}`, {
    interval: mexcInterval,
    start,
    end,
  });

  const times = data.time ?? [];
  const candles: Candle[] = [];
  for (let i = 0; i < times.length; i++) {
    const openTimeSec = times[i];
    const openTime = openTimeSec * 1000;
    candles.push({
      openTime,
      open: Number(data.open[i]),
      high: Number(data.high[i]),
      low: Number(data.low[i]),
      close: Number(data.close[i]),
      volume: Number(data.vol[i]),
      closeTime: openTime + seconds * 1000 - 1,
      quoteVolume: Number(data.amount?.[i] ?? 0),
    });
  }
  return candles.slice(-limit);
}

export async function fetchFundingRate(symbol: string): Promise<number> {
  const mexcSymbol = toMexcSymbol(symbol);
  const data = await mexc<{ fundingRate: number }>(
    `/api/v1/contract/funding_rate/${encodeURIComponent(mexcSymbol)}`
  );
  return Number(data.fundingRate);
}

export async function fetchOpenInterestHistory(
  symbol: string,
  _period: string,
  _limit: number
): Promise<Array<{ timestamp: number; sumOpenInterest: number }>> {
  const mexcSymbol = toMexcSymbol(symbol);
  const data = await mexc<{
    holdVol?: number;
    timestamp?: number;
  }>(`/api/v1/contract/ticker`, { symbol: mexcSymbol });

  const hold = Number(data.holdVol ?? 0);
  if (!Number.isFinite(hold) || hold <= 0) return [];
  return [
    {
      timestamp: Number(data.timestamp ?? Date.now()),
      sumOpenInterest: hold,
    },
  ];
}

export async function fetchLongShortRatio(
  _symbol: string,
  _period: string,
  _limit = 1
): Promise<number | null> {
  return null;
}
