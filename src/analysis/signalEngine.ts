import { createHash } from "node:crypto";
import { config } from "../config";
import { analyzeFundamental } from "./fundamental";
import { analyzeTechnical } from "./technical";
import { computeRiskLevels } from "../risk/levels";
import type { Candle, TradeSignal } from "../types";

function signalId(symbol: string, side: string, candleCloseTime: number): string {
  return createHash("sha1")
    .update(`${symbol}|${side}|${candleCloseTime}|${config.timeframe}`)
    .digest("hex")
    .slice(0, 16);
}

function confidence(techScore: number, fundScore: number): number {
  const techMax =
    1 +
    (config.requireRsi ? 1 : 0) +
    (config.requireMacd ? 1 : 0) +
    (config.requireVolume ? 1 : 0);
  const fundMax =
    (config.requireFunding ? 1 : 0) +
    (config.requireOpenInterest ? 1 : 0) +
    1; // L/S optional point
  const techPct = techScore / Math.max(1, techMax);
  const fundPct = fundScore / Math.max(1, fundMax);
  return Math.round((techPct * 0.65 + fundPct * 0.35) * 100);
}

export async function evaluateSymbol(
  symbol: string,
  candles: Candle[]
): Promise<TradeSignal | null> {
  const technical = analyzeTechnical(candles);
  if (!technical || !technical.emaCross) return null;
  if (technical.score < config.minTechnicalScore) return null;

  const side = technical.emaCross;
  const fundamental = await analyzeFundamental(symbol, side);
  if (fundamental.score < config.minFundamentalScore) return null;

  const closed = candles[candles.length - 2];
  const entry = closed.close;
  const levels = computeRiskLevels(side, entry, technical.atr);
  const conf = confidence(technical.score, fundamental.score);

  const summary = [
    `${side} ${symbol} on ${config.timeframe}`,
    `EMA crossover + tech ${technical.score}, fund ${fundamental.score}`,
    `confidence ${conf}%`,
  ].join(" · ");

  return {
    id: signalId(symbol, side, closed.closeTime),
    symbol,
    side,
    timeframe: config.timeframe,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    riskReward1: levels.riskReward1,
    riskReward2: levels.riskReward2,
    technical,
    fundamental,
    confidence: conf,
    summary,
    createdAt: Date.now(),
  };
}
