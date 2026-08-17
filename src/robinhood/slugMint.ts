import type { Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import {
  buildOpenSeaDropMintTx,
  fetchOpenSeaDrop,
  resolveCollectionSlug,
  type OpenSeaDropStage,
} from "./openseaDrop";
import { parseOpenSeaUrl } from "./openseaUrl";
import { openSeaStageMaxPerWallet } from "./multiMint";
import { maxMintQuantityLadder } from "./mintQuantity";
import { ensureOpenSeaApiKey, getOpenSeaApiKey } from "./openseaAuth";
import {
  getAllMintWallets,
  getFundedMintWallets,
  getMintProvider,
} from "./provider";
import { reportMintRpcIssue } from "./mintRpcAlerts";
import { classifyRpcError } from "./rpcHealth";
import { mintSelectorLabel, resolveMintGasLimit } from "./mintGas";

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
};

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
  if (msg.includes("execution reverted") || /\breverted\b/i.test(msg)) {
    return "reverted";
  }
  if (lower.includes("insufficient funds")) return "insufficient funds";
  return msg
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/0x[0-9a-fA-F]{48,}/g, "0x…")
    .slice(0, 140);
}

/** Accept OpenSea URL or bare collection slug. */
export function resolveSlugInput(raw: string): {
  kind: "url" | "slug";
  value: string;
} | null {
  const text = raw.trim();
  if (!text) return null;
  const link = parseOpenSeaUrl(text);
  if (link) return { kind: "url", value: text };
  // Bare slug: cool-cats / my_drop-123
  if (/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(text) && !text.includes("://")) {
    return { kind: "slug", value: text.toLowerCase() };
  }
  return null;
}

async function resolveSlugFromInput(raw: string): Promise<{
  slug: string;
  openSeaUrl: string;
}> {
  const parsed = resolveSlugInput(raw);
  if (!parsed) {
    throw new Error(
      "Invalid input. Use an OpenSea URL or collection slug.\n" +
        "Examples:\n" +
        "/mintslug https://opensea.io/collection/your-drop\n" +
        "/mintslug https://opensea.io/assets/robinhood/0xContract/1\n" +
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

async function buildMaxMintForWallet(
  slug: string,
  wallet: Wallet,
  stage: OpenSeaDropStage
): Promise<{ to: string; data: string; valueWei: bigint; quantity: number }> {
  const target = openSeaStageMaxPerWallet(stage);
  const ladder = maxMintQuantityLadder(target).filter((q) => q <= target);
  let lastErr: Error | null = null;
  for (const quantity of ladder) {
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
    }
  }
  throw lastErr || new Error("OpenSea max mint build failed");
}

async function sendMint(
  wallet: Wallet,
  params: { to: string; data: string; valueWei: bigint; strategy?: string }
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const provider = getMintProvider();
  const connected = wallet.connect(provider);
  try {
    const estimated = await provider.estimateGas({
      from: wallet.address,
      to: params.to,
      data: params.data,
      value: params.valueWei,
    });
    const resolved = resolveMintGasLimit({
      estimated,
      ceiling: config.maxMintGasLimit,
      marginPct: 20,
    });
    console.log(
      `[mintslug:gas] strategy=${params.strategy || "OpenSeaDrop"} ` +
        `fn=${mintSelectorLabel(params.data)} estimateGas=${estimated} ` +
        `ceiling=${resolved.ceiling} gasLimit=${resolved.ok ? resolved.gasLimit : 0}`
    );
    if (!resolved.ok) {
      return { ok: false, error: resolved.reason };
    }
    const sent = await connected.sendTransaction({
      to: params.to,
      data: params.data,
      value: params.valueWei,
      gasLimit: resolved.gasLimit,
      chainId: Number(config.chain.chainId),
    });
    void sent.wait().catch(() => undefined);
    return { ok: true, txHash: sent.hash };
  } catch (err) {
    if (classifyRpcError(err)) {
      void reportMintRpcIssue(err);
    }
    return { ok: false, error: shortErr(err) };
  }
}

/**
 * Immediately MAX-mint an OpenSea drop (URL or slug) on every funded mint wallet.
 * Independent of /copy — respects dryRun only.
 */
export async function mintOpenSeaSlugNow(raw: string): Promise<SlugMintResult> {
  await ensureOpenSeaApiKey();
  if (!getOpenSeaApiKey()) {
    throw new Error(
      "OpenSea API key missing — set OPENSEA_API_KEY or /openseakey refresh"
    );
  }

  const { slug, openSeaUrl } = await resolveSlugFromInput(raw);
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
  const quantityTarget = openSeaStageMaxPerWallet(stage);
  const name = drop.collection_name || drop.collection_slug || slug;
  const contract = (drop.contract_address || "").toLowerCase();
  const state = getState();

  const all = getAllMintWallets();
  if (all.length === 0) {
    return {
      dryRun: state.dryRun,
      success: false,
      slug,
      name,
      contract,
      stageLabel,
      quantityTarget,
      openSeaUrl: drop.opensea_url || openSeaUrl,
      reason: "No mint wallets configured. Use /addkey or PRIVATE_KEY(S).",
      results: [],
    };
  }

  const { funded, skippedEmpty } = await getFundedMintWallets(all);
  if (funded.length === 0) {
    return {
      dryRun: state.dryRun,
      success: false,
      slug,
      name,
      contract,
      stageLabel,
      quantityTarget,
      openSeaUrl: drop.opensea_url || openSeaUrl,
      reason: `All ${all.length} mint wallet(s) have insufficient RH gas.`,
      results: [],
    };
  }

  if (state.dryRun) {
    return {
      dryRun: true,
      success: true,
      slug,
      name,
      contract,
      stageLabel,
      quantityTarget,
      openSeaUrl: drop.opensea_url || openSeaUrl,
      reason: `DRY RUN — would MAX-mint x${quantityTarget} on ${funded.length} wallet(s)${
        skippedEmpty ? ` (skipped ${skippedEmpty} empty)` : ""
      }. /dryrun off to go live.`,
      results: funded.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
        quantity: quantityTarget,
      })),
    };
  }

  const results = await Promise.all(
    funded.map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      try {
        const built = await buildMaxMintForWallet(slug, wallet, stage);
        const sent = await sendMint(wallet, built);
        if (!sent.ok) {
          return {
            address,
            ok: false as const,
            quantity: built.quantity,
            error: sent.error,
          };
        }
        return {
          address,
          ok: true as const,
          txHash: sent.txHash,
          quantity: built.quantity,
        };
      } catch (err) {
        return {
          address,
          ok: false as const,
          error: shortErr(err),
        };
      }
    })
  );

  const ok = results.filter((r) => r.ok);
  const summary = results
    .map((r) =>
      r.ok
        ? `${r.address.slice(0, 6)}… OK ${r.txHash?.slice(0, 10)}… x${r.quantity ?? "?"}`
        : `${r.address.slice(0, 6)}… FAIL (${r.error})`
    )
    .join(" | ");

  return {
    dryRun: false,
    success: ok.length > 0,
    slug,
    name,
    contract,
    stageLabel,
    quantityTarget,
    openSeaUrl: drop.opensea_url || openSeaUrl,
    reason:
      ok.length > 0
        ? `Minted on ${ok.length}/${funded.length} wallet(s)${
            skippedEmpty ? ` (skipped ${skippedEmpty} empty)` : ""
          }: ${summary}`
        : `All wallets failed: ${summary}`,
    results,
  };
}
