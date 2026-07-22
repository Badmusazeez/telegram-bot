import { config } from "../config";
import type { Candle, FuturesPair, Ticker24h } from "../types";
import { fetchJson } from "./http";

function base(): string {
  return config.binanceBaseUrl;
}

export async function fetchExchangePairs(): Promise<FuturesPair[]> {
  const data = await fetchJson<{
    symbols: Array<{
      symbol: string;
      contractType: string;
      status: string;
      baseAsset: string;
      quoteAsset: string;
    }>;
  }>(base(), "/fapi/v1/exchangeInfo", {}, { label: "Binance" });

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
  >(base(), "/fapi/v1/ticker/24hr", {}, { label: "Binance" });

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
  >(base(), "/fapi/v1/klines", { symbol, interval, limit }, { label: "Binance" });

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
  }>(base(), "/fapi/v1/premiumIndex", { symbol }, { label: "Binance" });
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
  >(
    base(),
    "/futures/data/openInterestHist",
    { symbol, period, limit },
    { label: "Binance" }
  );

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
    >(
      base(),
      "/futures/data/globalLongShortAccountRatio",
      { symbol, period, limit },
      { label: "Binance" }
    );
    if (!data.length) return null;
    return Number(data[data.length - 1].longShortRatio);
  } catch {
    return null;
  }
}
