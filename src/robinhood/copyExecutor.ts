import { formatEther, type Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";
import {
  gasIsAffordable,
  getAllMintWallets,
  getFundedMintWallets,
  getMintBackupProvider,
  getMintProvider,
  getProvider,
} from "./provider";
import {
  isScatterMintCalldata,
  prepareScatterFreeMint,
} from "./scatter";
import {
  buildPublicMaxMintCandidates,
  decodeWhaleMintQuantity,
  prepareOpenSeaFreeMint,
  replaceCalldataQuantity,
} from "./multiMint";
import { ensureOpenSeaApiKey, getOpenSeaApiKey } from "./openseaAuth";
import { maxMintQuantityLadder } from "./mintQuantity";

/** One copy attempt per whale mint tx (Scatter/721A often emit many Transfers). */
const copyBySourceTx = new Map<string, Promise<CopyResult>>();

/** Last copy attempt — shown in /status for debugging. */
let lastCopySummary: {
  at: string;
  txHash: string;
  success: boolean;
  reason: string;
} | null = null;

export function getLastCopySummary(): typeof lastCopySummary {
  return lastCopySummary;
}

function rememberCopyResult(purchase: NftPurchase, result: CopyResult): void {
  lastCopySummary = {
    at: new Date().toISOString(),
    txHash: purchase.txHash,
    success: result.success && !result.dryRun,
    reason: result.reason.slice(0, 280),
  };
}

/**
 * Free-mint copy executor for Robinhood Chain.
 *
 * Strategies (max qty when possible):
 * 1) Scatter.art API
 * 2) OpenSea Drop API
 * 3) Public contract mint/claim variants at max qty
 * 4) Whale calldata replay (+ address rewrite / qty bump)
 */
export async function maybeCopyPurchase(
  purchase: NftPurchase
): Promise<CopyResult> {
  const txKey = purchase.txHash.toLowerCase();
  const existing = copyBySourceTx.get(txKey);
  if (existing) {
    const result = await existing;
    return {
      ...result,
      reason: `${result.reason} (deduped same mint tx)`,
    };
  }

  const pending = (async () => {
    let result = await executeCopy(purchase);
    // Retry once on RPC indexing lag — common on fast RH blocks.
    if (
      !result.success &&
      /RPC lag|Could not load source mint/i.test(result.reason)
    ) {
      await sleep(1_500);
      result = await executeCopy(purchase);
    }
    // Don't let intentional paid-skips overwrite Last copy in /status —
    // that made free-mint hits look like failures.
    const paidSkip =
      /skipped paid mint|paid mint\/buy \(free-mints-only/i.test(result.reason);
    if (!paidSkip) {
      rememberCopyResult(purchase, result);
    } else {
      console.log(
        `[mint] skip paid ${purchase.txHash.slice(0, 10)}… ${result.reason}`
      );
    }
    // Don't permanently cache hard failures — allow a later hit to retry.
    if (!result.success && !result.dryRun) {
      copyBySourceTx.delete(txKey);
    }
    return result;
  })();

  copyBySourceTx.set(txKey, pending);
  if (copyBySourceTx.size > 500) {
    const first = copyBySourceTx.keys().next().value;
    if (first) copyBySourceTx.delete(first);
  }
  return pending;
}

async function executeCopy(purchase: NftPurchase): Promise<CopyResult> {
  const state = getState();

  if (state.freeMintsOnly) {
    if (
      !purchase.isFreeMint ||
      purchase.isPaid ||
      purchase.valueRobinhood > 0
    ) {
      return {
        attempted: false,
        success: false,
        dryRun: state.dryRun,
        reason: "Skipped — paid mint/buy (free-mints-only mode).",
      };
    }
  }

  if (!state.copyEnabled) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Auto-mint is disabled. Use /copy on to enable.",
    };
  }

  if (
    state.allowedCollections.length > 0 &&
    !state.allowedCollections.includes(purchase.contract.toLowerCase())
  ) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Collection is not in the allowlist.",
    };
  }

  if (!purchase.isFreeMint) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Not a free mint — skipped.",
    };
  }

  const affordableGas = await gasIsAffordable();
  if (!affordableGas) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `Gas above MAX_GAS_GWEI (${config.maxGasGwei}).`,
    };
  }

  const sourceTx = await loadSourceTx(purchase.txHash);
  if (!sourceTx) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Could not load source mint transaction (RPC lag). Will retry next hit.",
    };
  }

  if (sourceTx.value > 0n) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `Skipped paid mint (${formatEther(sourceTx.value)} native).`,
    };
  }

  if (!sourceTx.to || !sourceTx.data || sourceTx.data === "0x") {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Source tx has no calldata to replay.",
    };
  }

  if (sourceTx.from.toLowerCase() !== purchase.buyer.toLowerCase()) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason:
        "Skipped airdrop/mint-to-wallet — whale did not send the mint tx.",
    };
  }

  const allWallets = getAllMintWallets();
  if (allWallets.length === 0) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "No mint wallets configured. Use /addkey or PRIVATE_KEY(S).",
    };
  }

  const { funded, skippedEmpty } = await getFundedMintWallets(allWallets);
  if (funded.length === 0) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `No mint wallets have gas (${allWallets.length} configured, all empty). Send Robinhood Chain ETH to /listkeys addresses.`,
    };
  }

  const wallets = funded;
  const scatterLike = isScatterMintCalldata(sourceTx.data);
  const openSeaLike = isOpenSeaMinter(sourceTx.to);
  const whaleQty = decodeWhaleMintQuantity(sourceTx.data) || 1;

  if (state.dryRun) {
    return {
      attempted: true,
      success: false,
      dryRun: true,
      reason: `NOT MINTED — dry-run is ON. Use /golive. Would try scatter=${scatterLike} opensea=${openSeaLike} whaleQty≈${whaleQty} on ${wallets.length} funded wallet(s)${skippedEmpty ? ` (skipped ${skippedEmpty} empty)` : ""}.`,
    };
  }

  const attempts: string[] = [];
  const collection = purchase.contract;

  console.log(
    `[mint] start ${purchase.txHash.slice(0, 10)}… contract=${collection} funded=${wallets.length}/${allWallets.length} scatter=${scatterLike} opensea=${openSeaLike}`
  );

  // 1) Scatter first when detected (signature-bound — must rebuild via API)
  if (scatterLike) {
    const scatter = await mintScatter(purchase, wallets, collection);
    if (scatter.success) return scatter;
    attempts.push(scatter.reason);
  }

  // 2) Scatter for unknown sites (many RH free mints are Scatter under the hood)
  if (!scatterLike) {
    try {
      const scatter = await mintScatter(purchase, wallets, collection);
      if (scatter.success) return scatter;
      attempts.push(scatter.reason);
    } catch (err) {
      attempts.push(
        `Scatter: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 3) OpenSea Drop builder — max_per_wallet
  try {
    await ensureOpenSeaApiKey();
  } catch {
    // continue
  }
  if (getOpenSeaApiKey()) {
    const os = await mintOpenSea(purchase, wallets);
    if (os.success) return os;
    attempts.push(os.reason);
  } else if (openSeaLike) {
    attempts.push("OpenSea path needs API key (auto-fetch failed)");
  }

  // 4) Public contract max-mint probes
  const publicTry = await mintPublicMax(
    wallets,
    [collection, sourceTx.to],
    whaleQty
  );
  if (publicTry.success) return publicTry;
  attempts.push(publicTry.reason);

  // 5) Replay whale calldata (rewrite address + bump qty) — last resort
  const replay = await mintByReplay(
    wallets,
    sourceTx.to,
    sourceTx.data,
    purchase.buyer,
    whaleQty
  );
  if (replay.success) return replay;
  attempts.push(replay.reason);

  console.warn(`[mint] all strategies failed for ${purchase.txHash}: ${attempts.join(" || ")}`);

  return {
    attempted: true,
    success: false,
    dryRun: false,
    reason: `All mint strategies failed: ${attempts.join(" || ")}`,
  };
}

async function mintScatter(
  purchase: NftPurchase,
  wallets: Wallet[],
  collectionAddress: string
): Promise<CopyResult> {
  const results = await Promise.all(
    wallets.map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      try {
        const prepared = await prepareScatterFreeMint({
          collectionAddress,
          minterAddress: wallet.address,
          collectionName: purchase.collectionName,
        });
        const sent = await sendMintTx(wallet, {
          to: prepared.to,
          data: prepared.data,
          valueWei: prepared.valueWei,
        });
        if (!sent.ok) {
          return {
            address,
            ok: false as const,
            error: sent.error || "scatter send failed",
          };
        }
        return {
          address,
          ok: true as const,
          txHash: sent.txHash,
          detail: `Scatter ${prepared.slug} x${prepared.quantity} (${prepared.listName})`,
        };
      } catch (err) {
        return {
          address,
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const ok = results.filter((r) => r.ok);
  const summary = results
    .map((r) =>
      r.ok
        ? `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10)}… ${r.detail || ""}`
        : `${shortAddr(r.address)} FAIL (${r.error})`
    )
    .join(" | ");

  return {
    attempted: true,
    success: ok.length > 0,
    dryRun: false,
    reason:
      ok.length > 0
        ? `Scatter minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `Scatter mint failed on all wallets: ${summary}`,
    txHash: ok[0] && ok[0].ok ? ok[0].txHash : undefined,
  };
}

async function mintOpenSea(
  purchase: NftPurchase,
  wallets: Wallet[]
): Promise<CopyResult> {
  const results = await Promise.all(
    wallets.map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      try {
        const prepared = await prepareOpenSeaFreeMint({
          collectionAddress: purchase.contract,
          minterAddress: wallet.address,
        });
        const sent = await sendMintTx(wallet, {
          to: prepared.to,
          data: prepared.data,
          valueWei: prepared.valueWei,
        });
        if (!sent.ok) {
          return {
            address,
            ok: false as const,
            error: sent.error || "opensea send failed",
          };
        }
        return {
          address,
          ok: true as const,
          txHash: sent.txHash,
          detail: `OpenSea ${prepared.slug} x${prepared.quantity} (${prepared.stageLabel})`,
        };
      } catch (err) {
        return {
          address,
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const ok = results.filter((r) => r.ok);
  const summary = results
    .map((r) =>
      r.ok
        ? `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10)}… ${r.detail || ""}`
        : `${shortAddr(r.address)} FAIL (${r.error})`
    )
    .join(" | ");

  return {
    attempted: true,
    success: ok.length > 0,
    dryRun: false,
    reason:
      ok.length > 0
        ? `OpenSea minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `OpenSea mint failed: ${summary}`,
    txHash: ok[0] && ok[0].ok ? ok[0].txHash : undefined,
  };
}

async function mintPublicMax(
  wallets: Wallet[],
  targets: string[],
  whaleQty: number
): Promise<CopyResult> {
  const uniqueTargets = [
    ...new Set(targets.map((t) => t.toLowerCase()).filter(Boolean)),
  ];

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      const errors: string[] = [];
      for (const to of uniqueTargets) {
        const candidates = buildPublicMaxMintCandidates({
          to,
          minter: wallet.address,
          whaleQuantity: whaleQty,
        });
        for (const c of candidates) {
          const sent = await sendMintTx(wallet, {
            to: c.to,
            data: c.data,
            valueWei: c.valueWei,
          });
          if (sent.ok) {
            return {
              address,
              ok: true as const,
              txHash: sent.txHash,
              detail: `${c.label} @ ${shortAddr(to)}`,
            };
          }
          errors.push(`${c.label}:${sent.error}`);
          // If qty too high / wrong ABI, continue; keep probes short for speed
          if (errors.length > 48) break;
        }
      }
      return {
        address,
        ok: false as const,
        error: errors.slice(0, 6).join("; ") || "no public mint worked",
      };
    })
  );

  const ok = results.filter((r) => r.ok);
  const summary = results
    .map((r) =>
      r.ok
        ? `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10)}… ${r.detail || ""}`
        : `${shortAddr(r.address)} FAIL (${r.error})`
    )
    .join(" | ");

  return {
    attempted: true,
    success: ok.length > 0,
    dryRun: false,
    reason:
      ok.length > 0
        ? `Public max-minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `Public max-mint failed: ${summary}`,
    txHash: ok[0] && ok[0].ok ? ok[0].txHash : undefined,
  };
}

async function mintByReplay(
  wallets: Wallet[],
  to: string,
  rawData: string,
  whale: string,
  whaleQty: number
): Promise<CopyResult> {
  const results = await Promise.all(
    wallets.map((wallet) =>
      mintWithWallet(wallet, to, rawData, whale, whaleQty)
    )
  );

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const summary = results
    .map((r) => {
      if (r.ok) {
        return `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10)}…`;
      }
      return `${shortAddr(r.address)} ${classifyWalletFailure(r.error || "", to)}`;
    })
    .join(" | ");

  if (ok.length > 0) {
    return {
      attempted: true,
      success: true,
      dryRun: false,
      reason: `Replay minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`,
      txHash: ok[0]?.txHash,
    };
  }

  const allWalletBound = fail.every((r) =>
    isWalletBoundFailure(r.error || "", to)
  );
  if (allWalletBound) {
    return {
      attempted: true,
      success: false,
      dryRun: false,
      reason:
        `Wallet-bound free mint — skipped (allowlist / OpenSea drop / signature). ` +
        `Cannot copy into your wallet(s). (${wallets.length} wallet(s))`,
    };
  }

  return {
    attempted: true,
    success: false,
    dryRun: false,
    reason: `Replay failed on all wallets: ${summary}`,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** RH is fast — logs can arrive before getTransaction is indexed. Retry both RPCs. */
async function loadSourceTx(txHash: string) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const tx = await getProvider().getTransaction(txHash);
      if (tx?.to && tx.data && tx.data !== "0x") return tx;
    } catch {
      // try mint rpc
    }
    try {
      const tx = await getMintProvider().getTransaction(txHash);
      if (tx?.to && tx.data && tx.data !== "0x") return tx;
    } catch {
      // continue
    }
    await sleep(350 * (attempt + 1));
  }
  return null;
}

async function sendMintTx(
  wallet: Wallet,
  params: { to: string; data: string; valueWei: bigint }
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const trySend = async (
    provider: ReturnType<typeof getMintProvider>,
    label: string
  ): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> => {
    const connected = wallet.connect(provider);
    try {
      const from = await connected.getAddress();
      const gasEstimate = await provider.estimateGas({
        from,
        to: params.to,
        data: params.data,
        value: params.valueWei,
      });
      if (gasEstimate > BigInt(config.maxMintGasLimit)) {
        return {
          ok: false,
          error: `gas ${gasEstimate} > MAX_MINT_GAS_LIMIT`,
        };
      }

      const fee = await provider.getFeeData();
      const gasLimit = (gasEstimate * 130n) / 100n;
      const txRequest: {
        to: string;
        data: string;
        value: bigint;
        gasLimit: bigint;
        chainId: number;
        gasPrice?: bigint;
        maxFeePerGas?: bigint;
        maxPriorityFeePerGas?: bigint;
      } = {
        to: params.to,
        data: params.data,
        value: params.valueWei,
        gasLimit,
        chainId: Number(config.chain.chainId),
      };
      if (fee.maxFeePerGas != null) {
        txRequest.maxFeePerGas = fee.maxFeePerGas;
        txRequest.maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;
      } else if (fee.gasPrice != null) {
        txRequest.gasPrice = fee.gasPrice;
      }

      console.log(
        `[mint] sending via ${label} from=${from.slice(0, 8)}… to=${params.to.slice(0, 10)}… gas=${gasLimit}`
      );
      const sent = await connected.sendTransaction(txRequest);
      console.log(`[mint] broadcast ${sent.hash}`);

      const receipt = await Promise.race([
        sent.wait(),
        sleep(90_000).then(() => null),
      ]);
      if (!receipt) {
        return { ok: true, txHash: sent.hash };
      }
      if (receipt.status !== 1) {
        return { ok: false, error: `reverted ${sent.hash}` };
      }
      return { ok: true, txHash: sent.hash };
    } catch (err) {
      return { ok: false, error: shortError(err) };
    }
  };

  const primary = await trySend(getMintProvider(), "chainstack");
  if (primary.ok) return primary;

  const backup = getMintBackupProvider();
  const err = primary.error || "";
  const networkish =
    /timeout|econn|socket|502|503|504|unavailable|rate limit|429|quota|capacity/i.test(
      err
    );
  if (backup && networkish) {
    console.warn(`[mint] primary mint RPC failed (${err}) — trying backup`);
    return trySend(backup, "backup");
  }
  return primary;
}

async function mintWithWallet(
  wallet: Wallet,
  to: string,
  rawData: string,
  whale: string,
  whaleQty: number
): Promise<{ address: string; ok: boolean; txHash?: string; error?: string }> {
  const address = wallet.address.toLowerCase();
  const candidates = buildCalldataCandidates(rawData, whale, address, whaleQty);
  const errors: string[] = [];

  for (const [index, data] of candidates.entries()) {
    const sent = await sendMintTx(wallet, { to, data, valueWei: 0n });
    if (sent.ok) {
      return { address, ok: true, txHash: sent.txHash };
    }
    errors.push(`v${index + 1} ${sent.error}`);
  }

  return { address, ok: false, error: errors.join("; ") || "unknown" };
}

function buildCalldataCandidates(
  data: string,
  whale: string,
  buyer: string,
  whaleQty: number
): string[] {
  const original = data.toLowerCase();
  const rewritten = replaceAddressInCalldata(original, whale, buyer);
  const base = rewritten !== original ? rewritten : original;
  const out: string[] = [];

  // Always try MAX quantity first on rewritten calldata, then step down.
  for (const q of maxMintQuantityLadder(whaleQty)) {
    const bumped = replaceCalldataQuantity(base, q);
    if (bumped && !out.includes(bumped)) {
      out.push(bumped);
    }
  }

  if (!out.includes(base)) out.push(base);
  if (rewritten !== original && !out.includes(original)) {
    out.push(original);
  }
  return out;
}

function replaceAddressInCalldata(
  data: string,
  fromAddr: string,
  toAddr: string
): string {
  const from = fromAddr.toLowerCase().replace(/^0x/, "");
  const to = toAddr.toLowerCase().replace(/^0x/, "");
  if (from.length !== 40 || to.length !== 40) {
    return data;
  }
  const fromPadded = from.padStart(64, "0");
  const toPadded = to.padStart(64, "0");
  if (!data.includes(fromPadded)) {
    return data;
  }
  return data.split(fromPadded).join(toPadded);
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("execution reverted") || /\breverted\b/i.test(msg)) {
    return "reverted";
  }
  if (msg.includes("insufficient funds")) {
    return "insufficient funds";
  }
  if (msg.toLowerCase().includes("fully minted")) {
    return "sold out";
  }
  return msg.slice(0, 120);
}

function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…`;
}

function isRevertError(error: string): boolean {
  return /\breverted\b/i.test(error) || /execution reverted/i.test(error);
}

function isOpenSeaMinter(to: string): boolean {
  return to.toLowerCase() === "0x00005ea00ac477b1030ce78506496e8c2de24bf5";
}

function isWalletBoundFailure(error: string, to: string): boolean {
  if (!error.trim()) {
    return false;
  }
  if (
    error.includes("insufficient funds") ||
    error.includes("gas too high") ||
    error.includes("sold out")
  ) {
    return false;
  }
  return isRevertError(error) || isOpenSeaMinter(to);
}

function classifyWalletFailure(error: string, to: string): string {
  if (error.includes("insufficient funds")) {
    return "needs RH gas";
  }
  if (error.includes("gas too high")) {
    return "gas too high";
  }
  if (error.includes("sold out")) {
    return "sold out";
  }
  if (isWalletBoundFailure(error, to)) {
    return "wallet-bound";
  }
  return `FAIL (${error})`;
}
