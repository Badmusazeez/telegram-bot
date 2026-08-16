import { Interface } from "ethers";
import { config } from "../config";
import {
  ensureOpenSeaApiKey,
  getOpenSeaApiKey,
} from "./openseaAuth";
import {
  buildOpenSeaDropMintTx,
  fetchOpenSeaDrop,
  type OpenSeaDropStage,
} from "./openseaDrop";
import {
  clampMaxPerWallet,
  hardMaxMintQuantity,
  maxMintQuantityLadder,
} from "./mintQuantity";

function stagePriceWei(stage: OpenSeaDropStage | null | undefined): bigint {
  if (!stage?.price) return 0n;
  try {
    return BigInt(stage.price);
  } catch {
    return 0n;
  }
}

export function openSeaStageMaxPerWallet(
  stage: OpenSeaDropStage | null | undefined
): number {
  return clampMaxPerWallet(stage?.max_per_wallet ?? hardMaxMintQuantity());
}

async function resolveOpenSeaSlug(contract: string): Promise<string | null> {
  try {
    await ensureOpenSeaApiKey();
  } catch {
    return null;
  }
  const key = getOpenSeaApiKey();
  if (!key) return null;
  try {
    const chain = config.chain.openseaChain;
    const res = await fetch(
      `https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`,
      {
        headers: {
          accept: "application/json",
          "x-api-key": key,
        },
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { collection?: string };
    return data.collection || null;
  } catch {
    return null;
  }
}

/** Build a live free OpenSea Drop mint at max_per_wallet for our minter. */
export async function prepareOpenSeaFreeMint(params: {
  collectionAddress: string;
  minterAddress: string;
}): Promise<{
  to: string;
  data: string;
  valueWei: bigint;
  quantity: number;
  slug: string;
  stageLabel: string;
}> {
  await ensureOpenSeaApiKey();
  if (!getOpenSeaApiKey()) {
    throw new Error("OpenSea API key missing — cannot build OpenSea drop mint");
  }

  const slug = await resolveOpenSeaSlug(params.collectionAddress);
  if (!slug) {
    throw new Error("No OpenSea collection slug for contract");
  }

  const drop = await fetchOpenSeaDrop(slug);
  if (
    drop.chain &&
    drop.chain !== "robinhood" &&
    drop.chain !== config.chain.openseaChain
  ) {
    throw new Error(`OpenSea drop chain ${drop.chain} is not Robinhood`);
  }

  const stage =
    (drop.is_minting && drop.active_stage) ||
    drop.stages.find((s) => stagePriceWei(s) === 0n) ||
    drop.active_stage ||
    null;

  if (!stage) {
    throw new Error("No OpenSea drop stage available");
  }
  if (stagePriceWei(stage) > 0n) {
    throw new Error("OpenSea active stage is paid — free-mint only");
  }

  // Always max for this stage; if builder rejects high qty, step down.
  const target = openSeaStageMaxPerWallet(stage);
  const ladder = maxMintQuantityLadder(target).filter((q) => q <= target);
  let lastErr: Error | null = null;

  for (const quantity of ladder) {
    try {
      const built = await buildOpenSeaDropMintTx({
        slug,
        minter: params.minterAddress,
        quantity,
      });
      if (built.valueWei > 0n) {
        throw new Error(`OpenSea mint requires payment (${built.valueWei} wei)`);
      }
      return {
        ...built,
        quantity,
        slug,
        stageLabel: stage.label || stage.stage_type || "drop",
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr || new Error("OpenSea max mint failed");
}

const MINT_IFACE = new Interface([
  "function mint()",
  "function mint(uint256 quantity)",
  "function publicMint(uint256 quantity)",
  "function claim(uint256 quantity)",
  "function mintTo(address to, uint256 quantity)",
]);

export type PublicMintCandidate = {
  to: string;
  data: string;
  valueWei: bigint;
  label: string;
  quantity: number;
};

/**
 * Build public free-mint calldata candidates — MAX qty first, then step down.
 */
export function buildPublicMaxMintCandidates(params: {
  to: string;
  minter: string;
  whaleQuantity?: number;
}): PublicMintCandidate[] {
  const qtys = maxMintQuantityLadder(params.whaleQuantity);
  const out: PublicMintCandidate[] = [];

  for (const q of qtys) {
    out.push({
      to: params.to,
      data: MINT_IFACE.encodeFunctionData("mint", [BigInt(q)]),
      valueWei: 0n,
      label: `mint(${q})`,
      quantity: q,
    });
    out.push({
      to: params.to,
      data: MINT_IFACE.encodeFunctionData("publicMint", [BigInt(q)]),
      valueWei: 0n,
      label: `publicMint(${q})`,
      quantity: q,
    });
    out.push({
      to: params.to,
      data: MINT_IFACE.encodeFunctionData("claim", [BigInt(q)]),
      valueWei: 0n,
      label: `claim(${q})`,
      quantity: q,
    });
    out.push({
      to: params.to,
      data: MINT_IFACE.encodeFunctionData("mintTo", [
        params.minter,
        BigInt(q),
      ]),
      valueWei: 0n,
      label: `mintTo(self,${q})`,
      quantity: q,
    });
  }

  out.push({
    to: params.to,
    data: MINT_IFACE.encodeFunctionData("mint", []),
    valueWei: 0n,
    label: "mint()",
    quantity: 1,
  });

  return out;
}

/** If whale calldata is mint(uint256)-like, return quantity. */
export function decodeWhaleMintQuantity(data: string): number | undefined {
  const raw = data.toLowerCase();
  if (raw.length < 10 + 64) return undefined;
  const word = raw.slice(-64);
  try {
    const q = Number(BigInt(`0x${word}`));
    if (Number.isFinite(q) && q >= 1 && q <= 100) return q;
  } catch {
    // ignore
  }
  return undefined;
}

/** Replace trailing uint256 quantity in calldata with a new qty (same selector). */
export function replaceCalldataQuantity(
  data: string,
  quantity: number
): string | null {
  const raw = data.toLowerCase();
  if (!raw.startsWith("0x") || raw.length < 10 + 64) return null;
  if (quantity < 1 || quantity > 100) return null;
  const head = raw.slice(0, raw.length - 64);
  const qty = BigInt(quantity).toString(16).padStart(64, "0");
  return head + qty;
}
