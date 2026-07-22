import { config } from "../config";
import type { Candle, FuturesPair, Ticker24h } from "../types";
import { fetchJson } from "./http";

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

type MexcOk<T> = { success: boolean; code: number; data: T };

async function mexc<T>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const json = await fetchJson<MexcOk<T>>(base(), path, params, {
    label: "MEXC",
  });
  if (!json.success && json.code !== 0) {
    throw new Error(`MEXC API error code=${json.code}`);
  }
  return json.data;
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
        s.apiAllowed !== false
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

/**
 * MEXC has no public OI history series like Binance.
 * Use current holdVol from ticker as a single-point snapshot so callers
 * can still reason about availability (change % will be null upstream).
 */
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
  // Not exposed on MEXC public contract API.
  return null;
}
