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
  BINANCE_API_KEY: z.string().optional().default(""),
  BINANCE_API_SECRET: z.string().optional().default(""),
  BINANCE_FUTURES_BASE_URL: z
    .string()
    .url()
    .optional()
    .default("https://fapi.binance.com"),
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
  SCAN_INTERVAL_MS: num("60000"),
  MIN_QUOTE_VOLUME_USDT: num("5000000"),
  MAX_PAIRS: num("0"),
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
  VOLUME_SPIKE_MULT: num("1.2"),
  MIN_TECHNICAL_SCORE: num("2"),
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

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

if (env.EMA_FAST >= env.EMA_SLOW) {
  throw new Error("EMA_FAST must be less than EMA_SLOW");
}

export const config = {
  telegramToken: env.TELEGRAM_BOT_TOKEN,
  allowedChatIds: new Set(
    env.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  binanceApiKey: env.BINANCE_API_KEY,
  binanceApiSecret: env.BINANCE_API_SECRET,
  binanceBaseUrl: env.BINANCE_FUTURES_BASE_URL.replace(/\/$/, ""),
  timeframe: env.TIMEFRAME as Timeframe,
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
  volumeSpikeMult: Math.max(1, env.VOLUME_SPIKE_MULT),
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
  statePath: "data/state.json",
};
