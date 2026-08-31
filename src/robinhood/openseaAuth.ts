import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";

const INSTANT_KEY_URL = "https://api.opensea.io/api/v2/auth/keys";
/** Refresh when fewer than this many ms remain (1 day). */
const REFRESH_BEFORE_MS = 24 * 60 * 60 * 1000;

export type OpenSeaInstantKey = {
  api_key: string;
  name: string;
  expires_at: string;
  rate_limits?: {
    read?: string;
    write?: string;
    fulfillment?: string;
  };
  upgrade_url?: string;
  fetched_at?: string;
  source?: "env" | "instant";
};

type StoredKey = OpenSeaInstantKey;

let memory: StoredKey | null = null;
let inflight: Promise<string> | null = null;
/** Env / cached keys that returned 401 — never reuse this process. */
const bannedKeys = new Set<string>();

function keyPath(): string {
  return (
    config.openseaApiKeyPath ||
    path.join(config.projectRoot, "data", "opensea-api-key.json")
  );
}

function applyKey(key: string): string {
  config.openseaApiKey = key;
  return key;
}

function isUsable(stored: StoredKey | null, now = Date.now()): boolean {
  if (!stored?.api_key) return false;
  if (bannedKeys.has(stored.api_key)) return false;
  if (!stored.expires_at) return true;
  const exp = Date.parse(stored.expires_at);
  if (Number.isNaN(exp)) return true;
  return exp - now > REFRESH_BEFORE_MS;
}

async function readStored(): Promise<StoredKey | null> {
  try {
    const raw = await fs.readFile(keyPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredKey;
    if (!parsed?.api_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStored(stored: StoredKey): Promise<void> {
  const dir = path.dirname(keyPath());
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(keyPath(), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}

/** Mark a key invalid (401) so we stop using env/cached garbage. */
export function invalidateOpenSeaApiKey(reason = "invalid"): void {
  const key = (config.openseaApiKey || memory?.api_key || "").trim();
  if (key) {
    bannedKeys.add(key);
    console.warn(`[opensea] API key invalidated (${reason}): ${key.slice(0, 4)}…${key.slice(-4)}`);
  }
  memory = null;
  config.openseaApiKey = "";
}

/**
 * Create a free-tier OpenSea API key (7-day expiry):
 *   curl -X POST https://api.opensea.io/api/v2/auth/keys
 */
export async function createInstantOpenSeaApiKey(): Promise<OpenSeaInstantKey> {
  const res = await fetch(INSTANT_KEY_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const errors =
      json &&
      typeof json === "object" &&
      "errors" in json &&
      Array.isArray((json as { errors: unknown }).errors)
        ? (json as { errors: string[] }).errors.join("; ")
        : text.slice(0, 200);
    const retry = res.headers.get("retry-after");
    throw new Error(
      `OpenSea instant key HTTP ${res.status}: ${errors || res.statusText}` +
        (retry ? ` (retry-after ${retry}s)` : "")
    );
  }

  const body = json as Partial<OpenSeaInstantKey>;
  if (!body.api_key) {
    throw new Error("OpenSea instant key response missing api_key");
  }

  const stored: StoredKey = {
    api_key: body.api_key,
    name: body.name || "agent_instant",
    expires_at: body.expires_at || "",
    rate_limits: body.rate_limits,
    upgrade_url: body.upgrade_url,
    fetched_at: new Date().toISOString(),
    source: "instant",
  };
  memory = stored;
  await writeStored(stored);
  applyKey(stored.api_key);
  return stored;
}

export type OpenSeaKeyStatus = {
  present: boolean;
  source: "env" | "instant" | "none";
  name?: string;
  expiresAt?: string;
  maskedKey?: string;
};

export function getOpenSeaKeyStatus(): OpenSeaKeyStatus {
  const key = (config.openseaApiKey || memory?.api_key || "").trim();
  if (!key) {
    return { present: false, source: "none" };
  }
  const source =
    memory?.source ||
    (process.env.OPENSEA_API_KEY?.trim() === key ? "env" : "instant");
  return {
    present: true,
    source,
    name: memory?.name,
    expiresAt: memory?.expires_at || undefined,
    maskedKey: `${key.slice(0, 4)}…${key.slice(-4)}`,
  };
}

/**
 * Ensure a usable OpenSea API key is loaded into config.openseaApiKey.
 * Order: env (if not banned) → cached instant → POST /api/v2/auth/keys
 */
export async function ensureOpenSeaApiKey(options?: {
  forceRefresh?: boolean;
}): Promise<string> {
  if (inflight) return inflight;

  inflight = (async () => {
    const force = options?.forceRefresh === true;

    if (force) {
      invalidateOpenSeaApiKey("force-refresh");
    }

    // Explicit .env key wins (unless force-refresh / banned).
    const envKey = (process.env.OPENSEA_API_KEY || "").trim();
    if (envKey && !force && !bannedKeys.has(envKey)) {
      memory = {
        api_key: envKey,
        name: "env",
        expires_at: "",
        source: "env",
        fetched_at: new Date().toISOString(),
      };
      // Persist so restarts under pm2 keep the working key even if .env is missed.
      void writeStored(memory).catch(() => undefined);
      return applyKey(envKey);
    }

    if (!force) {
      if (memory && isUsable(memory)) {
        return applyKey(memory.api_key);
      }
      const stored = await readStored();
      if (stored && isUsable(stored)) {
        memory = stored;
        return applyKey(stored.api_key);
      }
    }

    try {
      const created = await createInstantOpenSeaApiKey();
      console.log(
        `[opensea] Instant API key created (${created.name}), expires ${created.expires_at || "unknown"}`
      );
      return created.api_key;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never fall back to a banned/invalid key.
      const fallback = (config.openseaApiKey || "").trim();
      if (fallback && !bannedKeys.has(fallback)) {
        console.warn(
          `[opensea] Instant key refresh failed (${msg}); using existing key`
        );
        return fallback;
      }
      throw err;
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Sync getter (may be empty before ensureOpenSeaApiKey). */
export function getOpenSeaApiKey(): string {
  const key = (config.openseaApiKey || "").trim();
  if (key && bannedKeys.has(key)) return "";
  return key;
}
