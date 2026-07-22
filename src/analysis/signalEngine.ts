import { createHash } from "node:crypto";
import { config } from "../config";
import { runInstitutionalAnalysis } from "./institutional/engine";
import type { MultiTfBundle } from "./institutional/types";
import type { Candle, TradeSignal } from "../types";

function signalId(symbol: string, side: string, candleCloseTime: number): string {
  return createHash("sha1")
    .update(
      `${config.exchange}|inst|${symbol}|${side}|${candleCloseTime}|${config.timeframe}`
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Institutional multi-factor evaluation.
 * Returns null when verdict is NO TRADE / WAIT (unless caller logs no-trade).
 */
export async function evaluateSymbol(
  symbol: string,
  candles: Candle[],
  trendCandles?: Candle[],
  extra?: { h4?: Candle[]; d1?: Candle[] }
): Promise<TradeSignal | null> {
  const bundle: MultiTfBundle = {
    primary: candles,
    h1: trendCandles && trendCandles.length ? trendCandles : candles,
    h4: extra?.h4 && extra.h4.length ? extra.h4 : trendCandles ?? candles,
    d1: extra?.d1 && extra.d1.length ? extra.d1 : extra?.h4 ?? candles,
  };

  const analysis = await runInstitutionalAnalysis(symbol, bundle);

  if (analysis.noTrade || !analysis.side) {
    if (config.logNoTrade) {
      console.log(`[no-trade] ${symbol}: ${analysis.noTradeReason}`);
    }
    return null;
  }

  if (
    analysis.verdict !== "BUY" &&
    analysis.verdict !== "STRONG BUY" &&
    analysis.verdict !== "SELL" &&
    analysis.verdict !== "STRONG SELL"
  ) {
    return null;
  }

  const closed = candles[candles.length - 2] ?? candles[candles.length - 1];
  const techReasons = analysis.factors
    .filter((f) => ["trend", "momentum", "volume", "priceAction", "smc"].includes(f.name))
    .flatMap((f) => f.reasons);
  const fundReasons = analysis.factors
    .filter((f) => f.name === "futures" || f.name === "fundamental")
    .flatMap((f) => f.reasons);

  return {
    id: signalId(symbol, analysis.side, closed.closeTime),
    symbol,
    side: analysis.side,
    exchange: config.exchange,
    timeframe: config.timeframe,
    trendTimeframe: "1h/4h/1d",
    entry: analysis.entry,
    stopLoss: analysis.stopLoss,
    takeProfit1: analysis.takeProfit1,
    takeProfit2: analysis.takeProfit2,
    takeProfit3: analysis.takeProfit3,
    riskReward1: analysis.riskReward,
    riskReward2: analysis.riskReward + 0.5,
    riskReward3: analysis.riskReward + 1.5,
    technical: {
      emaFast: 0,
      emaSlow: 0,
      emaCross: analysis.side,
      rsi: 0,
      macdHistogram: 0,
      macdBullish: analysis.side === "BUY",
      volumeSpike: true,
      atr: Math.abs(analysis.entry - analysis.stopLoss) / 1.2,
      score: analysis.confidence,
      reasons: techReasons,
    },
    fundamental: {
      fundingRate: 0,
      openInterestChangePct: null,
      longShortRatio: null,
      score: analysis.factors.find((f) => f.name === "futures")?.score ?? 0,
      reasons: fundReasons,
    },
    confidence: analysis.confidence,
    quality: analysis.confidence >= 92 ? "HIGH" : "MED",
    tags: [
      analysis.verdict,
      ...analysis.factors.filter((f) => f.aligned).map((f) => f.name),
    ],
    summary: `${analysis.verdict} ${symbol} conf=${analysis.confidence}%`,
    createdAt: Date.now(),
    verdict: analysis.verdict,
    htfTrend: analysis.htfTrend,
    whyValid: analysis.whyValid,
    positionSize: analysis.positionSize,
    accountBalance: analysis.accountBalance,
    riskPercent: analysis.riskPercent,
    estimatedHolding: analysis.estimatedHolding,
    invalidation: analysis.invalidation,
    majorRisks: analysis.majorRisks,
    factorScores: analysis.factors.map((f) => ({
      name: f.name,
      weight: f.weight,
      score: Math.round(f.score * 100),
      aligned: f.aligned,
    })),
  };
}
