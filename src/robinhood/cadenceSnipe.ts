import { id, Interface, isAddress, type Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import {
  getAllMintWallets,
  getMintBackupProvider,
  getMintProvider,
} from "./provider";
import { checkMintWalletReadiness, clearWalletReadinessCache } from "./walletReady";
import { mintSelectorLabel, resolveMintGasLimit } from "./mintGas";
import { withWalletNonce, invalidateWalletNonce } from "./nonceManager";
import {
  getMintRpcGate,
  isMissingRevertData,
  isRpcRateLimitError,
  mapPool,
  parseTryAgainMs,
} from "./rpcGate";
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
  /** `all` (default) or a specific mint-wallet address. */
  walletFilter?: "all" | string;
  /** Max slot rounds to attempt (default: remainingSlots * 3 + 5). */
  maxRounds?: number;
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
  walletFilter: "all" | string;
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
 * Parse `/snipe <url|slug|0x|nbtc> [secs] [maxN] [all|0xwallet]`.
 *
 * Examples:
 *   /snipe nbtc
 *   /snipe nbtc all
 *   /snipe nbtc 0xYourWallet
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
  let walletFilter: "all" | string = "all";

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
      continue;
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(tok)) {
      walletFilter = tok.toLowerCase();
      continue;
    }
    // Allow multi-word OpenSea URLs already normalized into token[0] only.
    return null;
  }

  // Re-join if first token looked like URL with no spaces (already one token).
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

/**
 * Wait until mintFree() estimateGas succeeds (slot open), or until
 * predicted cadence time, then fine-poll.
 */
async function waitForCadenceWindow(params: {
  provider: ReturnType<typeof getMintProvider>;
  contract: string;
  probeFrom: string;
  intervalSec: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { provider, contract, probeFrom, intervalSec } = params;
  if (await mintFreeReady(provider, contract, probeFrom)) {
    return;
  }

  // Prefer on-chain lastFreeAt (nBTC) over Blockscout tx scan.
  let lastSec =
    (await readLastFreeAt(provider, contract)) ??
    (await fetchLastMintFreeSuccessSec(contract));
  const chainIvl = await readFreeInterval(provider, contract);
  const ivl = chainIvl ?? intervalSec;

  let targetMs: number;
  if (lastSec != null) {
    targetMs = (lastSec + ivl) * 1000;
    while (targetMs < Date.now() - 1_000) {
      targetMs += ivl * 1000;
    }
  } else {
    const step = ivl * 1000;
    targetMs = Math.ceil(Date.now() / step) * step;
  }

  // Coarse wait until ~400ms before predicted open.
  for (;;) {
    if (params.signal?.aborted) throw new Error("aborted");
    const left = targetMs - Date.now();
    if (left <= 400) break;
    await sleep(Math.min(left - 350, 2_000), params.signal);
    if (await mintFreeReady(provider, contract, probeFrom)) return;
  }

  // Fine-poll estimateGas until open (or interval+2s timeout).
  const deadline = Date.now() + ivl * 1000 + 2_000;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error("aborted");
    if (await mintFreeReady(provider, contract, probeFrom)) return;
    await sleep(40, params.signal);
  }
}

async function sendMintFree(
  wallet: Wallet,
  contract: string
): Promise<
  | { ok: true; txHash: string; gasLimit: bigint }
  | { ok: false; error: string }
> {
  const gate = getMintRpcGate();
  const data = MINT_FREE_SELECTOR;
  const tryProvider = async (
    provider: ReturnType<typeof getMintProvider>,
    label: string
  ) => {
    const connected = wallet.connect(provider);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let estimated: bigint;
        try {
          estimated = await gate.run(() =>
            provider.estimateGas({
              from: wallet.address,
              to: contract,
              data,
              value: 0n,
            })
          );
        } catch (err) {
          // Pre-window / lost race — still try with safe gas so we don't miss the slot.
          const msg = err instanceof Error ? err.message : String(err);
          if (/revert|execution|too early|not open|cooldown/i.test(msg)) {
            estimated = 150_000n;
          } else {
            throw err;
          }
        }
        const resolved = resolveMintGasLimit({
          estimated,
          ceiling: config.maxMintGasLimit,
          marginPct: 25,
        });
        console.log(
          `[snipe:gas] mintFree via=${label} fn=${mintSelectorLabel(data)} ` +
            `estimate=${estimated} gasLimit=${resolved.ok ? resolved.gasLimit : 0}`
        );
        if (!resolved.ok) {
          return { ok: false as const, error: resolved.reason };
        }
        const sent = await gate.run(() =>
          withWalletNonce({
            address: wallet.address,
            provider,
            fn: async (nonce) =>
              connected.sendTransaction({
                to: contract,
                data,
                value: 0n,
                gasLimit: resolved.gasLimit,
                nonce,
                chainId: Number(config.chain.chainId),
              }),
          })
        );
        // Wait briefly for inclusion — only one winner per slot.
        try {
          const receipt = await Promise.race([
            sent.wait(),
            sleep(8_000).then(() => null),
          ]);
          if (receipt && receipt.status === 0) {
            return { ok: false as const, error: "tx reverted on-chain" };
          }
          if (receipt && receipt.status === 1) {
            return {
              ok: true as const,
              txHash: sent.hash,
              gasLimit: resolved.gasLimit,
            };
          }
        } catch {
          // pending — check balance below
        }
        const bal = await readBalance(provider, contract, wallet.address);
        if (bal > 0n) {
          return {
            ok: true as const,
            txHash: sent.hash,
            gasLimit: resolved.gasLimit,
          };
        }
        // Submitted but not winner / not confirmed yet.
        return {
          ok: false as const,
          error: `submitted ${sent.hash.slice(0, 12)}… (not confirmed winner)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nonce/i.test(msg)) invalidateWalletNonce(wallet.address);
        const waitMs = parseTryAgainMs(err);
        if (waitMs != null && attempt < 2) {
          await sleep(waitMs);
          continue;
        }
        if (isMissingRevertData(err) && attempt < 2) {
          await sleep(120);
          continue;
        }
        if (classifyRpcError(err)) void reportMintRpcIssue(err);
        return { ok: false as const, error: shortErr(err) };
      }
    }
    return { ok: false as const, error: "send failed" };
  };

  const primary = await tryProvider(getMintProvider(), "mint-primary");
  if (primary.ok) return primary;
  const backup = getMintBackupProvider();
  const err = primary.error || "";
  if (
    backup &&
    (isRpcRateLimitError(err) ||
      isMissingRevertData(err) ||
      /timeout|econn|502|503|504|unavailable|not confirmed/i.test(err))
  ) {
    return tryProvider(backup, "mint-backup");
  }
  return primary;
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
  const walletFilter = (options.walletFilter || "all").toLowerCase();
  const onProgress = options.onProgress;
  clearWalletReadinessCache();

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
    if (!/^0x[a-f0-9]{40}$/.test(walletFilter)) {
      return emptyResult(`Invalid wallet filter: ${walletFilter}`);
    }
    all = allConfigured.filter(
      (w) => w.address.toLowerCase() === walletFilter
    );
    if (all.length === 0) {
      return emptyResult(
        `Wallet ${walletFilter} is not one of your mint keys. /listkeys`
      );
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
          ? ` · only ${walletFilter.slice(0, 10)}…`
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

  while (remaining.length > 0 && round < maxRounds) {
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
          `${leftSlots} slot(s) · waiting for next ${intervalSec}s window…`
      );
    }

    await waitForCadenceWindow({
      provider,
      contract,
      probeFrom: remaining[0]!.address,
      intervalSec,
    });

    if (onProgress) {
      await onProgress(
        `🚀 WINDOW OPEN — bursting ${remaining.length} wallet(s) with mintFree()`
      );
    }

    const roundResults = await mapPool(remaining, 8, async (wallet, index) => {
      if (index > 0) await sleep(Math.min(index * 12, 200));
      const address = wallet.address.toLowerCase();
      const before = mintedSoFar.get(address) || 0;
      const sent = await sendMintFree(wallet, contract);
      if (sent.ok) {
        mintedSoFar.set(address, before + 1);
        return {
          address,
          ok: true as const,
          txHash: sent.txHash,
          round,
          gasLimit: sent.gasLimit,
        };
      }
      const have = Number(await readFreeMinted(provider, contract, address));
      if (have > before) {
        mintedSoFar.set(address, have);
        return { address, ok: true as const, round, txHash: undefined };
      }
      return {
        address,
        ok: false as const,
        round,
        error: sent.error,
      };
    });

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
        await onProgress(
          `❌ Round ${round}: no winner this slot (lost race / reverted) — retrying next window`
        );
      }
    }

    remaining = remaining.filter((w) => {
      const addr = w.address.toLowerCase();
      return (mintedSoFar.get(addr) || 0) < maxPerWallet;
    });

    if (remaining.length > 0) {
      await sleep(Math.min(1_500, intervalSec * 200));
    }
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
      (totalHave > 0
        ? `Snipe done: ${totalHave} free mint(s) across ${walletsAtCap}/${funded.length} wallet(s) at cap ${maxPerWallet} after ${round} round(s) (${intervalSec}s cadence)`
        : `Snipe failed: 0 winners after ${round} round(s)`) +
      `\n\n${statsText}`,
    results,
    statsText,
  };
}
