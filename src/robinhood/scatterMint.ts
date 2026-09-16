import { config } from "../config";

/** Scatter protocol mint(auth, quantity, affiliate, signature) */
export const SCATTER_MINT_SELECTOR = "0x4a21a2df";

const SCATTER_API = "https://api.scatter.art/v1";

export type ScatterInviteList = {
  id: string;
  name?: string;
  token_price?: string;
  currency_address?: string;
  wallet_limit?: number;
  list_limit?: number;
  start_time?: string | null;
  end_time?: string | null;
};

export type ScatterMintTx = {
  to: string;
  data: string;
  valueWei: bigint;
  listId: string;
  listName: string;
  quantity: number;
};

export function isScatterMintCalldata(
  data: string | null | undefined
): boolean {
  return (data || "").toLowerCase().startsWith(SCATTER_MINT_SELECTOR);
}

/** Quantity is the 2nd ABI word for Scatter mint(...). */
export function decodeScatterMintQuantity(
  data: string
): number | undefined {
  const raw = data.toLowerCase();
  if (!raw.startsWith(SCATTER_MINT_SELECTOR) || raw.length < 10 + 64 * 2) {
    return undefined;
  }
  try {
    const word = raw.slice(10 + 64, 10 + 64 * 2);
    const q = Number(BigInt(`0x${word}`));
    if (Number.isFinite(q) && q >= 1 && q <= 100) return q;
  } catch {
    // ignore
  }
  return undefined;
}

function slugCandidates(
  contract: string,
  hintName?: string | null
): string[] {
  const out: string[] = [];
  const push = (s?: string | null) => {
    const v = (s || "").trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };
  if (hintName) {
    push(hintName);
    push(hintName.toLowerCase());
    push(
      hintName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    );
  }
  // OpenSea often uses name-number slugs; try bare lowered contract name later via API.
  void contract;
  return out.filter(Boolean);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Resolve Scatter collection slug for invite-list lookup. */
const slugCache = new Map<string, string>();

export async function resolveScatterSlug(params: {
  contract: string;
  hintName?: string | null;
  openSeaSlug?: string | null;
}): Promise<string | null> {
  const key = params.contract.toLowerCase();
  if (slugCache.has(key)) return slugCache.get(key)!;

  const tried = new Set<string>();
  const candidates = [
    ...slugCandidates(params.contract, params.hintName),
    ...(params.openSeaSlug ? [params.openSeaSlug] : []),
  ];

  const trySlug = async (slug: string): Promise<string | null> => {
    if (!slug || tried.has(slug.toLowerCase())) return null;
    tried.add(slug.toLowerCase());
    const lists = await fetchJson<ScatterInviteList[]>(
      `${SCATTER_API}/collection/${encodeURIComponent(slug)}/eligible-invite-lists`
    );
    if (Array.isArray(lists) && lists.length > 0) {
      slugCache.set(key, slug);
      return slug;
    }
    return null;
  };

  for (const slug of candidates) {
    const hit = await trySlug(slug);
    if (hit) return hit;
  }

  // OpenSea contract → collection slug (no key required on some endpoints).
  try {
    const os = await fetchJson<{ collection?: string; name?: string }>(
      `https://api.opensea.io/api/v2/chain/${config.chain.openseaChain}/contract/${params.contract.toLowerCase()}`
    );
    if (os?.collection) {
      const hit =
        (await trySlug(os.collection)) ||
        (await trySlug(os.collection.split("-")[0] || ""));
      if (hit) return hit;
    }
    if (os?.name) {
      const hit = await trySlug(
        os.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      );
      if (hit) return hit;
      const hit2 = await trySlug(os.name);
      if (hit2) return hit2;
    }
  } catch {
    // ignore
  }

  return null;
}

export function pickScatterFreeLists(
  lists: ScatterInviteList[],
  now = Date.now()
): ScatterInviteList[] {
  return lists.filter((l) => {
    const price = l.token_price ?? "0";
    if (price !== "0" && price !== "0.0" && Number(price) > 0) return false;
    if (l.start_time) {
      const t = Date.parse(l.start_time);
      if (Number.isFinite(t) && t > now + 2_000) return false;
    }
    if (l.end_time) {
      const t = Date.parse(l.end_time);
      if (Number.isFinite(t) && t < now) return false;
    }
    return true;
  });
}

/**
 * Build a Scatter free-mint tx for one wallet via Scatter API.
 * Prefers FREE / 0-price invite lists (public or eligible).
 */
export async function buildScatterFreeMintTx(params: {
  collectionAddress: string;
  minterAddress: string;
  quantity?: number;
  slugHint?: string | null;
  collectionName?: string | null;
  openSeaSlug?: string | null;
}): Promise<ScatterMintTx | null> {
  const chainId = Number(config.chain.chainId);
  const slug =
    params.slugHint ||
    (await resolveScatterSlug({
      contract: params.collectionAddress,
      hintName: params.collectionName,
      openSeaSlug: params.openSeaSlug,
    }));
  if (!slug) {
    console.warn(
      `[scatter] no slug for ${params.collectionAddress.slice(0, 12)}…`
    );
    return null;
  }

  const lists =
    (await fetchJson<ScatterInviteList[]>(
      `${SCATTER_API}/collection/${encodeURIComponent(slug)}/eligible-invite-lists?minterAddress=${params.minterAddress}`
    )) ||
    (await fetchJson<ScatterInviteList[]>(
      `${SCATTER_API}/collection/${encodeURIComponent(slug)}/eligible-invite-lists`
    ));

  if (!Array.isArray(lists) || lists.length === 0) {
    console.warn(`[scatter] no invite lists for slug=${slug}`);
    return null;
  }

  const free = pickScatterFreeLists(lists);
  if (free.length === 0) {
    console.warn(`[scatter] no FREE lists for slug=${slug} (all paid/WL-only)`);
    return null;
  }

  // Prefer explicitly named FREE, else first 0-price list.
  const list =
    free.find((l) => /free/i.test(l.name || "")) || free[0]!;
  const walletLimit = Math.max(1, Number(list.wallet_limit) || 1);
  const qty = Math.min(
    Math.max(1, params.quantity || 1),
    walletLimit,
    100
  );

  const body = {
    collectionAddress: params.collectionAddress.toLowerCase(),
    chainId,
    minterAddress: params.minterAddress,
    lists: [{ id: list.id, quantity: qty }],
  };

  const res = await fetchJson<{
    mintTransaction?: { to?: string; data?: string; value?: string };
    error?: unknown;
  }>(`${SCATTER_API}/mint`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const tx = res?.mintTransaction;
  if (!tx?.to || !tx.data || tx.data === "0x") {
    console.warn(
      `[scatter] mint API failed slug=${slug} list=${list.id}: ${JSON.stringify(res).slice(0, 200)}`
    );
    return null;
  }

  let valueWei = 0n;
  try {
    if (tx.value && tx.value !== "0") valueWei = BigInt(tx.value);
  } catch {
    valueWei = 0n;
  }
  if (valueWei > 0n) {
    console.warn(
      `[scatter] skip paid Scatter list ${list.name} value=${valueWei}`
    );
    return null;
  }

  return {
    to: tx.to.toLowerCase(),
    data: tx.data.toLowerCase(),
    valueWei: 0n,
    listId: list.id,
    listName: list.name || "FREE",
    quantity: qty,
  };
}
