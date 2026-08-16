import { config } from "../config";
import { ensureOpenSeaApiKey, getOpenSeaApiKey } from "./openseaAuth";
import { parseOpenSeaUrl, type OpenSeaLinkRef } from "./openseaUrl";

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
};

async function fetchOpenSeaJson(url: string, init?: RequestInit): Promise<unknown> {
  await ensureOpenSeaApiKey();
  const key = getOpenSeaApiKey();
  if (!key) {
    throw new Error(
      "OpenSea API key missing — set OPENSEA_API_KEY or let the bot auto-create via /api/v2/auth/keys"
    );
  }

  const doFetch = async (apiKey: string) =>
    fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
        ...(init?.headers || {}),
      },
    });

  let res = await doFetch(key);
  if (res.status === 401 || res.status === 403) {
    await ensureOpenSeaApiKey({ forceRefresh: true });
    const refreshed = getOpenSeaApiKey();
    if (refreshed && refreshed !== key) {
      res = await doFetch(refreshed);
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSea HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
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
  const drop = (await fetchOpenSeaJson(
    `https://api.opensea.io/api/v2/drops/${encodeURIComponent(slug)}`
  )) as OpenSeaDrop;
  if (!drop?.contract_address || !Array.isArray(drop.stages)) {
    throw new Error("OpenSea drop response missing contract/stages.");
  }
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

function pickStage(drop: OpenSeaDrop): {
  stage: OpenSeaDropStage;
  executeAt: Date;
  isLive: boolean;
} {
  const now = Date.now();

  if (drop.is_minting && drop.active_stage?.start_time) {
    return {
      stage: drop.active_stage,
      executeAt: new Date(now + 3_000),
      isLive: true,
    };
  }

  if (drop.next_stage?.start_time) {
    const at = new Date(drop.next_stage.start_time);
    if (!Number.isNaN(at.getTime()) && at.getTime() > now) {
      return { stage: drop.next_stage, executeAt: at, isLive: false };
    }
  }

  const future = drop.stages
    .map((s) => ({ stage: s, at: s.start_time ? new Date(s.start_time) : null }))
    .filter((x) => x.at && !Number.isNaN(x.at.getTime()) && x.at.getTime() > now)
    .sort((a, b) => a.at!.getTime() - b.at!.getTime());

  // Prefer free public-looking stages first among future ones.
  const freePublic =
    future.find(
      (x) =>
        stagePriceWei(x.stage) === 0n &&
        /public/i.test(`${x.stage.stage_type || ""} ${x.stage.label || ""}`)
    ) || future.find((x) => stagePriceWei(x.stage) === 0n);

  const chosen = freePublic || future[0];
  if (!chosen?.at) {
    throw new Error(
      "No upcoming mint stage found on OpenSea for this link. It may already be over, or not an OpenSea Drop."
    );
  }
  return { stage: chosen.stage, executeAt: chosen.at, isLive: false };
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
    link.kind === "asset" &&
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

  return {
    slug: drop.collection_slug || slug,
    name: drop.collection_name || slug,
    contract: drop.contract_address.toLowerCase(),
    chain: drop.chain,
    executeAt: picked.executeAt,
    stageLabel: picked.stage.label || picked.stage.stage_type || "stage",
    stageType: picked.stage.stage_type || "unknown",
    priceWei,
    isLive: picked.isLive,
    openSeaUrl: drop.opensea_url || link.url,
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
