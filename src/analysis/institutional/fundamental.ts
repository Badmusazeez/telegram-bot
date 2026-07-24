import type { Side } from "../../types";
import type { FactorResult } from "./types";

/**
 * Lightweight public macro/crypto context.
 * Full news/economic calendar/whale feeds need paid APIs — those are marked unavailable
 * so they don't invent false confidence, but also don't hard-block unless configured.
 */
export async function analyzeFundamental(
  symbol: string,
  preferredSide: Side | "NEUTRAL"
): Promise<FactorResult> {
  const weight = 0.05;
  const reasons: string[] = [];
  let score = 0.4; // neutral baseline when only partial data

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/global",
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        data?: {
          market_cap_percentage?: { btc?: number };
          market_cap_change_percentage_24h_usd?: number;
        };
      };
      const btcDom = json.data?.market_cap_percentage?.btc;
      const mcapChg = json.data?.market_cap_change_percentage_24h_usd;
      if (btcDom !== undefined) {
        reasons.push(`BTC dominance ${btcDom.toFixed(2)}%`);
        // High BTC.D often headwind for alts on LONGs
        const isBtc =
          symbol.toUpperCase().includes("BTC") &&
          !symbol.toUpperCase().includes("1000");
        if (!isBtc && preferredSide === "BUY" && btcDom > 55) {
          score -= 0.15;
          reasons.push("High BTC.D — caution on alt LONGs");
        } else {
          score += 0.15;
        }
      }
      if (mcapChg !== undefined) {
        reasons.push(`Crypto mcap 24h ${mcapChg.toFixed(2)}%`);
        if (preferredSide === "BUY" && mcapChg > 0) score += 0.15;
        if (preferredSide === "SELL" && mcapChg < 0) score += 0.15;
      }
    } else {
      reasons.push("CoinGecko global data unavailable");
    }
  } catch {
    reasons.push("Macro crypto snapshot unavailable");
  }

  reasons.push(
    "News / Fed / CPI / NFP / ETF flows / DXY / whales: not connected (optional APIs) — treated as incomplete fundamental coverage"
  );

  return {
    name: "fundamental",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned: score >= 0.45,
    missingKey: false, // soft factor — does not alone force NO TRADE
    reasons,
    directionBias: preferredSide,
  };
}
