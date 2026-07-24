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

const CORE_LABELS: Array<{ name: FactorResult["name"]; label: string }> = [
  { name: "trend", label: "Trend" },
  { name: "momentum", label: "Momentum" },
  { name: "volume", label: "Volume" },
  { name: "priceAction", label: "Price Action" },
  { name: "smc", label: "SMC" },
];

function pct(score: number | undefined): number {
  return Math.round(Math.max(0, Math.min(1, score ?? 0)) * 100);
}

function scoreLine(label: string, value: number, width = 14): string {
  const dots = ".".repeat(Math.max(2, width - label.length));
  return `${label} ${dots} ${value}%`;
}

function rejectReasonBullets(
  rejectStage: InstitutionalAnalysis["rejectStage"],
  factors: FactorResult[],
  confidence: number,
  extras?: { stopPct?: number }
): string[] {
  const byName = Object.fromEntries(factors.map((f) => [f.name, f]));
  const bullets: string[] = [];
  const seen = new Set<string>();

  const push = (text: string) => {
    const t = text.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    bullets.push(t);
  };

  if (rejectStage === "volume") {
    const mult = byName.volume?.metrics?.volumeMult ?? 0;
    const need = byName.volume?.metrics?.volumeNeed ?? config.volumeSpikeMult;
    if (mult < need) push(`Volume below ${need.toFixed(2)}× (now ${mult.toFixed(2)}×)`);
  } else if (rejectStage === "confidence") {
    push(`Overall confidence ${confidence}% < ${config.minConfidence}%`);
  } else if (rejectStage === "momentum") {
    const adx = byName.momentum?.metrics?.adx ?? 0;
    if (adx <= 25) push(`ADX = ${adx.toFixed(1)} (needs >25)`);
  } else if (rejectStage === "trend") {
    push("Trend stack / HTF not aligned");
  } else if (rejectStage === "priceAction") {
    push("Breakout/retest/candle confirmation missing");
  } else if (rejectStage === "smc") {
    push("BOS/CHoCH/OB/FVG/zone incomplete");
  } else if (rejectStage === "riskReward") {
    const stopPct = extras?.stopPct ?? 0;
    push(
      `Stop = ${(stopPct * 100).toFixed(2)}% (max ${(config.maxStopPct * 100).toFixed(2)}%) or RR invalid`
    );
  } else if (rejectStage === "conflict") {
    push("Conflicting factor directions");
  } else if (rejectStage === "verdict") {
    push(`Verdict not actionable (confidence ${confidence}%)`);
  }

  const missHint =
    /miss|needs|insufficient|conflict|incomplete|below|not aligned|choppy|unavailable|ADX|MACD|Volume|OBV|CMF|BOS|FVG|retest|breakout/i;

  for (const { name } of CORE_LABELS) {
    const f = byName[name];
    if (!f || f.aligned) continue;
    for (const r of f.reasons) {
      if (missHint.test(r)) push(r);
      if (bullets.length >= 5) break;
    }
    if (bullets.length >= 5) break;
  }

  if (!bullets.length) push(`Rejected at ${rejectStage}`);
  return bullets.slice(0, 5);
}

/** Multi-line scorecard for rejected / near-miss candidates. */
export function buildNearMissLine(
  symbol: string,
  rejectStage: InstitutionalAnalysis["rejectStage"],
  factors: FactorResult[],
  confidence: number,
  extras?: { stopPct?: number }
): { line: string; distance: number } {
  const byName = Object.fromEntries(factors.map((f) => [f.name, f]));
  const core = CORE_LABELS.map(({ name }) => byName[name]);

  if (rejectStage === "passed") {
    return { line: `${symbol}: PASSED`, distance: 0 };
  }

  const scoreLines = CORE_LABELS.map(({ name, label }) =>
    scoreLine(label, pct(byName[name]?.score))
  );
  const reasons = rejectReasonBullets(
    rejectStage,
    factors,
    confidence,
    extras
  );

  const line = [
    symbol,
    ...scoreLines,
    `Overall Confidence: ${confidence}%`,
    "Reason rejected:",
    ...reasons.map((r) => `* ${r}`),
  ].join("\n");

  // Rank "warming up" candidates: high confidence + high avg core scores first
  const avgCore =
    core.reduce((sum, f) => sum + (f?.score ?? 0), 0) / Math.max(1, core.length);
  const passedCount = core.filter((f) => f?.aligned).length;
  let distance =
    Math.max(0, config.minConfidence - confidence) + (1 - avgCore) * 20;

  if (rejectStage === "volume") {
    const mult = byName.volume?.metrics?.volumeMult ?? 0;
    const need = byName.volume?.metrics?.volumeNeed ?? config.volumeSpikeMult;
    distance = Math.min(distance, Math.max(0, need - mult) * 10 + 1);
  } else if (rejectStage === "momentum") {
    const adx = byName.momentum?.metrics?.adx ?? 0;
    distance = Math.min(distance, Math.max(0, 25 - adx) + 5);
  } else if (rejectStage === "riskReward") {
    const stopPct = extras?.stopPct ?? 0;
    distance = Math.min(
      distance,
      Math.max(0, stopPct - config.maxStopPct) * 100 + 2
    );
  }

  distance += Math.max(0, 5 - passedCount) * 0.15;
  return { line, distance };
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
    rejectStage: RejectStage,
    extras?: { stopPct?: number }
  ): InstitutionalAnalysis => {
    const near = buildNearMissLine(
      symbol,
      rejectStage,
      factors,
      confidence,
      extras
    );
    return {
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
      nearMissLine: near.line,
      nearMissDistance: near.distance,
    };
  };

  if (!trend.aligned || preferred === "NEUTRAL") {
    return empty(`${NO_TRADE} (trend incomplete)`, "trend");
  }

  const momentumOk = config.requireMomentumHard
    ? momentum.aligned
    : momentum.score >= config.momentumMinScore;
  if (!momentumOk) {
    return empty(`${NO_TRADE} (momentum incomplete)`, "momentum");
  }

  const volumeOk = config.requireVolumeHard
    ? volume.aligned
    : volume.score >= config.volumeMinScore;
  if (!volumeOk) {
    return empty(`${NO_TRADE} (volume incomplete)`, "volume");
  }

  const priceActionOk = config.requirePaHard
    ? priceAction.aligned
    : priceAction.score >= config.paMinScore;
  if (!priceActionOk) {
    return empty(`${NO_TRADE} (price action incomplete)`, "priceAction");
  }

  const smcOk = config.requireSmcHard
    ? smc.aligned
    : smc.score >= config.smcMinScore;
  if (!smcOk) {
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
  const stopPct = entry > 0 ? risk / entry : 1;
  if (risk <= 0 || stopPct > config.maxStopPct) {
    return empty(
      `${NO_TRADE} (stop distance ${(stopPct * 100).toFixed(2)}% exceeds max ${config.maxStopPct * 100}% or invalid)`,
      "riskReward",
      { stopPct }
    );
  }

  const rrMult1 = Math.max(1, config.minRiskReward);
  const takeProfit1 =
    side === "BUY" ? entry + risk * rrMult1 : entry - risk * rrMult1;
  const takeProfit2 =
    side === "BUY" ? entry + risk * (rrMult1 + 0.5) : entry - risk * (rrMult1 + 0.5);
  const takeProfit3 =
    side === "BUY" ? entry + risk * (rrMult1 + 1.5) : entry - risk * (rrMult1 + 1.5);

  const whyValid = factors
    .filter((f) => f.aligned || f.score >= 0.6)
    .flatMap((f) => f.reasons.slice(0, 2))
    .slice(0, 10);

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
    riskReward: rrMult1,
    positionSize:
      risk > 0
        ? (config.accountBalanceUsdt * (config.riskPercent / 100)) / risk
        : 0,
    accountBalance: config.accountBalanceUsdt,
    riskPercent: config.riskPercent,
    estimatedHolding: estimateHolding(config.timeframe),
    invalidation: [
      side === "BUY"
        ? `Close below structure SL ${stopLoss}`
        : `Close above structure SL ${stopLoss}`,
      "HTF (4H/D) flip against position",
      "Volume dries up and price re-enters prior range",
    ],
    majorRisks: [
      "Crypto volatility / wick stop-outs",
      "Funding or OI can flip quickly",
      "News/macro not fully monitored without calendar API",
    ],
    missing,
    nearMissLine: null,
    nearMissDistance: 0,
  };
}
