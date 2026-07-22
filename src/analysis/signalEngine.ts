import { createHash } from "node:crypto";
import { config } from "../config";
import { analyzeFundamental } from "./fundamental";
import { analyzeTechnical } from "./technical";
import {
  atrPctOk,
  checkTrendAlignment,
  qualityLabel,
} from "./quality";
import { computeRiskLevels } from "../risk/levels";
import type { Candle, TradeSignal } from "../types";

function signalId(symbol: string, side: string, candleCloseTime: number): string {
  return createHash("sha1")
    .update(
      `${config.exchange}|${symbol}|${side}|${candleCloseTime}|${config.timeframe}`
    )
    .digest("hex")
    .slice(0, 16);
}

function confidence(
  techScore: number,
  fundScore: number,
  extras: { trendOk: boolean; volumeSpike: boolean }
): number {
  const techMax =
    1 +
    (config.requireRsi ? 1 : 0) +
    (config.requireMacd ? 1 : 0) +
    (config.requireVolume ? 1 : 0);
  const fundMax = Math.max(
    1,
    (config.requireFunding ? 1 : 0) + (config.requireOpenInterest ? 1 : 0) + 1
  );
  let score =
    (techScore / Math.max(1, techMax)) * 0.55 +
    (fundScore / fundMax) * 0.25;
  if (extras.trendOk) score += 0.12;
  if (extras.volumeSpike) score += 0.08;
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

export async function evaluateSymbol(
  symbol: string,
  candles: Candle[],
  trendCandles?: Candle[]
): Promise<TradeSignal | null> {
  const technical = analyzeTechnical(candles);
  if (!technical || !technical.emaCross) return null;
  if (technical.score < config.minTechnicalScore) return null;

  if (config.requireVolumeSpike && !technical.volumeSpike) {
    return null;
  }

  const side = technical.emaCross;
  const closed = candles[candles.length - 2];
  const entry = closed.close;

  const atrCheck = atrPctOk(technical.atr, entry);
  if (!atrCheck.ok) return null;

  let trendOk = !config.requireTrendAlignment;
  const tags: string[] = [];

  if (config.requireTrendAlignment) {
    if (!trendCandles || trendCandles.length < config.emaSlow + 5) {
      return null;
    }
    const trend = checkTrendAlignment(trendCandles, side);
    if (!trend.ok) return null;
    trendOk = true;
    tags.push(`trend:${config.trendTimeframe}`);
    technical.reasons.push(trend.reason);
  }

  if (technical.volumeSpike) tags.push("volume");
  if (technical.macdBullish) tags.push("macd");
  tags.push(`atr:${atrCheck.atrPct.toFixed(2)}%`);

  const fundamental = await analyzeFundamental(symbol, side);
  if (fundamental.score < config.minFundamentalScore) return null;

  const levels = computeRiskLevels(side, entry, technical.atr);
  const conf = confidence(technical.score, fundamental.score, {
    trendOk,
    volumeSpike: technical.volumeSpike,
  });
  if (conf < config.minConfidence) return null;

  const quality = qualityLabel(conf);
  tags.unshift(quality);

  const summary = [
    `${side} ${symbol} on ${config.timeframe}`,
    `${config.exchange.toUpperCase()} · conf ${conf}% · ${quality}`,
  ].join(" · ");

  return {
    id: signalId(symbol, side, closed.closeTime),
    symbol,
    side,
    exchange: config.exchange,
    timeframe: config.timeframe,
    trendTimeframe: config.trendTimeframe,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    riskReward1: levels.riskReward1,
    riskReward2: levels.riskReward2,
    technical,
    fundamental,
    confidence: conf,
    quality,
    tags,
    summary,
    createdAt: Date.now(),
  };
}
