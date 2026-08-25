import type { Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import {
  buildOpenSeaDropMintTx,
  fetchOpenSeaDrop,
  getOpenSeaCooldownRemainingMs,
  resolveCollectionSlug,
  type OpenSeaDropStage,
} from "./openseaDrop";
import { parseOpenSeaUrl, normalizeOpenSeaInput } from "./openseaUrl";
import { openSeaStageMaxPerWallet } from "./multiMint";
import { maxMintQuantityLadder } from "./mintQuantity";
import { ensureOpenSeaApiKey, getOpenSeaApiKey } from "./openseaAuth";
import {
  getAllMintWallets,
  getMintBackupProvider,
  getMintProvider,
} from "./provider";
import { reportMintRpcIssue } from "./mintRpcAlerts";
import { classifyRpcError } from "./rpcHealth";
import { mintSelectorLabel, resolveMintGasLimit } from "./mintGas";
import { checkMintWalletReadiness, clearWalletReadinessCache } from "./walletReady";
import {
  getMintRpcGate,
  isMissingRevertData,
  isRpcRateLimitError,
  mapPool,
  parseTryAgainMs,
} from "./rpcGate";
import { withWalletNonce, invalidateWalletNonce } from "./nonceManager";
import {
  buildMintResultStats,
  classifyMintError,
  formatMintResultStats,
  type MintWalletOutcome,
} from "./mintResultReport";

export type SlugMintWalletResult = {
  address: string;
  ok: boolean;
  txHash?: string;
  quantity?: number;
  error?: string;
};

export type SlugMintResult = {
  dryRun: boolean;
  success: boolean;
  slug: string;
  name: string;
  contract: string;
  stageLabel: string;
  quantityTarget: number;
  openSeaUrl: string;
  reason: string;
  results: SlugMintWalletResult[];
  /** Structured counts for Telegram. */
  statsText?: string;
  /** claim = 1/wallet sequential; max = stage max blast */
  mode?: "max" | "claim";
  /** Seconds between wallets when sequential (0 = parallel). */
  intervalSec?: number;
};

export type SlugMintOptions = {
  /** max = stage max_per_wallet (default); claim = exactly 1 free NFT per wallet */
  mode?: "max" | "claim";
  /**
   * Seconds to wait between wallets (sequential).
   * Omit or 0 = parallel rate-aware blast (mintslug default).
   * Claim default in Telegram is 10.
   */
  intervalSec?: number;
  /** Optional progress lines (Telegram). */
  onProgress?: (line: string) => void | Promise<void>;
};

/** Parse `/mintslug|/claim <url|slug|0xContract> [intervalSec]`. */
export function parseSlugMintCommandArgs(raw: string): {
  target: string;
  intervalSec?: number;
} | null {
  const text = normalizeOpenSeaInput(raw.trim());
  if (!text) return null;

  // Trailing interval: "... 10" or "... 10s"
  const withInterval = text.match(/^(.*?)\s+(\d+)\s*s?$/i);
  if (withInterval) {
    const targetRaw = withInterval[1].trim();
    const intervalSec = Number(withInterval[2]);
    const resolved = resolveSlugInput(targetRaw);
    if (
      resolved &&
      Number.isFinite(intervalSec) &&
      intervalSec >= 0 &&
      intervalSec <= 3_600
    ) {
      return { target: resolved.value, intervalSec };
    }
  }

  const resolved = resolveSlugInput(text);
  if (resolved) return { target: resolved.value };
  return null;
}

function stagePriceWei(stage: OpenSeaDropStage | null | undefined): bigint {
  if (!stage?.price) return 0n;
  try {
    return BigInt(stage.price);
  } catch {
    return 0n;
  }
}

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("nonce has already been used") || lower.includes("already known")) {
    return "nonce already used (tx likely already broadcast)";
  }
  if (/opensea http 429|resource rate limit/i.test(lower)) {
    return msg.slice(0, 140);
  }
  if (/-32005|rps limit|try_again_in/i.test(lower)) {
    return msg.slice(0, 140);
  }
  if (/missing revert data/i.test(lower)) {
    return "missing revert data (ambiguous — retried)";
  }
  if (msg.includes("execution reverted") || /\breverted\b/i.test(msg)) {
    return "reverted";
  }
  if (lower.includes("insufficient funds")) return "insufficient funds";
  return msg
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/0x[0-9a-fA-F]{48,}/g, "0x…")
    .slice(0, 140);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Accept OpenSea URL, contract address, or bare collection slug. */
export function resolveSlugInput(raw: string): {
  kind: "url" | "slug";
  value: string;
} | null {
  const text = normalizeOpenSeaInput(raw);
  if (!text) return null;
  const link = parseOpenSeaUrl(text);
  if (link) return { kind: "url", value: link.url || text };
  if (/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(text) && !text.includes("://")) {
    return { kind: "slug", value: text.toLowerCase() };
  }
  return null;
}

function incompleteOpenSeaAssetHint(raw: string): string | null {
  const text = normalizeOpenSeaInput(raw);
  // e.g. https://opensea.io/assets/robinhood  (missing contract)
  if (/opensea\.io\/(?:assets|item)\/[a-z0-9_-]+\/?$/i.test(text)) {
    return (
      "Incomplete OpenSea URL (missing contract).\n" +
        "Collection examples:\n" +
        "• https://opensea.io/assets/robinhood/0xContract\n" +
        "• https://opensea.io/collection/your-drop\n" +
        "• /claim 0xContract 10"
    );
  }
  return null;
}

async function resolveSlugFromInput(raw: string): Promise<{
  slug: string;
  openSeaUrl: string;
}> {
  const incomplete = incompleteOpenSeaAssetHint(raw);
  if (incomplete) {
    throw new Error(incomplete);
  }
  const parsed = resolveSlugInput(raw);
  if (!parsed) {
    throw new Error(
      "Invalid input. Use an OpenSea URL or collection slug.\n" +
        "Examples:\n" +
        "/claim https://opensea.io/assets/robinhood/0xContract 10\n" +
        "/claim 0xContract 10\n" +
        "/mintslug your-drop"
    );
  }
  if (parsed.kind === "slug") {
    return {
      slug: parsed.value,
      openSeaUrl: `https://opensea.io/collection/${parsed.value}`,
    };
  }
  const link = parseOpenSeaUrl(parsed.value)!;
  const slug = await resolveCollectionSlug(link);
  return {
    slug,
    openSeaUrl: link.url || `https://opensea.io/collection/${slug}`,
  };
}

async function buildFreeMintForWallet(
  slug: string,
  wallet: Wallet,
  stage: OpenSeaDropStage,
  mode: "max" | "claim"
): Promise<{ to: string; data: string; valueWei: bigint; quantity: number }> {
  const cool = getOpenSeaCooldownRemainingMs();
  if (cool > 0) {
    await sleep(Math.min(cool, 3_000));
  }
  const stageMax = openSeaStageMaxPerWallet(stage);
  const quantities =
    mode === "claim"
      ? [1].filter((q) => q <= stageMax)
      : maxMintQuantityLadder(stageMax).filter((q) => q <= stageMax);
  if (quantities.length === 0) {
    throw new Error(`Stage max_per_wallet is ${stageMax} — cannot mint`);
  }
  let lastErr: Error | null = null;
  for (const quantity of quantities) {
    try {
      const built = await buildOpenSeaDropMintTx({
        slug,
        minter: wallet.address,
        quantity,
      });
      if (built.valueWei > 0n) {
        throw new Error(
          `OpenSea mint requires payment (${built.valueWei} wei) — free-mint only`
        );
      }
      return { ...built, quantity };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (/opensea http 429|cooldown/i.test(lastErr.message)) {
        throw lastErr;
      }
    }
  }
  throw lastErr || new Error("OpenSea free mint build failed");
}

async function sendMint(
  wallet: Wallet,
  params: { to: string; data: string; valueWei: bigint; strategy?: string }
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const gate = getMintRpcGate();
  const tryProvider = async (
    provider: ReturnType<typeof getMintProvider>,
    label: string
  ) => {
    const connected = wallet.connect(provider);
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const estimated = await gate.run(() =>
          provider.estimateGas({
            from: wallet.address,
            to: params.to,
            data: params.data,
            value: params.valueWei,
          })
        );
        const resolved = resolveMintGasLimit({
          estimated,
          ceiling: config.maxMintGasLimit,
          marginPct: 20,
        });
        console.log(
          `[mintslug:gas] strategy=${params.strategy || "OpenSeaDrop"} via=${label} ` +
            `fn=${mintSelectorLabel(params.data)} estimateGas=${estimated} ` +
            `ceiling=${resolved.ceiling} gasLimit=${resolved.ok ? resolved.gasLimit : 0}`
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
                to: params.to,
                data: params.data,
                value: params.valueWei,
                gasLimit: resolved.gasLimit,
                nonce,
                chainId: Number(config.chain.chainId),
              }),
          })
        );
        void sent.wait().catch(() => undefined);
        return { ok: true as const, txHash: sent.hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/nonce/i.test(msg)) invalidateWalletNonce(wallet.address);
        const waitMs = parseTryAgainMs(err);
        if (waitMs != null && attempt < maxAttempts - 1) {
          console.warn(
            `[mintslug] ${label} RPS — wait ${waitMs}ms (attempt ${attempt + 1})`
          );
          await sleep(waitMs);
          continue;
        }
        if (isMissingRevertData(err) && attempt < maxAttempts - 1) {
          console.warn(
            `[mintslug] missing revert data via ${label} — retry (not treating as contract fail yet)`
          );
          await sleep(150);
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
      /timeout|econn|502|503|504|unavailable/i.test(err))
  ) {
    console.warn(`[mintslug] primary failed (${err}) — trying backup`);
    return tryProvider(backup, "mint-backup");
  }
  return primary;
}

/**
 * Immediately free-mint an OpenSea drop (URL or slug) on every funded mint wallet.
 * - mode "max" (default): MAX quantity per wallet, parallel rate-aware blast
 * - mode "claim": 1 NFT per wallet
 * - intervalSec > 0: sequential one-wallet-at-a-time with sleep between wallets
 */
export async function mintOpenSeaSlugNow(
  raw: string,
  options: SlugMintOptions = {}
): Promise<SlugMintResult> {
  const mode = options.mode ?? "max";
  const intervalSec = Math.max(0, Math.floor(options.intervalSec ?? 0));
  const sequential = intervalSec > 0;
  const onProgress = options.onProgress;

  clearWalletReadinessCache();
  await ensureOpenSeaApiKey();
  if (!getOpenSeaApiKey()) {
    throw new Error(
      "OpenSea API key missing — set OPENSEA_API_KEY or /openseakey refresh"
    );
  }

  const { slug, openSeaUrl } = await resolveSlugFromInput(raw);
  // Shared drop fetch (cached) — once for the whole mint.
  const drop = await fetchOpenSeaDrop(slug);

  if (
    drop.chain &&
    drop.chain !== "robinhood" &&
    drop.chain !== config.chain.openseaChain
  ) {
    throw new Error(`Drop chain is ${drop.chain}, not Robinhood`);
  }

  const stage =
    (drop.is_minting && drop.active_stage) ||
    drop.stages.find((s) => stagePriceWei(s) === 0n) ||
    drop.active_stage ||
    null;

  if (!stage) {
    throw new Error("No OpenSea drop stage available for this collection");
  }
  if (stagePriceWei(stage) > 0n) {
    throw new Error("Active OpenSea stage is paid — free-mint only");
  }

  const stageLabel = stage.label || stage.stage_type || "drop";
  const quantityTarget =
    mode === "claim" ? 1 : openSeaStageMaxPerWallet(stage);
  const name = drop.collection_name || drop.collection_slug || slug;
  const contract = (drop.contract_address || "").toLowerCase();
  const state = getState();

  const baseMeta = {
    dryRun: state.dryRun,
    slug,
    name,
    contract,
    stageLabel,
    quantityTarget,
    openSeaUrl: drop.opensea_url || openSeaUrl,
    mode,
    intervalSec: sequential ? intervalSec : 0,
  };

  const all = getAllMintWallets();
  if (all.length === 0) {
    return {
      ...baseMeta,
      success: false,
      reason: "No mint wallets configured. Use /addkey or PRIVATE_KEY(S).",
      results: [],
      statsText: formatMintResultStats({
        configured: 0,
        fundedReady: 0,
        empty: 0,
        lowGas: 0,
        ineligible: 0,
        submitted: 0,
        successful: 0,
        rpcRateLimited: 0,
        openSeaRateLimited: 0,
        contractRejected: 0,
        other: 0,
      }),
    };
  }

  // All configured wallets (e.g. 21) — no hard cap.
  const readiness = await checkMintWalletReadiness(all);
  const funded = readiness.ready;
  const skippedEmpty = readiness.empty.length + readiness.lowGas.length;

  console.log(
    `[mintslug] mode=${mode} interval=${intervalSec}s wallets configured=${all.length} ` +
      `ready=${funded.length} empty=${readiness.empty.length} lowGas=${readiness.lowGas.length}`
  );

  if (funded.length === 0) {
    const stats = buildMintResultStats({
      configured: all.length,
      fundedReady: 0,
      empty: readiness.empty.length,
      lowGas: readiness.lowGas.length,
      outcomes: [],
    });
    return {
      ...baseMeta,
      success: false,
      reason: `All ${all.length} mint wallet(s) empty/low-gas. Fund wallets with RH gas.`,
      results: [],
      statsText: formatMintResultStats(stats),
    };
  }

  const qtyLabel =
    mode === "claim" ? "claim x1" : `MAX-mint x${quantityTarget}`;
  const paceLabel = sequential
    ? `sequential · ${intervalSec}s between wallets`
    : "parallel blast";

  if (state.dryRun) {
    const stats = buildMintResultStats({
      configured: all.length,
      fundedReady: funded.length,
      empty: readiness.empty.length,
      lowGas: readiness.lowGas.length,
      outcomes: funded.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
        bucket: "success" as const,
      })),
    });
    const etaSec = sequential
      ? Math.max(0, (funded.length - 1) * intervalSec)
      : 0;
    return {
      ...baseMeta,
      dryRun: true,
      success: true,
      reason: `DRY RUN — would ${qtyLabel} on ${funded.length}/${all.length} wallet(s) (${paceLabel}${
        etaSec ? `; ~${etaSec}s wall time` : ""
      })${skippedEmpty ? ` (${skippedEmpty} empty/low-gas skipped)` : ""}. /dryrun off to go live.\n\n${formatMintResultStats(stats)}`,
      results: funded.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
        quantity: quantityTarget,
      })),
      statsText: formatMintResultStats(stats),
    };
  }

  const mintOne = async (wallet: Wallet): Promise<SlugMintWalletResult> => {
    const address = wallet.address.toLowerCase();
    try {
      const built = await buildFreeMintForWallet(slug, wallet, stage, mode);
      const sent = await sendMint(wallet, {
        ...built,
        strategy: `OpenSeaDrop(${slug},${mode},x${built.quantity})`,
      });
      if (!sent.ok) {
        return {
          address,
          ok: false,
          quantity: built.quantity,
          error: sent.error,
        };
      }
      return {
        address,
        ok: true,
        txHash: sent.txHash,
        quantity: built.quantity,
      };
    } catch (err) {
      return {
        address,
        ok: false,
        error: shortErr(err),
      };
    }
  };

  let results: SlugMintWalletResult[];
  if (sequential) {
    results = [];
    for (let i = 0; i < funded.length; i++) {
      const wallet = funded[i];
      const n = i + 1;
      if (onProgress) {
        await onProgress(
          `⏳ Wallet ${n}/${funded.length}: ${wallet.address.slice(0, 8)}… (${qtyLabel})`
        );
      }
      const one = await mintOne(wallet);
      results.push(one);
      if (onProgress) {
        await onProgress(
          one.ok
            ? `✅ ${n}/${funded.length} OK ${one.txHash?.slice(0, 12) ?? ""}…`
            : `❌ ${n}/${funded.length} FAIL (${one.error || "fail"})`
        );
      }
      if (i < funded.length - 1) {
        if (onProgress) {
          await onProgress(`⏱ Waiting ${intervalSec}s before next wallet…`);
        }
        await sleep(intervalSec * 1_000);
      }
    }
  } else {
    // Rate-aware concurrency: OpenSea mint builder is slow/429-prone; RPC gate caps sends.
    results = await mapPool(funded, 4, mintOne);
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

  const ok = results.filter((r) => r.ok);
  const summary = results
    .map((r) =>
      r.ok
        ? `${r.address.slice(0, 6)}… OK ${r.txHash?.slice(0, 10)}… x${r.quantity ?? "?"}`
        : `${r.address.slice(0, 6)}… FAIL (${r.error})`
    )
    .join(" | ");

  return {
    ...baseMeta,
    dryRun: false,
    success: ok.length > 0,
    reason:
      (ok.length > 0
        ? `${mode === "claim" ? "Claimed" : "Minted"} on ${ok.length}/${funded.length} ready wallet(s) (${all.length} configured · ${paceLabel})${
            skippedEmpty ? `; ${skippedEmpty} empty/low-gas skipped` : ""
          }: ${summary}`
        : `All ready wallets failed (${all.length} configured, ${funded.length} ready · ${paceLabel}): ${summary}`) +
      `\n\n${statsText}`,
    results,
    statsText,
  };
}
