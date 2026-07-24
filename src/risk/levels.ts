import { config } from "../config";
import type { RiskLevels, Side } from "../types";

export function computeRiskLevels(
  side: Side,
  entry: number,
  atrValue: number
): RiskLevels {
  const slDist = atrValue * config.stopLossAtrMult;
  const tp1Dist = atrValue * config.takeProfitAtrMult;
  const tp2Dist = atrValue * config.takeProfit2AtrMult;

  if (side === "BUY") {
    const stopLoss = entry - slDist;
    const takeProfit1 = entry + tp1Dist;
    const takeProfit2 = entry + tp2Dist;
    return {
      entry,
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskReward1: slDist > 0 ? tp1Dist / slDist : 0,
      riskReward2: slDist > 0 ? tp2Dist / slDist : 0,
    };
  }

  const stopLoss = entry + slDist;
  const takeProfit1 = entry - tp1Dist;
  const takeProfit2 = entry - tp2Dist;
  return {
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskReward1: slDist > 0 ? tp1Dist / slDist : 0,
    riskReward2: slDist > 0 ? tp2Dist / slDist : 0,
  };
}
