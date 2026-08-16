import { config } from "../config";

const SCATTER_MINT_SELECTOR = "0x4a21a2df";
const slugCache = new Map<string, string>(); // contract -> scatter slug

export type ScatterInviteList = {
  id: string;
  name?: string;
  token_price?: string;
  wallet_limit?: number;
  list_limit?: number;
  unit_size?: number;
  start_time?: string | null;
  end_time?: string | null;
  address?: string;
  root?: string;
};

export type ScatterMintTx = {
  to: string;
  data: string;
  valueWei: bigint;
  quantity: number;
  listId: string;
  listName: string;
  slug: string;
};

export function isScatterMintCalldata(data: string | null | undefined): boolean {
  if (!data || data.length < 10) return false;
  return data.slice(0, 10).toLowerCase() === SCATTER_MINT_SELECTOR;
}

function isListActive(list: ScatterInviteList, now = Date.now()): boolean {
  if (list.start_time) {
    const start = Date.parse(list.start_time);
    if (!Number.isNaN(start) && start > now) return false;
  }
  if (list.end_time) {
    const end = Date.parse(list.end_time);
    if (!Number.isNaN(end) && end <= now) return false;
  }
  return true;
}

function isFreeList(list: ScatterInviteList): boolean {
  const price = String(list.token_price ?? "0").trim();
  const n = Number(price);
  return Number.isFinite(n) && n === 0;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg =
      typeof json === "object" && json && "message" in json
        ? String((json as { message: unknown }).message)
        : text.slice(0, 200);
    throw new Error(`Scatter HTTP ${res.status}: ${msg || res.statusText}`);
  }
  return json;
}

function extractScatterSlugFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/scatter\.art\/c\/([a-z0-9-]+)/i);
  return m?.[1]?.toLowerCase() || null;
}

/** Expand one slug into common Scatter URL variants (Cash Apes → cash-ape). */
export function expandSlugVariants(raw: string): string[] {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?scatter\.art\/c\//i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!base) return [];

  const out: string[] = [];
  const add = (s?: string | null) => {
    if (!s) return;
    const v = s.replace(/^-|-$/g, "");
    if (v && !out.includes(v)) out.push(v);
  };

  add(base);
  add(base.replace(/-/g, ""));
  if (base.endsWith("-s")) add(base.slice(0, -2));
  if (base.endsWith("s") && base.length > 3) add(base.slice(0, -1));
  if (base.endsWith("es") && base.length > 4) add(base.slice(0, -2));
  if (base.endsWith("ies") && base.length > 5) add(`${base.slice(0, -3)}y`);
  // Pluralize simple singular forms too (ape → apes)
  if (!base.endsWith("s")) {
    add(`${base}s`);
    add(`${base}es`);
  }
  return out;
}

async function openSeaCollectionHints(contract: string): Promise<{
  slug?: string | null;
  name?: string | null;
  scatterSlug?: string | null;
}> {
  try {
    const chain = config.chain.openseaChain;
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.openseaApiKey) {
      headers["x-api-key"] = config.openseaApiKey;
    }
    const res = await fetch(
      `https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`,
      { headers }
    );
    if (!res.ok) return {};
    const data = (await res.json()) as {
      collection?: string;
      name?: string;
    };
    const slug = data.collection || null;
    let scatterSlug: string | null = null;
    let name = data.name || null;

    if (slug && config.openseaApiKey) {
      try {
        const colRes = await fetch(
          `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
          { headers }
        );
        if (colRes.ok) {
          const col = (await colRes.json()) as {
            name?: string;
            project_url?: string;
            discord_url?: string;
            telegram_url?: string;
            wiki_url?: string;
            instagram_username?: string;
            description?: string;
          };
          name = col.name || name;
          const blob = [
            col.project_url,
            col.discord_url,
            col.telegram_url,
            col.wiki_url,
            col.description,
          ]
            .filter(Boolean)
            .join("\n");
          scatterSlug = extractScatterSlugFromText(blob);
        }
      } catch {
        // ignore collection detail failures
      }
    }

    return { slug, name, scatterSlug };
  } catch {
    return {};
  }
}

function slugCandidates(
  contract: string,
  hints: {
    openSeaSlug?: string | null;
    collectionName?: string | null;
    scatterSlug?: string | null;
  }
): string[] {
  const out: string[] = [];
  const addAll = (s?: string | null) => {
    for (const v of expandSlugVariants(s || "")) add(v);
  };
  const add = (s?: string | null) => {
    if (!s) return;
    const v = s.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };

  add(slugCache.get(contract.toLowerCase()));
  add(hints.scatterSlug);
  addAll(hints.scatterSlug);
  addAll(hints.openSeaSlug);
  addAll(hints.collectionName);
  return out;
}

async function slugMatchesContract(
  slug: string,
  contract: string
): Promise<boolean> {
  const key = contract.toLowerCase();
  try {
    const data = (await fetchJson(
      `https://api.scatter.art/v1/collection/${encodeURIComponent(slug)}`
    )) as { address?: string };
    if (data?.address && data.address.toLowerCase() === key) {
      return true;
    }
  } catch {
    return false;
  }

  try {
    const lists = await fetchEligibleLists(slug);
    if (lists.some((l) => l.address?.toLowerCase() === key)) {
      return true;
    }
    // Some collections omit address on list rows; accept if collection fetch matched earlier.
  } catch {
    return false;
  }
  return false;
}

export async function resolveScatterSlug(
  contract: string,
  collectionName?: string
): Promise<string | null> {
  const key = contract.toLowerCase();
  const cached = slugCache.get(key);
  if (cached) return cached;

  const openSea = await openSeaCollectionHints(contract);
  const candidates = slugCandidates(contract, {
    openSeaSlug: openSea.slug,
    collectionName: collectionName || openSea.name,
    scatterSlug: openSea.scatterSlug,
  });

  for (const slug of candidates) {
    if (await slugMatchesContract(slug, key)) {
      slugCache.set(key, slug);
      return slug;
    }
  }
  return null;
}

export async function fetchEligibleLists(
  slug: string,
  minterAddress?: string
): Promise<ScatterInviteList[]> {
  const q = minterAddress
    ? `?minterAddress=${encodeURIComponent(minterAddress)}`
    : "";
  const data = await fetchJson(
    `https://api.scatter.art/v1/collection/${encodeURIComponent(slug)}/eligible-invite-lists${q}`
  );
  return Array.isArray(data) ? (data as ScatterInviteList[]) : [];
}

/** Prefer free public list; mint max wallet_limit (Scatter "max as usual"). */
export function pickBestFreeList(
  lists: ScatterInviteList[]
): { list: ScatterInviteList; quantity: number } | null {
  const free = lists
    .filter((l) => isFreeList(l) && isListActive(l))
    .sort((a, b) => (b.wallet_limit || 1) - (a.wallet_limit || 1));

  const list = free[0];
  if (!list) return null;

  const walletLimit = Math.max(1, Number(list.wallet_limit) || 1);
  // Cap absurd limits to keep gas sane while still minting "max"
  const quantity = Math.min(walletLimit, 50);
  return { list, quantity };
}

export async function buildScatterMintTx(params: {
  collectionAddress: string;
  minterAddress: string;
  listId: string;
  quantity: number;
}): Promise<{ to: string; data: string; valueWei: bigint }> {
  const chainId = Number(config.chain.chainId);
  const json = (await fetchJson("https://api.scatter.art/v1/mint", {
    method: "POST",
    body: JSON.stringify({
      collectionAddress: params.collectionAddress,
      chainId,
      minterAddress: params.minterAddress,
      lists: [{ id: params.listId, quantity: params.quantity }],
    }),
  })) as {
    mintTransaction?: { to?: string; data?: string; value?: string };
    error?: string | { message?: string };
  };

  if (typeof json === "string") {
    throw new Error(json);
  }
  if (json.error) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : json.error.message || "Scatter mint error"
    );
  }

  const tx = json.mintTransaction;
  if (!tx?.to || !tx.data) {
    throw new Error("Scatter mint API returned no transaction");
  }
  return {
    to: tx.to,
    data: tx.data,
    valueWei: BigInt(tx.value || "0"),
  };
}

export async function prepareScatterFreeMint(params: {
  collectionAddress: string;
  minterAddress: string;
  collectionName?: string;
}): Promise<ScatterMintTx> {
  const slug = await resolveScatterSlug(
    params.collectionAddress,
    params.collectionName
  );
  if (!slug) {
    throw new Error(
      "Could not resolve Scatter collection slug for this contract"
    );
  }

  const lists = await fetchEligibleLists(slug, params.minterAddress);
  const picked = pickBestFreeList(lists);
  if (!picked) {
    throw new Error("No active free Scatter mint list for this wallet");
  }

  const built = await buildScatterMintTx({
    collectionAddress: params.collectionAddress,
    minterAddress: params.minterAddress,
    listId: picked.list.id,
    quantity: picked.quantity,
  });

  if (built.valueWei > 0n) {
    throw new Error(
      `Scatter list is paid (${built.valueWei} wei) — free-mint only`
    );
  }

  return {
    ...built,
    quantity: picked.quantity,
    listId: picked.list.id,
    listName: picked.list.name || picked.list.id,
    slug,
  };
}

/** Remember a known Scatter slug (e.g. from a pasted URL). */
export function rememberScatterSlug(contract: string, slug: string): void {
  const s = expandSlugVariants(slug)[0];
  if (s) slugCache.set(contract.toLowerCase(), s);
}
