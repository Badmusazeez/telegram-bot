import "dotenv/config";
import { z } from "zod";
import { resolveChain, type ChainConfig } from "./chains";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(""),
  /** ethereum | robinhood */
  CHAIN: z.string().optional().default("ethereum"),
  ETH_RPC_URL: z.string().optional().default(""),
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
  PRIVATE_KEY: z.string().optional().default(""),
  MAX_BUY_ETH: z
    .string()
    .optional()
    .default("0.05")
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n) && n > 0, "MAX_BUY_ETH must be > 0"),
  MAX_GAS_GWEI: z
    .string()
    .optional()
    .default("40")
    .transform((v) => Number(v)),
  POLL_INTERVAL_MS: z.string().optional().default(""),
  LOOKBACK_BLOCKS: z.string().optional().default(""),
  ALLOWED_COLLECTIONS: z.string().optional().default(""),
  OPENSEA_API_KEY: z.string().optional().default(""),
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
const rpcUrl = env.ETH_RPC_URL.trim() || chain.defaultRpcUrl;

if (!rpcUrl.startsWith("http")) {
  throw new Error("ETH_RPC_URL must be a valid RPC URL");
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
  ethRpcUrl: rpcUrl,
  alchemyApiKey: env.ALCHEMY_API_KEY,
  copyEnabled: env.COPY_ENABLED,
  dryRun: env.DRY_RUN,
  privateKey: env.PRIVATE_KEY,
  maxBuyEth: env.MAX_BUY_ETH,
  maxGasGwei: env.MAX_GAS_GWEI,
  pollIntervalMs: numberOr(env.POLL_INTERVAL_MS, chain.defaultPollIntervalMs),
  lookbackBlocks: numberOr(env.LOOKBACK_BLOCKS, chain.defaultLookbackBlocks),
  allowedCollections: splitCsv(env.ALLOWED_COLLECTIONS).map((a) =>
    a.toLowerCase()
  ),
  openseaApiKey: env.OPENSEA_API_KEY,
  statePath: "data/state.json",
};
