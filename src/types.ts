export type Side = "BUY" | "SELL";

export type Timeframe =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "12h"
  | "1d";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
}

export interface FuturesPair {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType: string;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
}

export interface TechnicalSnapshot {
  emaFast: number;
  emaSlow: number;
  emaCross: Side | null;
  rsi: number;
  macdHistogram: number;
  macdBullish: boolean;
  volumeSpike: boolean;
  atr: number;
  score: number;
  reasons: string[];
}

export interface FundamentalSnapshot {
  fundingRate: number;
  openInterestChangePct: number | null;
  longShortRatio: number | null;
  score: number;
  reasons: string[];
}

export interface RiskLevels {
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward1: number;
  riskReward2: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  side: Side;
  exchange: string;
  timeframe: string;
  trendTimeframe: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3?: number;
  riskReward1: number;
  riskReward2: number;
  riskReward3?: number;
  technical: TechnicalSnapshot;
  fundamental: FundamentalSnapshot;
  confidence: number;
  quality: "HIGH" | "MED" | "LOW";
  tags: string[];
  summary: string;
  createdAt: number;
  verdict?: string;
  htfTrend?: string;
  whyValid?: string[];
  positionSize?: number;
  accountBalance?: number;
  riskPercent?: number;
  estimatedHolding?: string;
  invalidation?: string[];
  majorRisks?: string[];
  factorScores?: Array<{
    name: string;
    weight: number;
    score: number;
    aligned: boolean;
  }>;
}

export interface ScannerStats {
  lastScanAt: number | null;
  lastScanDurationMs: number;
  pairsScanned: number;
  signalsFound: number;
  alertsSent: number;
  errors: number;
  running: boolean;
  lastError: string | null;
  lastFunnel: ScanFunnel | null;
}

export interface ScanFunnel {
  totalUniverse: number;
  passedLiquidity: number;
  scanned: number;
  passedTrend: number;
  passedMomentum: number;
  passedVolume: number;
  passedPriceAction: number;
  passedSmc: number;
  passedConfidence: number;
  passedRiskReward: number;
  finalSignals: number;
  rejectCounts: Partial<Record<string, number>>;
  topRejectStage: string | null;
  topRejectCount: number;
  /** Closest rejected candidates with actual metric values. */
  nearMisses: string[];
}

export interface BotState {
  notifyChatIds: string[];
  paused: boolean;
  stats: ScannerStats;
  recentSignalIds: string[];
  lastSignals: Record<string, { side: Side; at: number }>;
}
