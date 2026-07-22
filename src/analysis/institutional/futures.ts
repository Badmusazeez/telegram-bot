import { config } from "../../config";
import {
  fetchFundingRate,
  fetchLongShortRatio,
  fetchOpenInterestHistory,
} from "../../exchange";
import type { Side } from "../../types";
import type { FactorResult } from "./types";

export async function analyzeFuturesMetrics(
  symbol: string,
  preferredSide: Side | "NEUTRAL"
): Promise<FactorResult> {
  const weight = 0.05;
  const reasons: string[] = [];
  let score = 0;
  let missingKey = false;

  let funding = 0;
  try {
    funding = await fetchFundingRate(symbol);
    reasons.push(`Funding ${(funding * 100).toFixed(4)}%`);
    if (preferredSide === "BUY" && funding <= config.fundingLongMax) score += 0.35;
    else if (preferredSide === "SELL" && funding >= config.fundingShortMin)
      score += 0.35;
    else reasons.push("Funding crowded vs trade direction");
  } catch {
    reasons.push("Funding unavailable");
    missingKey = true;
  }

  try {
    const oi = await fetchOpenInterestHistory(symbol, "15m", config.oiLookbackPeriods);
    if (oi.length >= 2) {
      const first = oi[0].sumOpenInterest;
      const last = oi[oi.length - 1].sumOpenInterest;
      const chg = first > 0 ? ((last - first) / first) * 100 : 0;
      reasons.push(`OI Δ ${chg.toFixed(2)}%`);
      if (chg > 0.5) score += 0.35;
      else if (chg < -0.5) reasons.push("OI falling — weaker conviction");
      else score += 0.1;
    } else if (oi.length === 1) {
      reasons.push(
        `OI snapshot ${oi[0].sumOpenInterest.toLocaleString()} (no history on this exchange)`
      );
      score += 0.1;
    } else {
      reasons.push("OI unavailable");
    }
  } catch {
    reasons.push("OI unavailable");
  }

  try {
    const ls = await fetchLongShortRatio(symbol, "15m", 1);
    if (ls !== null) {
      reasons.push(`Long/Short ${ls.toFixed(2)}`);
      if (preferredSide === "BUY" && ls < 1.3) score += 0.2;
      else if (preferredSide === "SELL" && ls > 0.8) score += 0.2;
    } else {
      reasons.push("Long/Short ratio unavailable on this exchange");
    }
  } catch {
    reasons.push("Long/Short ratio unavailable");
  }

  reasons.push(
    "Liquidation heatmap / CVD: not available via public API — not scored"
  );

  // Futures is supporting evidence; don't hard-fail the whole trade if OI/L-S missing
  const aligned = score >= 0.3 && preferredSide !== "NEUTRAL";

  return {
    name: "futures",
    weight,
    score: Math.max(0, Math.min(1, score)),
    aligned,
    missingKey: missingKey && score < 0.2,
    reasons,
    directionBias: preferredSide,
  };
}
