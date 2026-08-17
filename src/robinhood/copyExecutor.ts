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
  buildPublicMaxMintCandidates,
  decodeWhaleMintQuantity,
  prepareOpenSeaFreeMint,
  replaceCalldataQuantity,
} from "./multiMint";
import { ensureOpenSeaApiKey, getOpenSeaApiKey } from "./openseaAuth";
import { maxMintQuantityLadder } from "./mintQuantity";
import {
  buildSeaDropMintPublicTx,
  isSeaDropAddress,
  isSeaDropMintPublic,
} from "./seaDrop";

/** One copy attempt per whale mint tx (721A often emit many Transfers). */
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
 * 1) SeaDrop mintPublic rebuild (no OpenSea API needed) — most RH free mints
 * 2) OpenSea Drop API (max_per_wallet) when key works
 * 3) Whale calldata replay for website / any-site mints
 * 4) Public contract mint/claim probes (skipped for SeaDrop)
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

  // Never skip free mints due to gas price — RH spikes briefly during drops.
  // (Paid buys still respect MAX_GAS_GWEI elsewhere if re-enabled.)
  void gasIsAffordable;

  const sourceTx = await loadSourceTx(purchase);
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
  const openSeaLike =
    isSeaDropAddress(sourceTx.to) || isSeaDropMintPublic(sourceTx.data);
  const whaleQty = decodeWhaleMintQuantity(sourceTx.data) || 1;
  const collection = purchase.contract;
  const mintTargets = [
    ...new Set(
      [sourceTx.to, collection]
        .map((a) => (a || "").toLowerCase())
        .filter((a) => a.startsWith("0x") && a.length === 42)
    ),
  ];

  if (state.dryRun) {
    return {
      attempted: true,
      success: false,
      dryRun: true,
      reason: `NOT MINTED — dry-run is ON. Use /golive. Would try seadrop=${openSeaLike} replay→${mintTargets.length} target(s) whaleQty≈${whaleQty} on ${wallets.length} funded wallet(s)${skippedEmpty ? ` (skipped ${skippedEmpty} empty)` : ""}.`,
    };
  }

  const attempts: string[] = [];

  console.log(
    `[mint] start ${purchase.txHash.slice(0, 10)}… contract=${collection} funded=${wallets.length}/${allWallets.length} seadrop=${openSeaLike} whaleQty≈${whaleQty} targets=${mintTargets.length}`
  );

  // --- Path A: SeaDrop mintPublic rebuild (NO OpenSea API) ---
  if (openSeaLike && isSeaDropMintPublic(sourceTx.data)) {
    const sd = await mintSeaDropPublic(wallets, sourceTx.data, whaleQty);
    if (sd.success) return sd;
    attempts.push(sd.reason);

    // Optional: OpenSea Drop API only if we already have a good key (never force 401 spam).
    if (getOpenSeaApiKey()) {
      const os = await mintOpenSea(purchase, wallets);
      if (os.success) return os;
      attempts.push(os.reason);
    }

    // Do NOT fall through to public mint(100) spam — always reverts on SeaDrop.
    console.warn(
      `[mint] SeaDrop path exhausted for ${purchase.txHash}: ${attempts.join(" || ")}`
    );
    return {
      attempted: true,
      success: false,
      dryRun: false,
      reason: `SeaDrop free-mint failed (stage ended / sold out / not public): ${attempts.join(" || ")}`,
    };
  }

  // --- Path B: OpenSea Drop API for non-SeaDrop only when key present ---
  try {
    await ensureOpenSeaApiKey();
  } catch {
    // ignore
  }
  if (getOpenSeaApiKey()) {
    const os = await mintOpenSea(purchase, wallets);
    if (os.success) return os;
    attempts.push(os.reason);
  }

  // --- Path C: Replay whale website/contract mint tx ---
  const replay = await mintByReplay(
    wallets,
    mintTargets,
    sourceTx.data,
    purchase.buyer,
    whaleQty
  );
  if (replay.success) return replay;
  attempts.push(replay.reason);

  // --- Path D: Public ABI probes (non-SeaDrop only) ---
  const publicTry = await mintPublicMax(wallets, mintTargets, whaleQty);
  if (publicTry.success) return publicTry;
  attempts.push(publicTry.reason);

  console.warn(
    `[mint] all strategies failed for ${purchase.txHash}: ${attempts.join(" || ")}`
  );

  return {
    attempted: true,
    success: false,
    dryRun: false,
    reason: `All mint strategies failed: ${attempts.join(" || ")}`,
  };
}

async function mintSeaDropPublic(
  wallets: Wallet[],
  whaleData: string,
  whaleQty: number
): Promise<CopyResult> {
  // Try whale qty first (often the stage max), then our hard max ladder.
  const qtys = [
    ...new Set([whaleQty, ...maxMintQuantityLadder(whaleQty)].filter((q) => q >= 1)),
  ].sort((a, b) => b - a);

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      const errors: string[] = [];
      for (const q of qtys) {
        const built = buildSeaDropMintPublicTx({
          whaleData,
          minter: wallet.address,
          quantity: q,
        });
        if (!built) {
          return {
            address,
            ok: false as const,
            error: "could not decode SeaDrop mintPublic",
          };
        }
        // estimateGas first — avoid broadcasting doomed txs / wasting the window.
        const sent = await sendMintTx(wallet, {
          to: built.to,
          data: built.data,
          valueWei: 0n,
          skipEstimate: false,
        });
        if (sent.ok) {
          return {
            address,
            ok: true as const,
            txHash: sent.txHash,
            detail: `SeaDrop mintPublic x${q}`,
          };
        }
        errors.push(`x${q}:${sent.error}`);
        // If qty 1 already reverts, stage is dead — stop.
        if (q === 1 || /sold out|ended|not.?active|insufficient/i.test(sent.error || "")) {
          break;
        }
      }
      return {
        address,
        ok: false as const,
        error: errors.slice(0, 4).join("; ") || "SeaDrop mint failed",
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
        ? `SeaDrop minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `SeaDrop mintPublic failed: ${summary}`,
    txHash: ok[0] && ok[0].ok ? ok[0].txHash : undefined,
  };
}

async function mintOpenSea(
  purchase: NftPurchase,
  wallets: Wallet[]
): Promise<CopyResult> {
  // Resolve slug + stage once, then mint all wallets in parallel at max qty.
  let shared: Awaited<ReturnType<typeof prepareOpenSeaFreeMint>> | null = null;
  try {
    shared = await prepareOpenSeaFreeMint({
      collectionAddress: purchase.contract,
      minterAddress: wallets[0]!.address,
    });
  } catch (err) {
    return {
      attempted: true,
      success: false,
      dryRun: false,
      reason: `OpenSea prepare failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      try {
        // Rebuild per-wallet (signature / minter bound) but reuse max quantity.
        const prepared =
          wallet.address.toLowerCase() === wallets[0]!.address.toLowerCase()
            ? shared!
            : await prepareOpenSeaFreeMint({
                collectionAddress: purchase.contract,
                minterAddress: wallet.address,
              });
        const sent = await sendMintTx(wallet, {
          to: prepared.to,
          data: prepared.data,
          valueWei: prepared.valueWei,
          skipEstimate: true,
          gasLimitHint: 900_000n,
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
  targets: string | string[],
  rawData: string,
  whale: string,
  whaleQty: number
): Promise<CopyResult> {
  const tos = [
    ...new Set(
      (Array.isArray(targets) ? targets : [targets])
        .map((t) => t.toLowerCase())
        .filter(Boolean)
    ),
  ];

  const results = await Promise.all(
    wallets.map((wallet) =>
      mintWithWallet(wallet, tos, rawData, whale, whaleQty)
    )
  );

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const primaryTo = tos[0] || "";
  const summary = results
    .map((r) => {
      if (r.ok) {
        return `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10)}…`;
      }
      return `${shortAddr(r.address)} ${classifyWalletFailure(r.error || "", primaryTo)}`;
    })
    .join(" | ");

  if (ok.length > 0) {
    return {
      attempted: true,
      success: true,
      dryRun: false,
      reason: `Website/tx replay minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`,
      txHash: ok[0]?.txHash,
    };
  }

  const allWalletBound = fail.every((r) =>
    isWalletBoundFailure(r.error || "", primaryTo)
  );
  if (allWalletBound) {
    return {
      attempted: true,
      success: false,
      dryRun: false,
      reason:
        `Wallet-bound website mint (allowlist / signature tied to whale). ` +
        `Cannot copy without that site's mint API. (${wallets.length} wallet(s))`,
    };
  }

  return {
    attempted: true,
    success: false,
    dryRun: false,
    reason: `Website/tx replay failed on all wallets: ${summary}`,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer Blockscout-provided calldata; else RPC / explorer with short retries. */
async function loadSourceTx(purchase: NftPurchase): Promise<{
  to: string;
  data: string;
  value: bigint;
  from: string;
} | null> {
  if (
    purchase.sourceTo &&
    purchase.sourceData &&
    purchase.sourceData.length >= 10
  ) {
    return {
      to: purchase.sourceTo,
      data: purchase.sourceData,
      value: 0n,
      from: purchase.buyer,
    };
  }

  const txHash = purchase.txHash;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const tx = await getProvider().getTransaction(txHash);
      if (tx?.to && tx.data && tx.data !== "0x") {
        return {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          from: tx.from,
        };
      }
    } catch {
      // try mint rpc
    }
    try {
      const tx = await getMintProvider().getTransaction(txHash);
      if (tx?.to && tx.data && tx.data !== "0x") {
        return {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          from: tx.from,
        };
      }
    } catch {
      // continue
    }
    try {
      const res = await fetch(
        `https://robinhoodchain.blockscout.com/api/v2/transactions/${txHash}`,
        { signal: AbortSignal.timeout(6_000) }
      );
      if (res.ok) {
        const j = (await res.json()) as {
          from?: { hash?: string };
          to?: { hash?: string };
          raw_input?: string;
          value?: string;
        };
        const to = (j.to?.hash || "").toLowerCase();
        const data = (j.raw_input || "").toLowerCase();
        const from = (j.from?.hash || "").toLowerCase();
        if (to && data && data !== "0x") {
          return {
            to,
            data,
            value: j.value ? BigInt(j.value) : 0n,
            from: from || purchase.buyer,
          };
        }
      }
    } catch {
      // continue
    }
    await sleep(200 * (attempt + 1));
  }
  return null;
}

async function sendMintTx(
  wallet: Wallet,
  params: {
    to: string;
    data: string;
    valueWei: bigint;
    skipEstimate?: boolean;
    gasLimitHint?: bigint;
  }
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const trySend = async (
    provider: ReturnType<typeof getMintProvider>,
    label: string
  ): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> => {
    const connected = wallet.connect(provider);
    try {
      const from = await connected.getAddress();
      let gasEstimate: bigint;
      if (params.skipEstimate && params.gasLimitHint) {
        gasEstimate = params.gasLimitHint;
      } else {
        gasEstimate = await provider.estimateGas({
          from,
          to: params.to,
          data: params.data,
          value: params.valueWei,
        });
      }
      if (gasEstimate > BigInt(config.maxMintGasLimit)) {
        return {
          ok: false,
          error: `gas ${gasEstimate} > MAX_MINT_GAS_LIMIT`,
        };
      }

      const fee = await provider.getFeeData();
      const gasLimit = params.skipEstimate
        ? gasEstimate
        : (gasEstimate * 130n) / 100n;
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
        txRequest.maxFeePerGas = (fee.maxFeePerGas * 120n) / 100n;
        txRequest.maxPriorityFeePerGas =
          ((fee.maxPriorityFeePerGas ?? 0n) * 120n) / 100n;
      } else if (fee.gasPrice != null) {
        txRequest.gasPrice = (fee.gasPrice * 120n) / 100n;
      }

      console.log(
        `[mint] sending via ${label} from=${from.slice(0, 8)}… to=${params.to.slice(0, 10)}… gas=${gasLimit}`
      );
      const sent = await connected.sendTransaction(txRequest);
      console.log(`[mint] broadcast ${sent.hash}`);

      // Don't block other wallets on receipt — treat broadcast as success.
      void sent.wait().catch(() => undefined);
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
  targets: string[],
  rawData: string,
  whale: string,
  whaleQty: number
): Promise<{ address: string; ok: boolean; txHash?: string; error?: string }> {
  const address = wallet.address.toLowerCase();
  const candidates = buildCalldataCandidates(rawData, whale, address, whaleQty);
  const errors: string[] = [];

  // Cap probes so we stay inside the mint window (website free mints sell out fast).
  const maxAttempts = Math.min(candidates.length * targets.length, 12);
  let tried = 0;

  for (const to of targets) {
    for (const [index, data] of candidates.entries()) {
      if (tried >= maxAttempts) break;
      tried += 1;
      const sent = await sendMintTx(wallet, {
        to,
        data,
        valueWei: 0n,
        // First attempt: skip estimate for speed on known-good whale calldata.
        skipEstimate: index === 0,
        gasLimitHint: 1_200_000n,
      });
      if (sent.ok) {
        return { address, ok: true, txHash: sent.txHash };
      }
      errors.push(`${shortAddr(to)} v${index + 1} ${sent.error}`);
      // If clearly wallet-bound / signature, don't burn the window on more qty bumps.
      if (isWalletBoundFailure(sent.error || "", to) && index >= 1) {
        break;
      }
    }
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

function isWalletBoundFailure(error: string, _to: string): boolean {
  if (!error.trim()) {
    return false;
  }
  return /allowlist|not.?eligible|invalid.?proof|invalid.?signature|unauthorized|not.?on.?list/i.test(
    error
  );
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
