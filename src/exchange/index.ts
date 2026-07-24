import { config } from "../config";
import * as binance from "./binance";
import * as mexc from "./mexc";
export { mapPool } from "./http";

function impl() {
  return config.exchange === "mexc" ? mexc : binance;
}

export async function fetchExchangePairs() {
  return impl().fetchExchangePairs();
}

export async function fetchTickers24h() {
  return impl().fetchTickers24h();
}

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 150
) {
  return impl().fetchKlines(symbol, interval, limit);
}

export async function fetchFundingRate(symbol: string) {
  return impl().fetchFundingRate(symbol);
}

export async function fetchOpenInterestHistory(
  symbol: string,
  period: string,
  limit: number
) {
  return impl().fetchOpenInterestHistory(symbol, period, limit);
}

export async function fetchLongShortRatio(
  symbol: string,
  period: string,
  limit = 1
) {
  return impl().fetchLongShortRatio(symbol, period, limit);
}
