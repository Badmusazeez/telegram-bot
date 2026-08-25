import { config } from "../config";
import {
  ensureOpenSeaApiKey,
  getOpenSeaApiKey,
  invalidateOpenSeaApiKey,
} from "./openseaAuth";
import { parseOpenSeaUrl, type OpenSeaLinkRef } from "./openseaUrl";
import { getOpenSeaGate, parseTryAgainMs } from "./rpcGate";

export type OpenSeaDropStage = {
  uuid?: string;
  stage_type?: string;
  label?: string;
  price?: string;
  start_time?: string;
  end_time?: string;
  max_per_wallet?: string;
};

export type OpenSeaDrop = {
  collection_slug: string;
  collection_name?: string;
  chain: string;
  contract_address: string;
  is_minting?: boolean;
  opensea_url?: string;
  active_stage?: OpenSeaDropStage | null;
  next_stage?: OpenSeaDropStage | null;
  stages: OpenSeaDropStage[];
};

export type ResolvedOpenSeaSchedule = {
  slug: string;
  name: string;
  contract: string;
  chain: string;
  executeAt: Date;
  stageLabel: string;
  stageType: string;
  priceWei: string;
  isLive: boolean;
  openSeaUrl: string;
  /** All detected stages with times (for Telegram). */
  stagesSummary: string;
  /** Always sharp for OpenSea auto-schedule. */
  sharpMode: true;
  leadMs: number;
};

/** Shared drop cache — one fetch per slug during a mint window. */
const dropCache = new Map<string, { at: number; drop: OpenSeaDrop }>();
const DROP_CACHE_MS = 30_000;

let openSeaCooldownUntil = 0;

export function getOpenSeaCooldownRemainingMs(): number {
  return Math.max(0, openSeaCooldownUntil - Date.now());
}

export function clearOpenSeaDropCache(): void {
  dropCache.clear();
}

async function fetchOpenSeaJson(
  url: string,
  init?: RequestInit
): Promise<unknown> {
  const cool = getOpenSeaCooldownRemainingMs();
  if (cool > 0) {
    throw new Error(
      `OpenSea HTTP 429 cooldown — retry in ${cool}ms (Resource rate limit exceeded)`
    );
  }

  await ensureOpenSeaApiKey();
  const key = getOpenSeaApiKey();
  if (!key) {
    throw new Error(
      "OpenSea API key missing — set OPENSEA_API_KEY or let the bot auto-create via /api/v2/auth/keys"
    );
  }

  const gate = getOpenSeaGate();

  const doFetch = async (apiKey: string) =>
    gate.run(() =>
      fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
          ...(init?.headers || {}),
        },
      })
    );

  let res = await doFetch(key);
  if (res.status === 401 || res.status === 403) {
    invalidateOpenSeaApiKey(`HTTP ${res.status}`);
    try {
      await ensureOpenSeaApiKey({ forceRefresh: true });
    } catch (err) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `OpenSea HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}` +
          ` (key refresh failed: ${err instanceof Error ? err.message : String(err)})`
      );
    }
    const refreshed = getOpenSeaApiKey();
    if (!refreshed) {
      throw new Error(
        `OpenSea HTTP ${res.status}: no usable API key after refresh`
      );
    }
    res = await doFetch(refreshed);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const body = await res.text().catch(() => "");
    let waitMs = 2_000;
    if (retryAfter) {
      const sec = Number(retryAfter);
      if (Number.isFinite(sec) && sec > 0) waitMs = Math.min(sec * 1000, 30_000);
    }
    const fromBody = parseTryAgainMs(body);
    if (fromBody != null) waitMs = Math.max(waitMs, fromBody);
    openSeaCooldownUntil = Date.now() + waitMs;
    gate.noteRateLimit(new Error(`OpenSea 429 try_again_in ${waitMs}ms`));
    throw new Error(
      `OpenSea HTTP 429: Resource rate limit exceeded (cooldown ${waitMs}ms)`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      invalidateOpenSeaApiKey(`HTTP ${res.status} retry`);
    }
    throw new Error(
      `OpenSea HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`
    );
  }
  return res.json();
}

export async function resolveCollectionSlug(
  link: OpenSeaLinkRef
): Promise<string> {
  if (link.kind === "collection" && link.collectionSlug) {
    return link.collectionSlug;
  }
  if (!link.contract) {
    throw new Error("OpenSea link has no contract/collection slug.");
  }
  const chain = link.chain || config.chain.openseaChain;
  const info = (await fetchOpenSeaJson(
    `https://api.opensea.io/api/v2/chain/${chain}/contract/${link.contract}`
  )) as { collection?: string };
  if (!info.collection) {
    throw new Error(
      "Could not resolve OpenSea collection slug from that NFT link."
    );
  }
  return info.collection;
}

export async function fetchOpenSeaDrop(slug: string): Promise<OpenSeaDrop> {
  const key = slug.toLowerCase();
  const hit = dropCache.get(key);
  if (hit && Date.now() - hit.at < DROP_CACHE_MS) {
    return hit.drop;
  }
  let drop: OpenSeaDrop;
  try {
    drop = (await fetchOpenSeaJson(
      `https://api.opensea.io/api/v2/drops/${encodeURIComponent(slug)}`
    )) as OpenSeaDrop;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/opensea http 404|drop not found/i.test(msg)) {
      throw new Error(
        `OpenSea collection "${slug}" has no Drop mint page.\n` +
          `/claim and /mintslug only work for OpenSea Drop free stages.\n` +
          `For custom contract mints: /track a whale + /copy on, or /schedulemintfromtx <tx> <when>.`
      );
    }
    throw err;
  }
  if (!drop?.contract_address || !Array.isArray(drop.stages)) {
    throw new Error("OpenSea drop response missing contract/stages.");
  }
  dropCache.set(key, { at: Date.now(), drop });
  return drop;
}

function stagePriceWei(stage: OpenSeaDropStage | null | undefined): bigint {
  if (!stage?.price) {
    return 0n;
  }
  try {
    return BigInt(stage.price);
  } catch {
    return 0n;
  }
}

function stageName(stage: OpenSeaDropStage): string {
  return (stage.label || stage.stage_type || "stage").trim();
}

/** Public / general / open mint — prefer these over allowlist. */
export function isPublicOrGeneralStage(stage: OpenSeaDropStage): boolean {
  const t = `${stage.stage_type || ""} ${stage.label || ""}`.toLowerCase();
  if (
    /allow|whitelist|wl\b|guaranteed|holder|presale|private|token.?gate/.test(t)
  ) {
    return false;
  }
  return /public|general|open\b|everyone|fcfs|public.?sale|public.?mint/.test(
    t
  );
}

export function formatDropStagesSummary(
  drop: OpenSeaDrop,
  target?: OpenSeaDropStage
): string {
  const lines = drop.stages.map((s) => {
    const start = s.start_time ? new Date(s.start_time) : null;
    const when =
      start && !Number.isNaN(start.getTime())
        ? start.toISOString()
        : "no start_time";
    const free = stagePriceWei(s) === 0n ? "free" : "paid";
    const mark =
      target &&
      (target.uuid
        ? target.uuid === s.uuid
        : stageName(target) === stageName(s) &&
          target.start_time === s.start_time)
        ? " ← TARGET"
        : "";
    return `• ${stageName(s)} — ${when} (${free})${mark}`;
  });
  return lines.join("\n") || "• (no stages)";
}

/**
 * Prefer free public/general stage exact start times.
 * Falls back to other free stages if no public/general is listed.
 */
function pickStage(drop: OpenSeaDrop): {
  stage: OpenSeaDropStage;
  executeAt: Date;
  isLive: boolean;
} {
  const now = Date.now();

  const timed = drop.stages
    .map((s) => {
      const at = s.start_time ? new Date(s.start_time) : null;
      return {
        stage: s,
        at: at && !Number.isNaN(at.getTime()) ? at : null,
      };
    })
    .filter((x): x is { stage: OpenSeaDropStage; at: Date } => x.at != null);

  const futureFreePublic = timed
    .filter(
      (x) =>
        x.at.getTime() > now &&
        stagePriceWei(x.stage) === 0n &&
        isPublicOrGeneralStage(x.stage)
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const futureFreeAny = timed
    .filter((x) => x.at.getTime() > now && stagePriceWei(x.stage) === 0n)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  // Live public/general free → mint ASAP (still sharp burst).
  if (
    drop.is_minting &&
    drop.active_stage &&
    stagePriceWei(drop.active_stage) === 0n &&
    isPublicOrGeneralStage(drop.active_stage)
  ) {
    return {
      stage: drop.active_stage,
      executeAt: new Date(now + 1_500),
      isLive: true,
    };
  }

  // Prefer upcoming free public/general (even if allowlist is live now).
  if (futureFreePublic[0]) {
    return {
      stage: futureFreePublic[0].stage,
      executeAt: futureFreePublic[0].at,
      isLive: false,
    };
  }

  if (drop.next_stage?.start_time) {
    const at = new Date(drop.next_stage.start_time);
    if (
      !Number.isNaN(at.getTime()) &&
      at.getTime() > now &&
      stagePriceWei(drop.next_stage) === 0n &&
      isPublicOrGeneralStage(drop.next_stage)
    ) {
      return { stage: drop.next_stage, executeAt: at, isLive: false };
    }
  }

  // Live free allowlist — only if no future public free.
  if (
    drop.is_minting &&
    drop.active_stage &&
    stagePriceWei(drop.active_stage) === 0n
  ) {
    return {
      stage: drop.active_stage,
      executeAt: new Date(now + 1_500),
      isLive: true,
    };
  }

  if (futureFreeAny[0]) {
    return {
      stage: futureFreeAny[0].stage,
      executeAt: futureFreeAny[0].at,
      isLive: false,
    };
  }

  if (drop.next_stage?.start_time && stagePriceWei(drop.next_stage) === 0n) {
    const at = new Date(drop.next_stage.start_time);
    if (!Number.isNaN(at.getTime()) && at.getTime() > now) {
      return { stage: drop.next_stage, executeAt: at, isLive: false };
    }
  }

  throw new Error(
    "No upcoming free mint stage found on OpenSea for this link. It may already be over, paid-only, or not an OpenSea Drop."
  );
}

/** Resolve mint schedule purely from an OpenSea NFT/collection link. */
export async function resolveScheduleFromOpenSeaLink(
  rawUrl: string
): Promise<ResolvedOpenSeaSchedule> {
  const link = parseOpenSeaUrl(rawUrl);
  if (!link) {
    throw new Error("Invalid OpenSea link.");
  }
  if (
    (link.kind === "asset" || link.kind === "contract") &&
    link.chain &&
    link.chain !== "robinhood" &&
    link.chain !== config.chain.openseaChain
  ) {
    throw new Error(
      `That OpenSea link is chain "${link.chain}". This bot only supports ${config.chain.name}.`
    );
  }

  const slug = await resolveCollectionSlug(link);
  const drop = await fetchOpenSeaDrop(slug);

  if (
    drop.chain &&
    drop.chain !== "robinhood" &&
    drop.chain !== config.chain.openseaChain
  ) {
    throw new Error(
      `OpenSea drop is on "${drop.chain}". This bot only mints on ${config.chain.name}.`
    );
  }

  const picked = pickStage(drop);
  const priceWei = stagePriceWei(picked.stage).toString();

  if (stagePriceWei(picked.stage) > 0n) {
    throw new Error(
      `Next OpenSea stage "${picked.stage.label || picked.stage.stage_type}" is paid (${priceWei} wei). This bot only schedules free mints.`
    );
  }

  const leadMs = 15_000;
  return {
    slug: drop.collection_slug || slug,
    name: drop.collection_name || slug,
    contract: drop.contract_address.toLowerCase(),
    chain: drop.chain,
    executeAt: picked.executeAt,
    stageLabel: stageName(picked.stage),
    stageType: picked.stage.stage_type || "unknown",
    priceWei,
    isLive: picked.isLive,
    openSeaUrl: drop.opensea_url || link.url,
    stagesSummary: formatDropStagesSummary(drop, picked.stage),
    sharpMode: true,
    leadMs,
  };
}

export async function buildOpenSeaDropMintTx(params: {
  slug: string;
  minter: string;
  quantity?: number;
}): Promise<{ to: string; data: string; valueWei: bigint }> {
  const body = {
    minter: params.minter,
    quantity: params.quantity ?? 1,
  };
  const json = (await fetchOpenSeaJson(
    `https://api.opensea.io/api/v2/drops/${encodeURIComponent(params.slug)}/mint`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )) as {
    target?: string;
    to?: string;
    calldata?: string;
    data?: string;
    value?: string;
  };

  const to = (json.target || json.to || "").toLowerCase();
  const data = (json.calldata || json.data || "").toLowerCase();
  if (!to.startsWith("0x") || !data.startsWith("0x")) {
    throw new Error("OpenSea mint builder returned incomplete tx data.");
  }
  let valueWei = 0n;
  if (json.value) {
    valueWei = BigInt(json.value);
  }
  return { to, data, valueWei };
}
