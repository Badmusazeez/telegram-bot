import { id, Interface, isAddress, type Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import {
  getAllMintWallets,
  getMintProvider,
} from "./provider";
import { checkMintWalletReadiness, clearWalletReadinessCache } from "./walletReady";
import { withWalletNonce, invalidateWalletNonce, warmWalletNonce } from "./nonceManager";
import { classifyRpcError } from "./rpcHealth";
import { reportMintRpcIssue } from "./mintRpcAlerts";
import { parseOpenSeaUrl, normalizeOpenSeaInput } from "./openseaUrl";
import {
  ensureOpenSeaApiKey,
  getOpenSeaApiKey,
} from "./openseaAuth";
import { fetchOpenSeaJson } from "./openseaDrop";
import { recordMintSession } from "../store/botStats";
import {
  buildMintResultStats,
  classifyMintError,
  formatMintResultStats,
  type MintWalletOutcome,
} from "./mintResultReport";

/** Wrong Bird / NotBitcoin / cadence free mints: mintFree() */
export const MINT_FREE_SELECTOR = id("mintFree()").slice(0, 10); // 0x8ab53447

/** Not Bitcoin (nBTC Mining Rigs) — free lane every 3s, max 3/wallet. */
export const NBTC_RIGS = {
  aliases: [
    "nbtc",
    "notbitcoin",
    "not-bitcoin",
    "nbtc-mining-rigs",
    "nbtc-mining-rigs-517198745",
  ],
  contract: "0x296ad7946b9cb1f92697a97f7e93b51bedc8235b",
  slug: "nbtc-mining-rigs-517198745",
  name: "nBTC Mining Rigs",
  openSeaUrl:
    "https://opensea.io/collection/nbtc-mining-rigs-517198745",
  intervalSec: 3,
  maxPerWallet: 3,
} as const;

const ERC721 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

const FREE_MINT_IFACE = new Interface([
  "function freeOf(address owner) view returns (uint256)",
  "function freeCap() view returns (uint256)",
  "function lastFreeAt() view returns (uint256)",
  "function freeInterval() view returns (uint256)",
]);

export type CadenceSnipeOptions = {
  /** Seconds between winner slots (Wrong Bird ≈ 10, nBTC = 3). */
  intervalSec?: number;
  /** Max free mints per wallet (Wrong Bird ≈ 1, nBTC = 3). */
  maxPerWallet?: number;
  /**
   * Which mint keys to use:
   * - `all` (default)
   * - one `0x…` address
   * - several `0x…` addresses
   */
  walletFilter?: "all" | string | string[];
  /** Max slot rounds to attempt (default: remainingSlots * 3 + 5). */
  maxRounds?: number;
  /** Abort mid-snipe (e.g. /nbtc stop). */
  signal?: AbortSignal;
  onProgress?: (line: string) => void | Promise<void>;
};

export type CadenceSnipeWalletResult = {
  address: string;
  ok: boolean;
  txHash?: string;
  round?: number;
  gasLimit?: bigint;
  error?: string;
};

export type CadenceSnipeResult = {
  dryRun: boolean;
  success: boolean;
  slug: string;
  name: string;
  contract: string;
  openSeaUrl: string;
  calldata: string;
  intervalSec: number;
  reason: string;
  results: CadenceSnipeWalletResult[];
  statsText?: string;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/0x[0-9a-fA-F]{48,}/g, "0x…")
    .slice(0, 140);
}

async function readBalance(
  provider: ReturnType<typeof getMintProvider>,
  contract: string,
  wallet: string
): Promise<bigint> {
  try {
    const data = ERC721.encodeFunctionData("balanceOf", [wallet]);
    const ret = await provider.call({ to: contract, data });
    if (!ret || ret === "0x") return 0n;
    return ERC721.decodeFunctionResult("balanceOf", ret)[0] as bigint;
  } catch {
    return 0n;
  }
}

/** nBTC Rigs: freeOf(address). Falls back to balanceOf when missing. */
async function readFreeMinted(
  provider: ReturnType<typeof getMintProvider>,
  contract: string,
  wallet: string
): Promise<bigint> {
  try {
    const data = FREE_MINT_IFACE.encodeFunctionData("freeOf", [wallet]);
    const ret = await provider.call({ to: contract, data });
    if (!ret || ret === "0x") return await readBalance(provider, contract, wallet);
    return FREE_MINT_IFACE.decodeFunctionResult("freeOf", ret)[0] as bigint;
  } catch {
    return readBalance(provider, contract, wallet);
  }
}

async function readFreeCap(
  provider: ReturnType<typeof getMintProvider>,
  contract: string
): Promise<bigint | null> {
  try {
    const data = FREE_MINT_IFACE.encodeFunctionData("freeCap", []);
    const ret = await provider.call({ to: contract, data });
    if (!ret || ret === "0x") return null;
    return FREE_MINT_IFACE.decodeFunctionResult("freeCap", ret)[0] as bigint;
  } catch {
    return null;
  }
}

async function readLastFreeAt(
  provider: ReturnType<typeof getMintProvider>,
  contract: string
): Promise<number | null> {
  try {
    const data = FREE_MINT_IFACE.encodeFunctionData("lastFreeAt", []);
    const ret = await provider.call({ to: contract, data });
    if (!ret || ret === "0x") return null;
    const v = FREE_MINT_IFACE.decodeFunctionResult("lastFreeAt", ret)[0] as bigint;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function readFreeInterval(
  provider: ReturnType<typeof getMintProvider>,
  contract: string
): Promise<number | null> {
  try {
    const data = FREE_MINT_IFACE.encodeFunctionData("freeInterval", []);
    const ret = await provider.call({ to: contract, data });
    if (!ret || ret === "0x") return null;
    const v = FREE_MINT_IFACE.decodeFunctionResult(
      "freeInterval",
      ret
    )[0] as bigint;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export type ParsedSnipeArgs = {
  target: string;
  intervalSec: number;
  maxPerWallet: number;
  /** `all` or one/more mint-wallet addresses. */
  walletFilter: "all" | string[];
};

function isNbtcAlias(target: string): boolean {
  const t = target.trim().toLowerCase();
  if (NBTC_RIGS.aliases.includes(t as (typeof NBTC_RIGS.aliases)[number])) {
    return true;
  }
  if (t.includes("nbtc-mining-rigs")) return true;
  if (t.includes("notbitcoin.org")) return true;
  if (t === NBTC_RIGS.contract.toLowerCase()) return true;
  return false;
}

/**
 * Parse `/snipe <url|slug|0x|nbtc> [secs] [maxN] [all|0x… 0x…]`.
 *
 * Examples:
 *   /snipe nbtc
 *   /snipe nbtc all
 *   /snipe nbtc 0xWalletA 0xWalletB
 *   /snipe nbtc-mining-rigs-517198745 3 3 all
 *   /snipe wrong-bird 10
 */
export function parseSnipeCommandArgs(raw: string): ParsedSnipeArgs | null {
  const text = normalizeOpenSeaInput(raw.trim());
  if (!text) return null;

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let target = tokens[0]!;
  let intervalSec: number | undefined;
  let maxPerWallet: number | undefined;
  let walletFilter: "all" | string[] = "all";
  const wallets: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const maxMatch = tok.match(/^max[=:]?(\d+)$/i);
    if (maxMatch) {
      const n = Number(maxMatch[1]);
      if (!Number.isFinite(n) || n < 1 || n > 20) return null;
      maxPerWallet = Math.floor(n);
      continue;
    }
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (!Number.isFinite(n) || n < 1 || n > 3_600) return null;
      if (intervalSec == null) intervalSec = Math.floor(n);
      else if (maxPerWallet == null) maxPerWallet = Math.floor(n);
      else return null;
      continue;
    }
    if (/^\d+s$/i.test(tok)) {
      const n = Number(tok.slice(0, -1));
      if (!Number.isFinite(n) || n < 1 || n > 3_600) return null;
      intervalSec = Math.floor(n);
      continue;
    }
    if (/^all$/i.test(tok)) {
      walletFilter = "all";
      wallets.length = 0;
      continue;
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(tok)) {
      wallets.push(tok.toLowerCase());
      continue;
    }
    return null;
  }

  if (wallets.length > 0) {
    walletFilter = [...new Set(wallets)];
  }

  const normalized = normalizeOpenSeaInput(target);
  if (!normalized) return null;

  const nbtc = isNbtcAlias(normalized);
  if (nbtc) {
    target = NBTC_RIGS.contract;
    intervalSec = intervalSec ?? NBTC_RIGS.intervalSec;
    maxPerWallet = maxPerWallet ?? NBTC_RIGS.maxPerWallet;
  } else {
    intervalSec = intervalSec ?? 10;
    maxPerWallet = maxPerWallet ?? 1;
  }

  if (parseOpenSeaUrl(normalized) || nbtc) {
    return {
      target: nbtc ? NBTC_RIGS.contract : normalized,
      intervalSec,
      maxPerWallet,
      walletFilter,
    };
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    return {
      target: normalized.toLowerCase(),
      intervalSec,
      maxPerWallet,
      walletFilter,
    };
  }
  if (/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(normalized)) {
    return {
      target: normalized.toLowerCase(),
      intervalSec,
      maxPerWallet,
      walletFilter,
    };
  }
  return null;
}

/**
 * Parse `/nbtc` wallet args: all | 0x… | 1-based /listkeys indices.
 * Examples: `` | `all` | `0xA 0xB` | `1 3` | `1 0xB`
 */
export function parseNbtcWalletArgs(
  raw: string,
  mintAddresses: string[]
): { ok: true; filter: "all" | string[] } | { ok: false; error: string } {
  const text = raw.trim().toLowerCase();
  if (!text || text === "all") {
    return { ok: true, filter: "all" };
  }
  if (text === "help") {
    return { ok: false, error: "help" };
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  const picked: string[] = [];
  const ordered = mintAddresses.map((a) => a.toLowerCase());

  for (const tok of tokens) {
    if (tok === "all") {
      return { ok: true, filter: "all" };
    }
    if (/^0x[a-f0-9]{40}$/.test(tok)) {
      if (!ordered.includes(tok)) {
        return {
          ok: false,
          error: `${tok} is not one of your mint keys. /listkeys`,
        };
      }
      picked.push(tok);
      continue;
    }
    if (/^\d+$/.test(tok)) {
      const idx = Number(tok);
      if (!Number.isFinite(idx) || idx < 1 || idx > ordered.length) {
        return {
          ok: false,
          error: `Key #${tok} out of range (1–${ordered.length}). /listkeys`,
        };
      }
      picked.push(ordered[idx - 1]!);
      continue;
    }
    return {
      ok: false,
      error: "Usage:\n/nbtc\n/nbtc all\n/nbtc 1\n/nbtc 1 2 3\n/nbtc 0xA 0xB\n/nbtc help",
    };
  }

  if (picked.length === 0) {
    return { ok: true, filter: "all" };
  }
  return { ok: true, filter: [...new Set(picked)] };
}

function normalizeWalletFilter(
  filter: CadenceSnipeOptions["walletFilter"]
): "all" | string[] {
  if (!filter || filter === "all") return "all";
  if (Array.isArray(filter)) {
    const addrs = [
      ...new Set(
        filter
          .map((a) => a.toLowerCase())
          .filter((a) => /^0x[a-f0-9]{40}$/.test(a))
      ),
    ];
    return addrs.length ? addrs : "all";
  }
  const one = filter.toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(one) ? [one] : "all";
}

/** Active cadence snipe — /nbtc stop or /snipe stop aborts it. */
let activeSnipeAbort: AbortController | null = null;

export function isCadenceSnipeRunning(): boolean {
  return activeSnipeAbort != null && !activeSnipeAbort.signal.aborted;
}

/** Start a new snipe controller (aborts any previous one). */
export function beginCadenceSnipe(): AbortSignal {
  if (activeSnipeAbort) {
    try {
      activeSnipeAbort.abort();
    } catch {
      // ignore
    }
  }
  activeSnipeAbort = new AbortController();
  return activeSnipeAbort.signal;
}

/** Stop the running snipe. Returns true if one was running. */
export function stopCadenceSnipe(): boolean {
  if (!activeSnipeAbort || activeSnipeAbort.signal.aborted) {
    activeSnipeAbort = null;
    return false;
  }
  activeSnipeAbort.abort();
  activeSnipeAbort = null;
  return true;
}

function clearActiveSnipeIfCurrent(signal: AbortSignal): void {
  if (activeSnipeAbort && activeSnipeAbort.signal === signal) {
    activeSnipeAbort = null;
  }
}

export async function resolveSnipeTarget(raw: string): Promise<{
  slug: string;
  name: string;
  contract: string;
  openSeaUrl: string;
}> {
  const text = normalizeOpenSeaInput(raw);
  if (isNbtcAlias(text) || text.toLowerCase() === NBTC_RIGS.contract) {
    return {
      slug: NBTC_RIGS.slug,
      name: NBTC_RIGS.name,
      contract: NBTC_RIGS.contract,
      openSeaUrl: NBTC_RIGS.openSeaUrl,
    };
  }
  const link = parseOpenSeaUrl(text);

  if (link?.kind === "collection" && link.collectionSlug) {
    if (isNbtcAlias(link.collectionSlug)) {
      return {
        slug: NBTC_RIGS.slug,
        name: NBTC_RIGS.name,
        contract: NBTC_RIGS.contract,
        openSeaUrl: NBTC_RIGS.openSeaUrl,
      };
    }
    return resolveSlugToContract(link.collectionSlug);
  }
  if ((link?.kind === "contract" || link?.kind === "asset") && link.contract) {
    const slugInfo = await resolveContractMeta(link.contract, link.chain);
    return {
      slug: slugInfo.slug,
      name: slugInfo.name,
      contract: link.contract,
      openSeaUrl:
        link.url ||
        `https://opensea.io/assets/robinhood/${link.contract}`,
    };
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(text) && isAddress(text)) {
    const contract = text.toLowerCase();
    const slugInfo = await resolveContractMeta(contract, "robinhood");
    return {
      slug: slugInfo.slug,
      name: slugInfo.name,
      contract,
      openSeaUrl: `https://opensea.io/assets/robinhood/${contract}`,
    };
  }
  if (/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(text)) {
    return resolveSlugToContract(text.toLowerCase());
  }
  throw new Error(
    "Invalid snipe target. Examples:\n" +
      "/snipe https://opensea.io/collection/wrong-bird 10\n" +
      "/snipe wrong-bird 10\n" +
      "/snipe 0xeb00d52ef95ea6aef1a7dfdc16337053eeedf5e6 10"
  );
}

async function resolveSlugToContract(slug: string): Promise<{
  slug: string;
  name: string;
  contract: string;
  openSeaUrl: string;
}> {
  await ensureOpenSeaApiKey();
  if (!getOpenSeaApiKey()) {
    throw new Error("OpenSea API key missing — /openseakey refresh");
  }
  const data = (await fetchOpenSeaJson(
    `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`
  )) as {
    name?: string;
    collection?: string;
    opensea_url?: string;
    contracts?: Array<{ address?: string; chain?: string }>;
  };
  const contracts = data.contracts || [];
  const rh =
    contracts.find((c) => (c.chain || "").toLowerCase() === "robinhood") ||
    contracts[0];
  const contract = (rh?.address || "").toLowerCase();
  if (!contract || !isAddress(contract)) {
    throw new Error(`No contract found for OpenSea collection "${slug}"`);
  }
  return {
    slug: data.collection || slug,
    name: data.name || slug,
    contract,
    openSeaUrl: data.opensea_url || `https://opensea.io/collection/${slug}`,
  };
}

async function resolveContractMeta(
  contract: string,
  chain?: string
): Promise<{ slug: string; name: string }> {
  await ensureOpenSeaApiKey();
  const ch = chain || config.chain.openseaChain;
  try {
    const info = (await fetchOpenSeaJson(
      `https://api.opensea.io/api/v2/chain/${ch}/contract/${contract}`
    )) as { collection?: string; name?: string };
    return {
      slug: info.collection || contract.slice(0, 10),
      name: info.name || info.collection || contract.slice(0, 10),
    };
  } catch {
    return { slug: contract.slice(0, 10), name: contract.slice(0, 10) };
  }
}

async function fetchLastMintFreeSuccessSec(
  contract: string
): Promise<number | null> {
  try {
    const url =
      `https://robinhoodchain.blockscout.com/api?module=account&action=txlist` +
      `&address=${contract}&sort=desc&page=1&offset=50`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      result?: Array<{
        isError?: string;
        methodId?: string;
        timeStamp?: string;
        input?: string;
      }>;
    };
    const rows = Array.isArray(body.result) ? body.result : [];
    for (const t of rows) {
      const input = (t.input || t.methodId || "").toLowerCase();
      if (t.isError === "0" && input.startsWith(MINT_FREE_SELECTOR)) {
        const sec = Number(t.timeStamp);
        if (Number.isFinite(sec) && sec > 0) return sec;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function getChainTimeMs(
  provider: ReturnType<typeof getMintProvider>
): Promise<{ chainNowMs: number; skewMs: number }> {
  try {
    const block = await provider.getBlock("latest");
    if (block?.timestamp) {
      const chainNowMs = Number(block.timestamp) * 1000;
      const skewMs = chainNowMs - Date.now();
      return { chainNowMs, skewMs };
    }
  } catch {
    // fall through
  }
  return { chainNowMs: Date.now(), skewMs: 0 };
}

function localMsFromChain(chainMs: number, skewMs: number): number {
  return chainMs - skewMs;
}

async function mintFreeReady(
  provider: ReturnType<typeof getMintProvider>,
  contract: string,
  from: string
): Promise<boolean> {
  try {
    await provider.estimateGas({
      to: contract,
      data: MINT_FREE_SELECTOR,
      from,
      value: 0n,
    });
    return true;
  } catch {
    return false;
  }
}

type ArmedMint = {
  wallet: Wallet;
  gasLimit: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
};

/**
 * Wait until mintFree is open. Uses on-chain lastFreeAt + freeInterval synced
 * to block time, then tight-polls estimateGas in the last ~250ms.
 * `onArm` runs ~400ms before predicted open (or immediately if already open)
 * so gas/nonce warm-up does not eat the slot.
 */
async function waitForCadenceWindow(params: {
  provider: ReturnType<typeof getMintProvider>;
  contract: string;
  probeFrom: string;
  intervalSec: number;
  signal?: AbortSignal;
  onTick?: (line: string) => void | Promise<void>;
  onArm?: () => void | Promise<void>;
}): Promise<void> {
  const { provider, contract, probeFrom, intervalSec } = params;
  if (await mintFreeReady(provider, contract, probeFrom)) {
    if (params.onArm) {
      try {
        await params.onArm();
      } catch {
        // round loop checks armed.length
      }
    }
    return;
  }

  const { skewMs } = await getChainTimeMs(provider);
  let lastSec =
    (await readLastFreeAt(provider, contract)) ??
    (await fetchLastMintFreeSuccessSec(contract));
  const chainIvl = await readFreeInterval(provider, contract);
  const ivl = chainIvl ?? intervalSec;

  let openChainMs: number;
  if (lastSec != null) {
    openChainMs = (lastSec + ivl) * 1000;
    const nowChain = Date.now() + skewMs;
    while (openChainMs < nowChain - 500) {
      openChainMs += ivl * 1000;
    }
  } else {
    const step = ivl * 1000;
    const nowChain = Date.now() + skewMs;
    openChainMs = Math.ceil(nowChain / step) * step;
  }

  if (params.onTick) {
    const openLocalMs = localMsFromChain(openChainMs, skewMs);
    const inMs = Math.max(0, openLocalMs - Date.now());
    await params.onTick(
      `⏱ Next slot in ~${(inMs / 1000).toFixed(2)}s (ivl=${ivl}s, skew ${skewMs}ms)`
    );
  }

  // Coarse wait until ~400ms before predicted open (room to arm).
  for (;;) {
    if (params.signal?.aborted) throw new Error("aborted");
    const openLocalMs = localMsFromChain(openChainMs, skewMs);
    const left = openLocalMs - Date.now();
    if (left <= 400) break;
    if (left > 1_200) {
      const fresh = await readLastFreeAt(provider, contract);
      if (fresh != null && fresh !== lastSec) {
        lastSec = fresh;
        openChainMs = (fresh + ivl) * 1000;
        const nowChain = Date.now() + skewMs;
        while (openChainMs < nowChain - 500) openChainMs += ivl * 1000;
      }
      if (await mintFreeReady(provider, contract, probeFrom)) {
        if (params.onArm) {
          try {
            await params.onArm();
          } catch {
            // round loop checks armed.length
          }
        }
        return;
      }
    }
    const refreshedOpenLocal = localMsFromChain(openChainMs, skewMs);
    const wait = Math.min(
      Math.max(20, refreshedOpenLocal - Date.now() - 350),
      400
    );
    await sleep(wait, params.signal);
  }

  if (params.onArm) {
    try {
      await params.onArm();
    } catch {
      // round loop checks armed.length
    }
  }

  // Tight poll — return the moment the slot opens.
  const deadline = Date.now() + ivl * 1000 + 2_500;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error("aborted");
    if (await mintFreeReady(provider, contract, probeFrom)) return;
    await sleep(8, params.signal);
  }
}

/** Pre-arm gas + fees + nonces so the open-shot skips estimateGas. */
async function armMintFreeBurst(
  wallets: Wallet[],
  provider: ReturnType<typeof getMintProvider>
): Promise<ArmedMint[]> {
  const fee = await provider.getFeeData().catch(() => null);
  const gasLimit = 220_000n;
  const armed: ArmedMint[] = [];
  await Promise.all(
    wallets.map(async (wallet) => {
      try {
        await warmWalletNonce(wallet.address, provider);
      } catch {
        // still try
      }
      const row: ArmedMint = { wallet, gasLimit };
      if (fee?.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
        row.maxFeePerGas = (fee.maxFeePerGas * 130n) / 100n;
        row.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * 130n) / 100n;
      } else if (fee?.gasPrice != null) {
        row.gasPrice = (fee.gasPrice * 130n) / 100n;
      }
      armed.push(row);
    })
  );
  return armed;
}

async function fireArmedMintFree(
  arm: ArmedMint,
  contract: string
): Promise<
  | { ok: true; txHash: string; gasLimit: bigint }
  | { ok: false; error: string }
> {
  const provider = getMintProvider();
  const connected = arm.wallet.connect(provider);
  try {
    const sent = await withWalletNonce({
      address: arm.wallet.address,
      provider,
      fn: async (nonce) => {
        const tx: {
          to: string;
          data: string;
          value: bigint;
          gasLimit: bigint;
          nonce: number;
          chainId: number;
          maxFeePerGas?: bigint;
          maxPriorityFeePerGas?: bigint;
          gasPrice?: bigint;
        } = {
          to: contract,
          data: MINT_FREE_SELECTOR,
          value: 0n,
          gasLimit: arm.gasLimit,
          nonce,
          chainId: Number(config.chain.chainId),
        };
        if (arm.maxFeePerGas != null && arm.maxPriorityFeePerGas != null) {
          tx.maxFeePerGas = arm.maxFeePerGas;
          tx.maxPriorityFeePerGas = arm.maxPriorityFeePerGas;
        } else if (arm.gasPrice != null) {
          tx.gasPrice = arm.gasPrice;
        }
        return connected.sendTransaction(tx);
      },
    });
    // Broadcast only — do not await inclusion (slot races are speed games).
    return { ok: true, txHash: sent.hash, gasLimit: arm.gasLimit };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/nonce/i.test(msg)) invalidateWalletNonce(arm.wallet.address);
    if (classifyRpcError(err)) void reportMintRpcIssue(err);
    return { ok: false, error: shortErr(err) };
  }
}

/**
 * Snipe a fixed-cadence free mint (e.g. Wrong Bird: 1 winner / 10s, mintFree, 1/wallet).
 * Bursts all remaining wallets each window until every funded wallet has 1 NFT.
 */
export async function runCadenceSnipe(
  raw: string,
  options: CadenceSnipeOptions = {}
): Promise<CadenceSnipeResult> {
  const intervalSec = Math.max(1, Math.floor(options.intervalSec ?? 10));
  let maxPerWallet = Math.max(1, Math.floor(options.maxPerWallet ?? 1));
  const walletFilter = normalizeWalletFilter(options.walletFilter);
  const onProgress = options.onProgress;
  const signal = options.signal;
  clearWalletReadinessCache();

  try {
  const target = await resolveSnipeTarget(raw);
  const contract = target.contract;
  const provider = getMintProvider();
  const state = getState();

  // Prefer on-chain freeCap when present (nBTC = 3).
  const chainCap = await readFreeCap(provider, contract);
  if (chainCap != null && chainCap > 0n) {
    maxPerWallet = Math.min(maxPerWallet, Number(chainCap));
  }

  const allConfigured = getAllMintWallets();
  const emptyResult = (
    reason: string,
    results: CadenceSnipeWalletResult[] = []
  ): CadenceSnipeResult => ({
    dryRun: state.dryRun,
    success: false,
    slug: target.slug,
    name: target.name,
    contract,
    openSeaUrl: target.openSeaUrl,
    calldata: MINT_FREE_SELECTOR,
    intervalSec,
    reason,
    results,
  });

  if (allConfigured.length === 0) {
    return emptyResult(
      "No mint wallets configured. Use /addkey or PRIVATE_KEY(S)."
    );
  }

  let all = allConfigured;
  if (walletFilter !== "all") {
    const want = new Set(walletFilter);
    all = allConfigured.filter((w) => want.has(w.address.toLowerCase()));
    const missing = walletFilter.filter(
      (a) => !allConfigured.some((w) => w.address.toLowerCase() === a)
    );
    if (missing.length > 0) {
      return emptyResult(
        `Not your mint key(s): ${missing.map((a) => a.slice(0, 10) + "…").join(", ")}. /listkeys`
      );
    }
    if (all.length === 0) {
      return emptyResult("No matching mint keys. /listkeys");
    }
  }

  const readiness = await checkMintWalletReadiness(all);
  const funded = readiness.ready;
  if (funded.length === 0) {
    const stats = buildMintResultStats({
      configured: all.length,
      fundedReady: 0,
      empty: readiness.empty.length,
      lowGas: readiness.lowGas.length,
      outcomes: [],
    });
    return {
      ...emptyResult(
        `All ${all.length} mint wallet(s) empty/low-gas. Fund with RH gas.`
      ),
      statsText: formatMintResultStats(stats),
    };
  }

  // Track how many free mints each wallet still needs (cap = maxPerWallet).
  const mintedSoFar = new Map<string, number>();
  const stillNeed: Wallet[] = [];
  const alreadyFull: CadenceSnipeWalletResult[] = [];
  for (const w of funded) {
    const addr = w.address.toLowerCase();
    const have = Number(await readFreeMinted(provider, contract, addr));
    mintedSoFar.set(addr, have);
    if (have >= maxPerWallet) {
      alreadyFull.push({
        address: addr,
        ok: true,
        error: `already at free cap ${have}/${maxPerWallet} (skipped)`,
      });
    } else {
      stillNeed.push(w);
    }
  }

  const slotsLeft = stillNeed.reduce(
    (n, w) =>
      n + (maxPerWallet - (mintedSoFar.get(w.address.toLowerCase()) || 0)),
    0
  );

  if (onProgress) {
    await onProgress(
      `🎯 ${target.name} · mintFree() · 1 winner / ${intervalSec}s · ` +
        `max ${maxPerWallet}/wallet · ${stillNeed.length} wallet(s) · ` +
        `${slotsLeft} slot(s) left` +
        (walletFilter !== "all"
          ? ` · keys ${walletFilter.map((a) => a.slice(0, 8) + "…").join(",")}`
          : " · all keys")
    );
  }

  if (stillNeed.length === 0) {
    return {
      dryRun: state.dryRun,
      success: true,
      slug: target.slug,
      name: target.name,
      contract,
      openSeaUrl: target.openSeaUrl,
      calldata: MINT_FREE_SELECTOR,
      intervalSec,
      reason: `All ${funded.length} ready wallet(s) already at free cap (${maxPerWallet}/wallet).`,
      results: alreadyFull,
    };
  }

  if (state.dryRun) {
    const stats = buildMintResultStats({
      configured: all.length,
      fundedReady: funded.length,
      empty: readiness.empty.length,
      lowGas: readiness.lowGas.length,
      outcomes: stillNeed.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
        bucket: "success" as const,
      })),
    });
    return {
      dryRun: true,
      success: true,
      slug: target.slug,
      name: target.name,
      contract,
      openSeaUrl: target.openSeaUrl,
      calldata: MINT_FREE_SELECTOR,
      intervalSec,
      reason:
        `DRY RUN — would snipe mintFree() for ${slotsLeft} slot(s) across ` +
        `${stillNeed.length} wallet(s) (1 winner / ${intervalSec}s, max ${maxPerWallet}/wallet). ` +
        `/dryrun off to go live.\n\n` +
        formatMintResultStats(stats),
      results: stillNeed.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
      })),
      statsText: formatMintResultStats(stats),
    };
  }

  const maxRounds = options.maxRounds ?? slotsLeft * 3 + 8;
  const winsByWallet = new Map<string, CadenceSnipeWalletResult[]>();
  for (const a of alreadyFull) {
    winsByWallet.set(a.address, [a]);
  }
  let remaining = [...stillNeed];
  let round = 0;
  let totalWins = 0;
  let stopped = false;

  while (remaining.length > 0 && round < maxRounds) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    round += 1;
    if (onProgress) {
      const leftSlots = remaining.reduce(
        (n, w) =>
          n +
          (maxPerWallet - (mintedSoFar.get(w.address.toLowerCase()) || 0)),
        0
      );
      await onProgress(
        `⏳ Round ${round}/${maxRounds} · ${remaining.length} wallet(s) · ` +
          `${leftSlots} slot(s) · syncing to next ${intervalSec}s window…`
      );
    }

    // Snapshot freeOf before the window; arm in the last ~400ms of the wait.
    const beforeCounts = new Map<string, number>();
    for (const w of remaining) {
      beforeCounts.set(
        w.address.toLowerCase(),
        mintedSoFar.get(w.address.toLowerCase()) || 0
      );
    }
    let armed: ArmedMint[] = [];

    try {
      await waitForCadenceWindow({
        provider,
        contract,
        probeFrom: remaining[0]!.address,
        intervalSec,
        signal,
        onTick: onProgress,
        onArm: async () => {
          if (onProgress) {
            await onProgress(
              `🔧 Arming ${remaining.length} wallet(s) (gas/nonce)…`
            );
          }
          armed = await armMintFreeBurst(remaining, provider);
        },
      });
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && /aborted/i.test(err.message))
      ) {
        stopped = true;
        break;
      }
      throw err;
    }

    if (signal?.aborted) {
      stopped = true;
      break;
    }

    if (armed.length === 0) {
      if (onProgress) {
        await onProgress(`⚠️ No wallets armed — retrying next window`);
      }
      continue;
    }

    if (onProgress) {
      await onProgress(
        `🚀 SLOT OPEN — firing ${armed.length} wallet(s) in parallel (no stagger)`
      );
    }

    // Parallel fire — first broadcast wins the race; no per-wallet delay.
    const fireResults = await Promise.all(
      armed.map(async (arm) => {
        if (signal?.aborted) {
          return {
            address: arm.wallet.address.toLowerCase(),
            sent: {
              ok: false as const,
              error: "stopped",
            },
          };
        }
        const sent = await fireArmedMintFree(arm, contract);
        return { address: arm.wallet.address.toLowerCase(), sent };
      })
    );

    // Confirm on-chain freeOf — broadcast ≠ win (only 1 slot / interval).
    try {
      await sleep(Math.min(1_400, Math.max(600, intervalSec * 350)), signal);
    } catch {
      stopped = true;
      break;
    }

    const roundResults: CadenceSnipeWalletResult[] = [];
    for (const fr of fireResults) {
      const address = fr.address;
      const before = beforeCounts.get(address) || 0;
      let have = before;
      try {
        have = Number(await readFreeMinted(provider, contract, address));
      } catch {
        // keep before
      }
      if (have > before) {
        mintedSoFar.set(address, have);
        roundResults.push({
          address,
          ok: true,
          txHash: fr.sent.ok ? fr.sent.txHash : undefined,
          round,
          gasLimit: fr.sent.ok ? fr.sent.gasLimit : undefined,
        });
      } else {
        roundResults.push({
          address,
          ok: false,
          round,
          error: fr.sent.ok
            ? "broadcast ok but freeOf unchanged (lost race / reverted)"
            : fr.sent.error,
        });
      }
    }

    const winners = roundResults.filter((r) => r.ok);
    totalWins += winners.length;
    for (const w of winners) {
      const list = winsByWallet.get(w.address) || [];
      list.push(w);
      winsByWallet.set(w.address, list);
    }

    if (onProgress) {
      if (winners.length > 0) {
        await onProgress(
          `✅ Round ${round}: ${winners.length} win(s) — ${winners
            .map(
              (w) =>
                `${w.address.slice(0, 8)}… (${mintedSoFar.get(w.address)}/${maxPerWallet})`
            )
            .join(", ")}`
        );
      } else {
        const sample = roundResults
          .slice(0, 2)
          .map((r) => r.error || "?")
          .join("; ");
        await onProgress(
          `❌ Round ${round}: no freeOf bump (lost race) — ${sample} — next window`
        );
      }
    }

    remaining = remaining.filter((w) => {
      const addr = w.address.toLowerCase();
      return (mintedSoFar.get(addr) || 0) < maxPerWallet;
    });
    // No extra post-round sleep — waitForCadenceWindow syncs to next lastFreeAt.
  }

  if (stopped && onProgress) {
    await onProgress("⏹ Snipe stopped.");
  }

  const results: CadenceSnipeWalletResult[] = [];
  for (const w of funded) {
    const addr = w.address.toLowerCase();
    const have = mintedSoFar.get(addr) || 0;
    const wins = winsByWallet.get(addr) || [];
    if (
      have >= maxPerWallet ||
      wins.some((x) => x.ok && !x.error?.includes("skipped"))
    ) {
      const lastWin =
        [...wins].reverse().find((x) => x.ok && x.txHash) || wins[0];
      results.push({
        address: addr,
        ok: have > 0 || Boolean(lastWin?.ok),
        txHash: lastWin?.txHash,
        round: lastWin?.round,
        gasLimit:
          wins.reduce((s, x) => s + (x.gasLimit ?? 0n), 0n) || undefined,
        error:
          have >= maxPerWallet ? undefined : `partial ${have}/${maxPerWallet}`,
      });
    } else if (have > 0) {
      results.push({
        address: addr,
        ok: true,
        error: `partial ${have}/${maxPerWallet}`,
      });
    } else {
      results.push({
        address: addr,
        ok: false,
        error: `no win after ${round} round(s) (0/${maxPerWallet})`,
      });
    }
  }

  const outcomes: MintWalletOutcome[] = results.map((r) => ({
    address: r.address,
    ok: r.ok,
    txHash: r.ok ? r.txHash : undefined,
    error: r.ok ? undefined : r.error,
    bucket: r.ok ? "success" : classifyMintError(r.error),
  }));

  const stats = buildMintResultStats({
    configured: all.length,
    fundedReady: funded.length,
    empty: readiness.empty.length,
    lowGas: readiness.lowGas.length,
    outcomes,
  });
  const statsText = formatMintResultStats(stats);
  const walletsAtCap = [...mintedSoFar.values()].filter(
    (n) => n >= maxPerWallet
  ).length;
  const totalHave = [...mintedSoFar.values()].reduce((a, b) => a + b, 0);

  void recordMintSession({
    dryRun: false,
    success: totalWins > 0 || totalHave > 0,
    attempted: true,
    okWallets: walletsAtCap,
    failWallets: Math.max(0, funded.length - walletsAtCap),
    gasUsedEstimate: results.reduce((sum, r) => sum + (r.gasLimit ?? 0n), 0n),
  });

  return {
    dryRun: false,
    success: totalHave > 0,
    slug: target.slug,
    name: target.name,
    contract,
    openSeaUrl: target.openSeaUrl,
    calldata: MINT_FREE_SELECTOR,
    intervalSec,
    reason:
      (stopped
        ? `Snipe stopped: ${totalHave} free mint(s) so far across ${walletsAtCap}/${funded.length} wallet(s) (cap ${maxPerWallet}) after ${round} round(s)`
        : totalHave > 0
          ? `Snipe done: ${totalHave} free mint(s) across ${walletsAtCap}/${funded.length} wallet(s) at cap ${maxPerWallet} after ${round} round(s) (${intervalSec}s cadence)`
          : `Snipe failed: 0 winners after ${round} round(s)`) +
      `\n\n${statsText}`,
    results,
    statsText,
  };
  } finally {
    if (signal) clearActiveSnipeIfCurrent(signal);
  }
}
