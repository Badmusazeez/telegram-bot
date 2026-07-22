import {
  fetchFundingRate,
  fetchLongShortRatio,
  fetchOpenInterestHistory,
} from "../exchange";
import { config } from "../config";
import type { FundamentalSnapshot, Side } from "../types";

function oiPeriodForTimeframe(tf: string): string {
  // Binance OI hist periods: 5m,15m,30m,1h,2h,4h,6h,12h,1d
  const map: Record<string, string> = {
    "1m": "5m",
    "3m": "5m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "2h": "2h",
    "4h": "4h",
    "6h": "6h",
    "12h": "12h",
    "1d": "1d",
  };
  return map[tf] ?? "15m";
}

export async function analyzeFundamental(
  symbol: string,
  side: Side
): Promise<FundamentalSnapshot> {
  const reasons: string[] = [];
  let score = 0;

  let fundingRate = 0;
  try {
    fundingRate = await fetchFundingRate(symbol);
  } catch {
    reasons.push("Funding rate unavailable");
  }

  if (config.requireFunding && Number.isFinite(fundingRate)) {
    // Crowded longs (high positive funding) is a caution for BUYs;
    // prefer shorts when funding is richly positive.
    if (side === "BUY" && fundingRate <= config.fundingLongMax) {
      score += 1;
      reasons.push(
        `Funding ${(fundingRate * 100).toFixed(4)}% not overcrowded long`
      );
    } else if (side === "SELL" && fundingRate >= config.fundingShortMin) {
      score += 1;
      reasons.push(
        `Funding ${(fundingRate * 100).toFixed(4)}% supports short bias`
      );
    } else {
      reasons.push(
        `Funding ${(fundingRate * 100).toFixed(4)}% crowded vs ${side}`
      );
    }
  }

  let openInterestChangePct: number | null = null;
  if (config.requireOpenInterest) {
    try {
      const period = oiPeriodForTimeframe(config.timeframe);
      const hist = await fetchOpenInterestHistory(
        symbol,
        period,
        config.oiLookbackPeriods
      );
      if (hist.length >= 2) {
        const first = hist[0].sumOpenInterest;
        const last = hist[hist.length - 1].sumOpenInterest;
        if (first > 0) {
          openInterestChangePct = ((last - first) / first) * 100;
          if (openInterestChangePct > 0.5) {
            score += 1;
            reasons.push(
              `Open interest rising ${openInterestChangePct.toFixed(2)}% (conviction)`
            );
          } else if (openInterestChangePct < -0.5) {
            reasons.push(
              `Open interest falling ${openInterestChangePct.toFixed(2)}% (caution)`
            );
          } else {
            reasons.push(
              `Open interest flat (${openInterestChangePct.toFixed(2)}%)`
            );
          }
        }
      } else if (hist.length === 1 && config.exchange === "mexc") {
        reasons.push(
          `Open interest snapshot ${hist[0].sumOpenInterest.toLocaleString()} (MEXC has no OI history)`
        );
      } else {
        reasons.push("Open interest history unavailable");
      }
    } catch {
      reasons.push("Open interest history unavailable");
    }
  }

  let longShortRatio: number | null = null;
  try {
    longShortRatio = await fetchLongShortRatio(
      symbol,
      oiPeriodForTimeframe(config.timeframe),
      1
    );
    if (longShortRatio !== null) {
      if (side === "BUY" && longShortRatio < 1.2) {
        score += 1;
        reasons.push(`L/S ratio ${longShortRatio.toFixed(2)} not extreme long`);
      } else if (side === "SELL" && longShortRatio > 0.85) {
        score += 1;
        reasons.push(`L/S ratio ${longShortRatio.toFixed(2)} supports short`);
      } else {
        reasons.push(`L/S ratio ${longShortRatio.toFixed(2)} neutral/against`);
      }
    }
  } catch {
    // optional
  }

  return {
    fundingRate,
    openInterestChangePct,
    longShortRatio,
    score,
    reasons,
  };
}
