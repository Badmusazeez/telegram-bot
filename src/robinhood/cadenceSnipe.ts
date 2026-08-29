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

/** Wrong Bird / cadence free mints: mintFree() */
export const MINT_FREE_SELECTOR = id("mintFree()").slice(0, 10); // 0x8ab53447

const ERC721 = new Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

export type CadenceSnipeOptions = {
  /** Seconds between winner slots (Wrong Bird ≈ 10). */
  intervalSec?: number;
  /** Max slot rounds to attempt (default: readyWallets * 3 + 5). */
  maxRounds?: number;
  onProgress?: (line: string) => void | Promise<void>;
};

export type CadenceSnipeWalletResult = {
  address: string;
  ok: boolean;
  txHash?: string;
  round?: number;
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

/** Parse `/snipe <url|slug|0x> [intervalSec]`. */
export function parseSnipeCommandArgs(raw: string): {
  target: string;
  intervalSec: number;
} | null {
  const text = normalizeOpenSeaInput(raw.trim());
  if (!text) return null;
  const withInterval = text.match(/^(.*?)\s+(\d+)\s*s?$/i);
  let target = text;
  let intervalSec = 10;
  if (withInterval) {
    target = withInterval[1].trim();
    const n = Number(withInterval[2]);
    if (!Number.isFinite(n) || n < 1 || n > 3_600) return null;
    intervalSec = Math.floor(n);
  }
  const normalized = normalizeOpenSeaInput(target);
  if (!normalized) return null;
  if (parseOpenSeaUrl(normalized)) return { target: normalized, intervalSec };
  if (/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    return { target: normalized.toLowerCase(), intervalSec };
  }
  if (/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(normalized)) {
    return { target: normalized.toLowerCase(), intervalSec };
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
  const link = parseOpenSeaUrl(text);

  if (link?.kind === "collection" && link.collectionSlug) {
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
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
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

  const lastSec = await fetchLastMintFreeSuccessSec(contract);
  let targetMs: number;
  if (lastSec != null) {
    targetMs = (lastSec + intervalSec) * 1000;
    while (targetMs < Date.now() - 1_000) {
      targetMs += intervalSec * 1000;
    }
  } else {
    const step = intervalSec * 1000;
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
  const deadline = Date.now() + intervalSec * 1000 + 2_000;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error("aborted");
    if (await mintFreeReady(provider, contract, probeFrom)) return;
    await sleep(40, params.signal);
  }
}

async function sendMintFree(
  wallet: Wallet,
  contract: string
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
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
            return { ok: true as const, txHash: sent.hash };
          }
        } catch {
          // pending — check balance below
        }
        const bal = await readBalance(provider, contract, wallet.address);
        if (bal > 0n) {
          return { ok: true as const, txHash: sent.hash };
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
  const onProgress = options.onProgress;
  clearWalletReadinessCache();

  const target = await resolveSnipeTarget(raw);
  const contract = target.contract;
  const provider = getMintProvider();
  const state = getState();

  const all = getAllMintWallets();
  const emptyResult = (reason: string, results: CadenceSnipeWalletResult[] = []): CadenceSnipeResult => ({
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

  if (all.length === 0) {
    return emptyResult("No mint wallets configured. Use /addkey or PRIVATE_KEY(S).");
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

  // Drop wallets that already hold this NFT.
  const stillNeed: Wallet[] = [];
  const already: CadenceSnipeWalletResult[] = [];
  for (const w of funded) {
    const bal = await readBalance(provider, contract, w.address);
    if (bal > 0n) {
      already.push({
        address: w.address.toLowerCase(),
        ok: true,
        error: "already holds NFT (skipped)",
      });
    } else {
      stillNeed.push(w);
    }
  }

  if (onProgress) {
    await onProgress(
      `🎯 ${target.name} · mintFree() · 1 winner / ${intervalSec}s · ` +
        `${stillNeed.length} wallets to fill (${already.length} already hold)`
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
      reason: `All ${funded.length} ready wallet(s) already hold this NFT.`,
      results: already,
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
        `DRY RUN — would snipe mintFree() on ${stillNeed.length} wallet(s) ` +
        `(1 winner / ${intervalSec}s, keep trying until each has 1). /dryrun off to go live.\n\n` +
        formatMintResultStats(stats),
      results: stillNeed.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
      })),
      statsText: formatMintResultStats(stats),
    };
  }

  const maxRounds = options.maxRounds ?? stillNeed.length * 3 + 5;
  const won = new Map<string, CadenceSnipeWalletResult>();
  for (const a of already) {
    if (a.ok) won.set(a.address, { ...a, error: undefined });
  }
  let remaining = [...stillNeed];
  let round = 0;

  while (remaining.length > 0 && round < maxRounds) {
    round += 1;
    if (onProgress) {
      await onProgress(
        `⏳ Round ${round}/${maxRounds} · ${remaining.length} wallet(s) left · waiting for next ${intervalSec}s window…`
      );
    }

    await waitForCadenceWindow({
      provider,
      contract,
      probeFrom: remaining[0].address,
      intervalSec,
    });

    if (onProgress) {
      await onProgress(
        `🚀 WINDOW OPEN — bursting ${remaining.length} wallet(s) with mintFree()`
      );
    }

    // Burst remaining wallets (staggered slightly to avoid identical nonces/RPC spikes).
    const roundResults = await mapPool(remaining, 8, async (wallet, index) => {
      if (index > 0) await sleep(Math.min(index * 12, 200));
      const address = wallet.address.toLowerCase();
      const sent = await sendMintFree(wallet, contract);
      if (sent.ok) {
        return {
          address,
          ok: true as const,
          txHash: sent.txHash,
          round,
        };
      }
      // Re-check balance in case we raced and still won.
      const bal = await readBalance(provider, contract, address);
      if (bal > 0n) {
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
    for (const w of winners) {
      won.set(w.address, w);
    }

    if (onProgress) {
      if (winners.length > 0) {
        await onProgress(
          `✅ Round ${round}: ${winners.length} winner(s) — ${winners
            .map((w) => w.address.slice(0, 8) + "…")
            .join(", ")}`
        );
      } else {
        await onProgress(
          `❌ Round ${round}: no winner this slot (lost race / reverted) — retrying next window`
        );
      }
    }

    remaining = remaining.filter((w) => !won.has(w.address.toLowerCase()));

    // Brief pause so next slot can open (avoid hammering mid-window).
    if (remaining.length > 0) {
      await sleep(Math.min(1_500, intervalSec * 200));
    }
  }

  const results: CadenceSnipeWalletResult[] = [
    ...won.values(),
    ...remaining.map((w) => ({
      address: w.address.toLowerCase(),
      ok: false,
      error: `no win after ${round} round(s)`,
    })),
  ];

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
  const uniqueOk = new Set(
    results.filter((r) => r.ok).map((r) => r.address)
  ).size;

  void recordMintSession({
    dryRun: false,
    success: uniqueOk > 0,
    attempted: true,
    okWallets: uniqueOk,
    failWallets: Math.max(0, funded.length - uniqueOk),
  });

  return {
    dryRun: false,
    success: uniqueOk > 0,
    slug: target.slug,
    name: target.name,
    contract,
    openSeaUrl: target.openSeaUrl,
    calldata: MINT_FREE_SELECTOR,
    intervalSec,
    reason:
      (uniqueOk > 0
        ? `Snipe done: ${uniqueOk}/${funded.length} ready wallet(s) hold NFT after ${round} round(s) (${all.length} configured, mintFree, ${intervalSec}s cadence)`
        : `Snipe failed: 0 winners after ${round} round(s)`) + `\n\n${statsText}`,
    results,
    statsText,
  };
}
