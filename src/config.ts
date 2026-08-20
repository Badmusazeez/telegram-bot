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
  /** Primary tracker RPC (Alchemy). */
  ROBINHOOD_RPC_URL: z.string().optional().default(""),
  TRACK_RPC_URL: z.string().optional().default(""),
  /** Optional backup tracker RPC. */
  TRACK_RPC_BACKUP_URL: z.string().optional().default(""),
  /** Mint / send-tx RPC (Chainstack). Falls back to tracker RPC if empty. */
  MINT_RPC_URL: z.string().optional().default(""),
  /** Optional mint backup RPC. */
  MINT_RPC_BACKUP_URL: z.string().optional().default(""),
  ALCHEMY_API_KEY: z.string().optional().default(""),
  /** Alchemy Admin API access key (Usage API) — for exact CU % reports. */
  ALCHEMY_ADMIN_KEY: z.string().optional().default(""),
  /** Chainstack Platform API key — for exact RU % reports. */
  CHAINSTACK_API_KEY: z.string().optional().default(""),
  /** Monthly RU quota for Chainstack plan (Developer free = 3000000). */
  CHAINSTACK_MONTHLY_RU_LIMIT: z
    .string()
    .optional()
    .default("3000000")
    .transform((v) => Number(v)),
  /** How often to Telegram RPC quota % (default 6h). */
  RPC_QUOTA_INTERVAL_MS: z
    .string()
    .optional()
    .default(String(6 * 60 * 60 * 1000))
    .transform((v) => Number(v)),
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
    // Absolute safety ceiling for eth_estimateGas (not a blind send gasLimit).
    // Allows legitimate complex SeaDrop/multicall max-mints (~1.2M) with margin.
    .default("2500000")
    .transform((v) => Number(v)),
  /** Always try this many (or stage wallet_limit if lower) on free mints. */
  MAX_MINT_QUANTITY: z
    .string()
    .optional()
    .default("100")
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
const trackRpcUrl =
  env.TRACK_RPC_URL.trim() ||
  env.ROBINHOOD_RPC_URL.trim() ||
  chain.defaultRpcUrl;
const trackBackupRpcUrl = env.TRACK_RPC_BACKUP_URL.trim();
const mintRpcUrl = env.MINT_RPC_URL.trim() || trackRpcUrl;
const mintBackupCandidate = env.MINT_RPC_BACKUP_URL.trim();
const mintBackupRpcUrl =
  mintBackupCandidate && mintBackupCandidate !== mintRpcUrl
    ? mintBackupCandidate
    : "";

if (!trackRpcUrl.startsWith("http")) {
  throw new Error("TRACK_RPC_URL / ROBINHOOD_RPC_URL must be a valid RPC URL");
}
if (trackBackupRpcUrl && !trackBackupRpcUrl.startsWith("http")) {
  throw new Error("TRACK_RPC_BACKUP_URL must be a valid RPC URL");
}
if (!mintRpcUrl.startsWith("http")) {
  throw new Error("MINT_RPC_URL must be a valid RPC URL");
}
if (mintBackupCandidate && !mintBackupCandidate.startsWith("http")) {
  throw new Error("MINT_RPC_BACKUP_URL must be a valid RPC URL");
}
if (trackBackupRpcUrl && trackBackupRpcUrl === trackRpcUrl) {
  console.warn(
    "[config] TRACK_RPC_BACKUP_URL equals TRACK_RPC_URL — failover disabled"
  );
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

function extractAlchemyKey(rpcUrl: string): string {
  const match = rpcUrl.match(/g\.alchemy\.com\/v2\/([^/?#]+)/i);
  return match?.[1] ?? "";
}

function maskRpc(url: string): string {
  return url.replace(/\/v2\/[^/?#]+/i, "/v2/***").replace(/\/[a-f0-9]{16,}/gi, "/***");
}

export const rpcLabels = {
  track: maskRpc(trackRpcUrl),
  trackBackup: trackBackupRpcUrl ? maskRpc(trackBackupRpcUrl) : "(none)",
  mint: maskRpc(mintRpcUrl),
  mintBackup: mintBackupRpcUrl ? maskRpc(mintBackupRpcUrl) : "(none)",
};

export const config = {
  telegramToken: env.TELEGRAM_BOT_TOKEN,
  allowedChatIds: new Set(splitCsv(env.TELEGRAM_ALLOWED_CHAT_IDS)),
  chain,
  /** @deprecated use trackRpcUrl — kept for older call sites */
  rpcUrl: trackRpcUrl,
  trackRpcUrl,
  trackBackupRpcUrl:
    trackBackupRpcUrl && trackBackupRpcUrl !== trackRpcUrl
      ? trackBackupRpcUrl
      : "",
  mintRpcUrl,
  mintBackupRpcUrl,
  alchemyApiKey:
    env.ALCHEMY_API_KEY.trim() ||
    extractAlchemyKey(trackRpcUrl) ||
    extractAlchemyKey(mintRpcUrl) ||
    extractAlchemyKey(trackBackupRpcUrl) ||
    "",
  alchemyAdminKey: env.ALCHEMY_ADMIN_KEY.trim(),
  chainstackApiKey: env.CHAINSTACK_API_KEY.trim(),
  chainstackMonthlyRuLimit:
    Number.isFinite(env.CHAINSTACK_MONTHLY_RU_LIMIT) &&
    env.CHAINSTACK_MONTHLY_RU_LIMIT > 0
      ? Math.floor(env.CHAINSTACK_MONTHLY_RU_LIMIT)
      : 3_000_000,
  rpcQuotaIntervalMs:
    Number.isFinite(env.RPC_QUOTA_INTERVAL_MS) &&
    env.RPC_QUOTA_INTERVAL_MS >= 60_000
      ? env.RPC_QUOTA_INTERVAL_MS
      : 6 * 60 * 60 * 1000,
  copyEnabled: env.COPY_ENABLED,
  dryRun: env.DRY_RUN,
  freeMintsOnly: env.FREE_MINTS_ONLY,
  privateKey: env.PRIVATE_KEY,
  privateKeys: splitCsv(env.PRIVATE_KEYS),
  maxBuyRobinhood,
  maxGasGwei: env.MAX_GAS_GWEI,
  maxMintGasLimit: env.MAX_MINT_GAS_LIMIT,
  maxMintQuantity:
    Number.isFinite(env.MAX_MINT_QUANTITY) && env.MAX_MINT_QUANTITY > 0
      ? Math.min(Math.floor(env.MAX_MINT_QUANTITY), 100)
      : 100,
  pollIntervalMs: numberOr(env.POLL_INTERVAL_MS, chain.defaultPollIntervalMs),
  lookbackBlocks: numberOr(env.LOOKBACK_BLOCKS, chain.defaultLookbackBlocks),
  allowedCollections: splitCsv(env.ALLOWED_COLLECTIONS).map((a) =>
    a.toLowerCase()
  ),
  openseaApiKey: env.OPENSEA_API_KEY.trim(),
  /** Persisted instant key from POST https://api.opensea.io/api/v2/auth/keys */
  openseaApiKeyPath: path.join(dataDir, "opensea-api-key.json"),
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
