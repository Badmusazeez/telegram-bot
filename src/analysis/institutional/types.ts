import type { Candle, Side } from "../../types";

export type FactorName =
  | "trend"
  | "momentum"
  | "volume"
  | "priceAction"
  | "smc"
  | "futures"
  | "fundamental";

export interface FactorResult {
  name: FactorName;
  weight: number;
  score: number; // 0..1
  aligned: boolean;
  missingKey: boolean;
  reasons: string[];
  directionBias: Side | "NEUTRAL";
  /** Numeric diagnostics for near-miss reporting. */
  metrics?: Record<string, number>;
}

export type Verdict =
  | "STRONG BUY"
  | "BUY"
  | "WAIT"
  | "SELL"
  | "STRONG SELL"
  | "NO TRADE";

export interface InstitutionalAnalysis {
  side: Side | null;
  confidence: number;
  verdict: Verdict;
  noTrade: boolean;
  noTradeReason: string | null;
  /** First failing funnel stage, or "passed". */
  rejectStage:
    | "trend"
    | "momentum"
    | "volume"
    | "priceAction"
    | "smc"
    | "conflict"
    | "confidence"
    | "riskReward"
    | "verdict"
    | "passed";
  factors: FactorResult[];
  htfTrend: string;
  whyValid: string[];
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskReward: number;
  positionSize: number;
  accountBalance: number;
  riskPercent: number;
  estimatedHolding: string;
  invalidation: string[];
  majorRisks: string[];
  missing: string[];
  /** Human-readable near-miss line for rejects. */
  nearMissLine: string | null;
  /** Lower = closer to passing (for ranking near misses). */
  nearMissDistance: number;
}

export interface MultiTfBundle {
  primary: Candle[]; // usually 15m
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

export function closed(candles: Candle[]): Candle[] {
  return candles.length > 1 ? candles.slice(0, -1) : candles;
}

export function lastClose(candles: Candle[]): number {
  const c = closed(candles);
  return c[c.length - 1]?.close ?? 0;
}
