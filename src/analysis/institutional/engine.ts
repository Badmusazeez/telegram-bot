import { atr } from "../indicators";
import { config } from "../../config";
import type { Side } from "../../types";
import { analyzeFuturesMetrics } from "./futures";
import { analyzeFundamental } from "./fundamental";
import { analyzeMomentum } from "./momentum";
import { analyzePriceAction, structureStop } from "./priceAction";
import { analyzeSmc } from "./smc";
import { analyzeTrend, summarizeHtf } from "./trend";
import { analyzeVolume } from "./volume";
import type {
  FactorResult,
  InstitutionalAnalysis,
  MultiTfBundle,
  Verdict,
} from "./types";
import { closed, lastClose } from "./types";

const NO_TRADE = "NO TRADE – WAIT FOR BETTER CONFIRMATION";

function verdictFor(side: Side, confidence: number): Verdict {
  if (confidence >= 92) return side === "BUY" ? "STRONG BUY" : "STRONG SELL";
  if (confidence >= config.minConfidence) return side === "BUY" ? "BUY" : "SELL";
  if (confidence >= 70) return "WAIT";
  return "NO TRADE";
}

function estimateHolding(timeframe: string): string {
  const map: Record<string, string> = {
    "5m": "30m–4h",
    "15m": "2h–12h",
    "30m": "4h–1d",
    "1h": "8h–2d",
    "4h": "1d–5d",
    "1d": "3d–2w",
  };
  return map[timeframe] ?? "several hours to 1–2 days";
}

export async function runInstitutionalAnalysis(
  symbol: string,
  bundle: MultiTfBundle
): Promise<InstitutionalAnalysis> {
  const trend = analyzeTrend(bundle);
  const preferred = trend.directionBias;

  const momentum = analyzeMomentum(bundle, preferred);
  const volume = analyzeVolume(bundle, preferred);
  const priceAction = analyzePriceAction(bundle, preferred);
  const smc = analyzeSmc(bundle, preferred);
  const futures = await analyzeFuturesMetrics(symbol, preferred);
  const fundamental = await analyzeFundamental(symbol, preferred);

  const factors: FactorResult[] = [
    trend,
    momentum,
    volume,
    priceAction,
    smc,
    futures,
    fundamental,
  ];

  const missing = factors
    .filter((f) => f.missingKey)
    .map((f) => `${f.name}: ${f.reasons[0] ?? "incomplete"}`);

  const keySides = [trend, momentum, volume, priceAction, smc]
    .map((f) => f.directionBias)
    .filter((s): s is Side => s === "BUY" || s === "SELL");
  const conflict =
    keySides.includes("BUY") &&
    keySides.includes("SELL") &&
    preferred !== "NEUTRAL";

  const confidence = Math.round(
    factors.reduce((sum, f) => sum + f.weight * f.score, 0) * 100
  );

  const entry = lastClose(bundle.primary);
  const atrSeries = atr(closed(bundle.primary), 14);
  const atrVal = atrSeries[closed(bundle.primary).length - 1] ?? entry * 0.01;

  type RejectStage = InstitutionalAnalysis["rejectStage"];

  const empty = (
    reason: string,
    rejectStage: RejectStage
  ): InstitutionalAnalysis => ({
    side: null,
    confidence,
    verdict: "NO TRADE",
    noTrade: true,
    noTradeReason: reason,
    rejectStage,
    factors,
    htfTrend: summarizeHtf(bundle),
    whyValid: [],
    entry,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    takeProfit3: 0,
    riskReward: 0,
    positionSize: 0,
    accountBalance: config.accountBalanceUsdt,
    riskPercent: config.riskPercent,
    estimatedHolding: estimateHolding(config.timeframe),
    invalidation: [],
    majorRisks: factors
      .flatMap((f) =>
        f.reasons.filter((r) =>
          /miss|conflict|caution|unavailable|choppy/i.test(r)
        )
      )
      .slice(0, 6),
    missing,
  });

  // Waterfall: first failing key stage wins for funnel attribution
  if (!trend.aligned || preferred === "NEUTRAL") {
    return empty(`${NO_TRADE} (trend incomplete)`, "trend");
  }
  if (!momentum.aligned) {
    return empty(`${NO_TRADE} (momentum incomplete)`, "momentum");
  }
  if (!volume.aligned) {
    return empty(`${NO_TRADE} (volume incomplete)`, "volume");
  }
  if (!priceAction.aligned) {
    return empty(`${NO_TRADE} (price action incomplete)`, "priceAction");
  }
  if (!smc.aligned) {
    return empty(`${NO_TRADE} (SMC incomplete)`, "smc");
  }
  if (conflict) {
    return empty(`${NO_TRADE} (conflicting factor directions)`, "conflict");
  }
  if (confidence < config.minConfidence) {
    return empty(
      `${NO_TRADE} (confidence ${confidence}% < ${config.minConfidence}%)`,
      "confidence"
    );
  }

  const side = preferred;
  const stopLoss = structureStop(bundle.primary, side, entry, atrVal);
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0 || risk / entry > config.maxStopPct) {
    return empty(
      `${NO_TRADE} (stop distance ${(100 * risk) / Math.max(entry, 1e-9)}% exceeds max ${config.maxStopPct * 100}% or invalid)`,
      "riskReward"
    );
  }

  const rrMult1 = Math.max(config.minRiskReward, 2.5);
  const takeProfit1 =
    side === "BUY" ? entry + risk * rrMult1 : entry - risk * rrMult1;
  const takeProfit2 =
    side === "BUY" ? entry + risk * (rrMult1 + 0.5) : entry - risk * (rrMult1 + 0.5);
  const takeProfit3 =
    side === "BUY" ? entry + risk * (rrMult1 + 1.5) : entry - risk * (rrMult1 + 1.5);
  const riskReward = rrMult1;

  const riskAmount = config.accountBalanceUsdt * (config.riskPercent / 100);
  const positionSize = risk > 0 ? riskAmount / risk : 0;

  const whyValid = factors
    .filter((f) => f.aligned || f.score >= 0.6)
    .flatMap((f) => f.reasons.slice(0, 2))
    .slice(0, 10);

  const invalidation = [
    side === "BUY"
      ? `Close below structure SL ${stopLoss}`
      : `Close above structure SL ${stopLoss}`,
    "HTF (4H/D) flip against position",
    "Volume dries up and price re-enters prior range",
  ];

  const majorRisks = [
    ...missing.map((m) => `Incomplete: ${m}`),
    "Crypto volatility / wick stop-outs",
    "Funding or OI can flip quickly on MEXC/Binance",
    "News/macro not fully monitored without calendar API",
  ].slice(0, 6);

  const verdict = verdictFor(side, confidence);
  if (
    verdict !== "BUY" &&
    verdict !== "STRONG BUY" &&
    verdict !== "SELL" &&
    verdict !== "STRONG SELL"
  ) {
    return empty(`${NO_TRADE} (verdict ${verdict})`, "verdict");
  }

  return {
    side,
    confidence,
    verdict,
    noTrade: false,
    noTradeReason: null,
    rejectStage: "passed",
    factors,
    htfTrend: summarizeHtf(bundle),
    whyValid,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,
    riskReward,
    positionSize,
    accountBalance: config.accountBalanceUsdt,
    riskPercent: config.riskPercent,
    estimatedHolding: estimateHolding(config.timeframe),
    invalidation,
    majorRisks,
    missing,
  };
}
