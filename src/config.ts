import "dotenv/config";
import path from "path";
import { z } from "zod";
import { resolveChain, type ChainConfig } from "./chains";

/** Project root (folder with package.json), whether running from src/ or dist/. */
const PROJECT_ROOT = path.resolve(__dirname, "..");
const dataDir = path.join(PROJECT_ROOT, "data");

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(""),
  /** robinhood */
  CHAIN: z.string().optional().default("robinhood"),
  ROBINHOOD_RPC_URL: z.string().optional().default(""),
  ALCHEMY_API_KEY: z.string().optional().default(""),
  COPY_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  DRY_RUN: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  /** Only alert/copy free mints; skip paid buys and transfers. */
  FREE_MINTS_ONLY: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  PRIVATE_KEY: z.string().optional().default(""),
  /** Comma-separated extra mint wallet private keys */
  PRIVATE_KEYS: z.string().optional().default(""),
  MAX_BUY_ROBINHOOD: z
    .string()
    .optional()
    .default("0.05"),
  MAX_GAS_GWEI: z
    .string()
    .optional()
    .default("40")
    .transform((v) => Number(v)),
  MAX_MINT_GAS_LIMIT: z
    .string()
    .optional()
    .default("500000")
    .transform((v) => Number(v)),
  POLL_INTERVAL_MS: z.string().optional().default(""),
  LOOKBACK_BLOCKS: z.string().optional().default(""),
  ALLOWED_COLLECTIONS: z.string().optional().default(""),
  OPENSEA_API_KEY: z.string().optional().default(""),
  PRICE_ALERTS_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  PRICE_ALERT_PCT: z
    .string()
    .optional()
    .default("10")
    .transform((v) => Number(v)),
  PRICE_POLL_INTERVAL_MS: z
    .string()
    .optional()
    .default("120000")
    .transform((v) => Number(v)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid configuration:\n${details}`);
}

const env = parsed.data;
const chain: ChainConfig = resolveChain(env.CHAIN);
const rpcUrl = env.ROBINHOOD_RPC_URL.trim() || chain.defaultRpcUrl;

if (!rpcUrl.startsWith("http")) {
  throw new Error("ROBINHOOD_RPC_URL must be a valid RPC URL");
}

const maxBuyRobinhood = Number(env.MAX_BUY_ROBINHOOD);
if (!Number.isFinite(maxBuyRobinhood) || maxBuyRobinhood <= 0) {
  throw new Error("MAX_BUY_ROBINHOOD must be > 0");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function numberOr(value: string, fallback: number): number {
  if (!value.trim()) {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  telegramToken: env.TELEGRAM_BOT_TOKEN,
  allowedChatIds: new Set(splitCsv(env.TELEGRAM_ALLOWED_CHAT_IDS)),
  chain,
  rpcUrl,
  alchemyApiKey: env.ALCHEMY_API_KEY,
  copyEnabled: env.COPY_ENABLED,
  dryRun: env.DRY_RUN,
  freeMintsOnly: env.FREE_MINTS_ONLY,
  privateKey: env.PRIVATE_KEY,
  privateKeys: splitCsv(env.PRIVATE_KEYS),
  maxBuyRobinhood,
  maxGasGwei: env.MAX_GAS_GWEI,
  maxMintGasLimit: env.MAX_MINT_GAS_LIMIT,
  pollIntervalMs: numberOr(env.POLL_INTERVAL_MS, chain.defaultPollIntervalMs),
  lookbackBlocks: numberOr(env.LOOKBACK_BLOCKS, chain.defaultLookbackBlocks),
  allowedCollections: splitCsv(env.ALLOWED_COLLECTIONS).map((a) =>
    a.toLowerCase()
  ),
  openseaApiKey: env.OPENSEA_API_KEY,
  priceAlertsEnabled: env.PRICE_ALERTS_ENABLED,
  priceAlertPct:
    Number.isFinite(env.PRICE_ALERT_PCT) && env.PRICE_ALERT_PCT > 0
      ? env.PRICE_ALERT_PCT
      : 10,
  pricePollIntervalMs:
    Number.isFinite(env.PRICE_POLL_INTERVAL_MS) && env.PRICE_POLL_INTERVAL_MS >= 30_000
      ? env.PRICE_POLL_INTERVAL_MS
      : 120_000,
  statePath: path.join(dataDir, "state.json"),
  mintWalletsPath: path.join(dataDir, "mint-wallets.json"),
  projectRoot: PROJECT_ROOT,
};
