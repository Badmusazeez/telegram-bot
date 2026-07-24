import "dotenv/config";
import { z } from "zod";
import type { Timeframe } from "./types";

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .default(defaultValue ? "true" : "false")
    .transform((v) => v.toLowerCase() === "true");

const num = (defaultValue: string) =>
  z
    .string()
    .optional()
    .default(defaultValue)
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n), "must be a number");

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(""),
  EXCHANGE: z
    .string()
    .optional()
    .default("mexc")
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => v === "mexc" || v === "binance", "EXCHANGE must be mexc or binance"),
  BINANCE_API_KEY: z.string().optional().default(""),
  BINANCE_API_SECRET: z.string().optional().default(""),
  BINANCE_FUTURES_BASE_URL: z
    .string()
    .url()
    .optional()
    .default("https://fapi.binance.com"),
  MEXC_FUTURES_BASE_URL: z
    .string()
    .url()
    .optional()
    .default("https://contract.mexc.com"),
  TIMEFRAME: z
    .string()
    .optional()
    .default("15m")
    .refine(
      (v) =>
        [
          "1m",
          "3m",
          "5m",
          "15m",
          "30m",
          "1h",
          "2h",
          "4h",
          "6h",
          "12h",
          "1d",
        ].includes(v),
      "invalid TIMEFRAME"
    ),
  SCAN_INTERVAL_MS: num("120000"),
  MIN_QUOTE_VOLUME_USDT: num("8000000"),
  MAX_PAIRS: num("40"),
  SYMBOL_WHITELIST: z.string().optional().default(""),
  SYMBOL_BLACKLIST: z.string().optional().default(""),
  EMA_FAST: num("9"),
  EMA_SLOW: num("21"),
  REQUIRE_RSI: bool(true),
  RSI_PERIOD: num("14"),
  RSI_LONG_MIN: num("45"),
  RSI_LONG_MAX: num("70"),
  RSI_SHORT_MIN: num("30"),
  RSI_SHORT_MAX: num("55"),
  REQUIRE_MACD: bool(true),
  REQUIRE_VOLUME: bool(true),
  VOLUME_MA_PERIOD: num("20"),
  VOLUME_SPIKE_MULT: num("1.5"),
  MIN_TECHNICAL_SCORE: num("3"),
  REQUIRE_VOLUME_SPIKE: bool(true),
  REQUIRE_TREND_ALIGNMENT: bool(true),
  TREND_TIMEFRAME: z.string().optional().default("1h"),
  MIN_CONFIDENCE: num("85"),
  MIN_ATR_PCT: num("0.2"),
  MAX_ATR_PCT: num("6"),
  MAX_ALERTS_PER_SCAN: num("3"),
  MIN_RISK_REWARD: num("2.5"),
  ACCOUNT_BALANCE_USDT: num("1000"),
  RISK_PERCENT: num("1"),
  MAX_STOP_PCT: num("0.05"),
  LOG_NO_TRADE: bool(false),
  /** strict = current hard gates; balanced/relaxed soften SMC/PA/volume kills */
  GATE_MODE: z
    .string()
    .optional()
    .default("strict")
    .transform((v) => v.trim().toLowerCase())
    .refine(
      (v) => v === "strict" || v === "balanced" || v === "relaxed",
      "GATE_MODE must be strict, balanced, or relaxed"
    ),
  REQUIRE_SMC_HARD: bool(true),
  REQUIRE_PA_HARD: bool(true),
  REQUIRE_VOLUME_HARD: bool(true),
  REQUIRE_MOMENTUM_HARD: bool(true),
  SMC_MIN_SCORE: num("0.35"),
  PA_MIN_SCORE: num("0.5"),
  VOLUME_MIN_SCORE: num("0.55"),
  MOMENTUM_MIN_SCORE: num("0.55"),
  REQUIRE_FUNDING: bool(true),
  FUNDING_LONG_MAX: num("0.0005"),
  FUNDING_SHORT_MIN: num("-0.0005"),
  REQUIRE_OPEN_INTEREST: bool(true),
  OI_LOOKBACK_PERIODS: num("6"),
  MIN_FUNDAMENTAL_SCORE: num("1"),
  ATR_PERIOD: num("14"),
  STOP_LOSS_ATR_MULT: num("1.5"),
  TAKE_PROFIT_ATR_MULT: num("3"),
  TAKE_PROFIT_2_ATR_MULT: num("5"),
  SIGNAL_COOLDOWN_MS: num("3600000"),
  DRY_RUN: bool(false),
  ALERTS_ENABLED: bool(true),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid configuration:\n${details}`);
}

const env = parsed.data;

type GateMode = "strict" | "balanced" | "relaxed";
const gateMode = env.GATE_MODE as GateMode;

function hasEnv(key: string): boolean {
  return process.env[key] !== undefined && String(process.env[key]).trim() !== "";
}

/** Mode presets from the historical confluence audit (SMC was the hard blocker). */
const gatePreset: Record<
  GateMode,
  {
    minConfidence: number;
    volumeSpikeMult: number;
    minRiskReward: number;
    requireSmcHard: boolean;
    requirePaHard: boolean;
    requireVolumeHard: boolean;
    requireMomentumHard: boolean;
    smcMinScore: number;
    paMinScore: number;
    volumeMinScore: number;
    momentumMinScore: number;
  }
> = {
  strict: {
    minConfidence: 85,
    volumeSpikeMult: 1.5,
    minRiskReward: 2.5,
    requireSmcHard: true,
    requirePaHard: true,
    requireVolumeHard: true,
    requireMomentumHard: true,
    smcMinScore: 0.5,
    paMinScore: 0.6,
    volumeMinScore: 0.7,
    momentumMinScore: 0.65,
  },
  balanced: {
    minConfidence: 75,
    volumeSpikeMult: 1.3,
    minRiskReward: 2.0,
    requireSmcHard: false,
    requirePaHard: true,
    requireVolumeHard: true,
    requireMomentumHard: true,
    smcMinScore: 0.35,
    paMinScore: 0.55,
    volumeMinScore: 0.55,
    momentumMinScore: 0.55,
  },
  relaxed: {
    minConfidence: 70,
    volumeSpikeMult: 1.2,
    minRiskReward: 1.8,
    requireSmcHard: false,
    requirePaHard: false,
    requireVolumeHard: false,
    requireMomentumHard: false,
    smcMinScore: 0.25,
    paMinScore: 0.45,
    volumeMinScore: 0.45,
    momentumMinScore: 0.5,
  },
};

const preset = gatePreset[gateMode];

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

if (env.EMA_FAST >= env.EMA_SLOW) {
  throw new Error("EMA_FAST must be less than EMA_SLOW");
}

if (
  env.EXCHANGE === "mexc" &&
  !["1m", "5m", "15m", "30m", "1h", "4h", "1d"].includes(env.TIMEFRAME)
) {
  throw new Error(
    `TIMEFRAME=${env.TIMEFRAME} is not supported on MEXC. Use 1m, 5m, 15m, 30m, 1h, 4h, or 1d.`
  );
}

const trendTfRaw = (env.TREND_TIMEFRAME || "1h").trim().toLowerCase();
const autoTrend: Record<string, string> = {
  "1m": "15m",
  "3m": "15m",
  "5m": "15m",
  "15m": "1h",
  "30m": "1h",
  "1h": "4h",
  "2h": "4h",
  "4h": "1d",
  "6h": "1d",
  "12h": "1d",
  "1d": "1d",
};
const trendTimeframe =
  trendTfRaw === "auto" ? autoTrend[env.TIMEFRAME] ?? "1h" : trendTfRaw;

if (
  env.EXCHANGE === "mexc" &&
  env.REQUIRE_TREND_ALIGNMENT &&
  !["1m", "5m", "15m", "30m", "1h", "4h", "1d"].includes(trendTimeframe)
) {
  throw new Error(
    `TREND_TIMEFRAME=${trendTimeframe} is not supported on MEXC.`
  );
}

export const config = {
  telegramToken: env.TELEGRAM_BOT_TOKEN,
  allowedChatIds: new Set(
    env.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  exchange: env.EXCHANGE as "mexc" | "binance",
  binanceApiKey: env.BINANCE_API_KEY,
  binanceApiSecret: env.BINANCE_API_SECRET,
  binanceBaseUrl: env.BINANCE_FUTURES_BASE_URL.replace(/\/$/, ""),
  mexcBaseUrl: env.MEXC_FUTURES_BASE_URL.replace(/\/$/, ""),
  timeframe: env.TIMEFRAME as Timeframe,
  trendTimeframe: trendTimeframe as Timeframe,
  requireTrendAlignment: env.REQUIRE_TREND_ALIGNMENT,
  requireVolumeSpike: env.REQUIRE_VOLUME_SPIKE,
  gateMode,
  minConfidence: Math.max(
    0,
    Math.min(
      100,
      Math.floor(
        hasEnv("MIN_CONFIDENCE") ? env.MIN_CONFIDENCE : preset.minConfidence
      )
    )
  ),
  minAtrPct: Math.max(0, env.MIN_ATR_PCT),
  maxAtrPct: Math.max(0.1, env.MAX_ATR_PCT),
  maxAlertsPerScan: Math.max(0, Math.floor(env.MAX_ALERTS_PER_SCAN)),
  scanIntervalMs: Math.max(15_000, env.SCAN_INTERVAL_MS),
  minQuoteVolumeUsdt: Math.max(0, env.MIN_QUOTE_VOLUME_USDT),
  maxPairs: Math.max(0, Math.floor(env.MAX_PAIRS)),
  symbolWhitelist: splitCsv(env.SYMBOL_WHITELIST),
  symbolBlacklist: new Set(splitCsv(env.SYMBOL_BLACKLIST)),
  emaFast: Math.max(2, Math.floor(env.EMA_FAST)),
  emaSlow: Math.max(3, Math.floor(env.EMA_SLOW)),
  requireRsi: env.REQUIRE_RSI,
  rsiPeriod: Math.max(2, Math.floor(env.RSI_PERIOD)),
  rsiLongMin: env.RSI_LONG_MIN,
  rsiLongMax: env.RSI_LONG_MAX,
  rsiShortMin: env.RSI_SHORT_MIN,
  rsiShortMax: env.RSI_SHORT_MAX,
  requireMacd: env.REQUIRE_MACD,
  requireVolume: env.REQUIRE_VOLUME,
  volumeMaPeriod: Math.max(2, Math.floor(env.VOLUME_MA_PERIOD)),
  volumeSpikeMult: Math.max(
    1,
    hasEnv("VOLUME_SPIKE_MULT")
      ? env.VOLUME_SPIKE_MULT
      : preset.volumeSpikeMult
  ),
  minTechnicalScore: Math.max(1, Math.floor(env.MIN_TECHNICAL_SCORE)),
  requireFunding: env.REQUIRE_FUNDING,
  fundingLongMax: env.FUNDING_LONG_MAX,
  fundingShortMin: env.FUNDING_SHORT_MIN,
  requireOpenInterest: env.REQUIRE_OPEN_INTEREST,
  oiLookbackPeriods: Math.max(2, Math.floor(env.OI_LOOKBACK_PERIODS)),
  minFundamentalScore: Math.max(0, Math.floor(env.MIN_FUNDAMENTAL_SCORE)),
  atrPeriod: Math.max(2, Math.floor(env.ATR_PERIOD)),
  stopLossAtrMult: Math.max(0.1, env.STOP_LOSS_ATR_MULT),
  takeProfitAtrMult: Math.max(0.1, env.TAKE_PROFIT_ATR_MULT),
  takeProfit2AtrMult: Math.max(0.1, env.TAKE_PROFIT_2_ATR_MULT),
  signalCooldownMs: Math.max(60_000, env.SIGNAL_COOLDOWN_MS),
  dryRun: env.DRY_RUN,
  alertsEnabled: env.ALERTS_ENABLED,
  minRiskReward: Math.max(
    1,
    hasEnv("MIN_RISK_REWARD") ? env.MIN_RISK_REWARD : preset.minRiskReward
  ),
  accountBalanceUsdt: Math.max(1, env.ACCOUNT_BALANCE_USDT),
  riskPercent: Math.max(0.1, env.RISK_PERCENT),
  maxStopPct: Math.max(0.005, env.MAX_STOP_PCT),
  logNoTrade: env.LOG_NO_TRADE,
  requireSmcHard: hasEnv("REQUIRE_SMC_HARD")
    ? env.REQUIRE_SMC_HARD
    : preset.requireSmcHard,
  requirePaHard: hasEnv("REQUIRE_PA_HARD")
    ? env.REQUIRE_PA_HARD
    : preset.requirePaHard,
  requireVolumeHard: hasEnv("REQUIRE_VOLUME_HARD")
    ? env.REQUIRE_VOLUME_HARD
    : preset.requireVolumeHard,
  requireMomentumHard: hasEnv("REQUIRE_MOMENTUM_HARD")
    ? env.REQUIRE_MOMENTUM_HARD
    : preset.requireMomentumHard,
  smcMinScore: Math.max(
    0,
    Math.min(
      1,
      hasEnv("SMC_MIN_SCORE") ? env.SMC_MIN_SCORE : preset.smcMinScore
    )
  ),
  paMinScore: Math.max(
    0,
    Math.min(1, hasEnv("PA_MIN_SCORE") ? env.PA_MIN_SCORE : preset.paMinScore)
  ),
  volumeMinScore: Math.max(
    0,
    Math.min(
      1,
      hasEnv("VOLUME_MIN_SCORE") ? env.VOLUME_MIN_SCORE : preset.volumeMinScore
    )
  ),
  momentumMinScore: Math.max(
    0,
    Math.min(
      1,
      hasEnv("MOMENTUM_MIN_SCORE")
        ? env.MOMENTUM_MIN_SCORE
        : preset.momentumMinScore
    )
  ),
  statePath: "data/state.json",
};
