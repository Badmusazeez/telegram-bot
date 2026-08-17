import { formatEther, type Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";
import {
  getAllMintWallets,
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
import { reportMintRpcIssue } from "./mintRpcAlerts";
import { classifyRpcError } from "./rpcHealth";
import { mintSelectorLabel, resolveMintGasLimit } from "./mintGas";
import { PipelineTimer } from "./latency";
import {
  getCachedMintStrategy,
  rememberMintStrategy,
  type StrategyKind,
} from "./strategyCache";
import {
  invalidateWalletNonce,
  withWalletNonce,
} from "./nonceManager";
import { checkMintWalletReadiness } from "./walletReady";
import { classifyMintCalldata } from "./mintDetect";

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
    const timer = new PipelineTimer(purchase.detectedAtMs);
    let result = await executeCopy(purchase, timer);
    // Retry once on RPC indexing lag — common on fast RH blocks.
    if (
      !result.success &&
      /RPC lag|Could not load source mint/i.test(result.reason)
    ) {
      await sleep(1_500);
      result = await executeCopy(purchase, timer);
    }
    timer.mark("done");
    console.log(timer.summary(result.success && !result.dryRun));
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

async function executeCopy(
  purchase: NftPurchase,
  timer: PipelineTimer = new PipelineTimer(purchase.detectedAtMs)
): Promise<CopyResult> {
  const state = getState();

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

  // Load calldata FIRST (prefer pending/Blockscout sourceData) — do not wait on
  // free/paid classification from Transfer logs.
  const sourceTx = await loadSourceTx(purchase);
  timer.mark("decode");
  if (!sourceTx) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Could not load source mint transaction (RPC lag). Will retry next hit.",
    };
  }

  // Safety: only copy confident mint txs (skip transfers/approvals/unknown).
  const classified = classifyMintCalldata(
    sourceTx.to,
    sourceTx.data,
    undefined,
    sourceTx.value
  );
  if (!classified.isMint) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `Skipped non-mint tx (${classified.reason}).`,
    };
  }
  console.log(
    `[mint:decode] tracker=${purchase.buyer.slice(0, 10)}… fn=${classified.functionLabel} ` +
      `conf=${classified.confidence} nft=${(classified.nftContract || purchase.contract).slice(0, 12)}… ` +
      `value=${sourceTx.value}`
  );

  // Paid whale tx (value > 0): skip — we never send native value. Sending value=0
  // against a paid stage simply reverts on-chain (no spend).
  if (sourceTx.value > 0n || purchase.valueRobinhood > 0 || purchase.isPaid) {
    if (state.freeMintsOnly) {
      return {
        attempted: false,
        success: false,
        dryRun: state.dryRun,
        reason: `Skipped paid mint (${formatEther(sourceTx.value || 0n)} native).`,
      };
    }
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

  // ALWAYS mint on EVERY configured wallet (user wants 20/20, not 1/20).
  // Readiness is logged; we still blast all wallets (preserves 20/20 behavior).
  const readiness = await checkMintWalletReadiness(allWallets);
  if (readiness.notReady.length > 0) {
    console.warn(
      `[mint] readiness: ${readiness.notReady.length}/${allWallets.length} low-gas — still blasting all`
    );
  }
  const wallets = allWallets;

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

  const cached = getCachedMintStrategy(collection);
  if (cached) {
    console.log(
      `[mint:cache] HIT contract=${collection.slice(0, 12)}… kind=${cached.kind} qty=${cached.quantity ?? "?"} hits=${cached.hits}`
    );
  }

  if (state.dryRun) {
    return {
      attempted: true,
      success: false,
      dryRun: true,
      reason: `NOT MINTED — dry-run is ON. Use /golive. Would try seadrop=${openSeaLike} replay→${mintTargets.length} target(s) whaleQty≈${whaleQty} on ${wallets.length}/${allWallets.length} wallet(s) (lowGasWarn=${readiness.notReady.length}).`,
    };
  }

  // Track per-wallet hits across strategies — NEVER stop at 1/N success.
  const hits = new Map<
    string,
    { address: string; ok: boolean; txHash?: string; detail?: string; error?: string }
  >();
  for (const w of wallets) {
    hits.set(w.address.toLowerCase(), {
      address: w.address.toLowerCase(),
      ok: false,
      error: "pending",
    });
  }

  const remaining = () =>
    wallets.filter((w) => !hits.get(w.address.toLowerCase())?.ok);

  const mergeHits = (
    batch: Array<{
      address: string;
      ok: boolean;
      txHash?: string;
      detail?: string;
      error?: string;
    }>
  ) => {
    for (const r of batch) {
      const key = r.address.toLowerCase();
      const prev = hits.get(key);
      if (r.ok) {
        hits.set(key, { ...r, address: key, ok: true });
      } else if (!prev?.ok) {
        hits.set(key, { ...r, address: key, ok: false });
      }
    }
  };

  const summarize = (label: string) => {
    const list = [...hits.values()];
    const ok = list.filter((r) => r.ok);
    const summary = list
      .map((r) =>
        r.ok
          ? `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10) || ""}… ${r.detail || ""}`
          : `${shortAddr(r.address)} FAIL (${(r.error || "").slice(0, 40)})`
      )
      .join(" | ");
    return {
      okCount: ok.length,
      total: wallets.length,
      summary,
      reason: `${label}: ${ok.length}/${wallets.length} wallet(s) minted — ${summary}`.slice(
        0,
        1400
      ),
      txHash: ok[0]?.txHash,
    };
  };

  console.log(
    `[mint] FAST start ${purchase.txHash.slice(0, 10)}… contract=${collection} wallets=${wallets.length}/${allWallets.length} seadrop=${openSeaLike} whaleQty≈${whaleQty} targets=${mintTargets.length} (goal ${wallets.length}/${wallets.length} MAX)`
  );

  timer.mark("strategy");

  const preferReplayFirst =
    !openSeaLike &&
    cached &&
    (cached.kind === "replay" || cached.kind === "public");

  const finishIfComplete = (label: StrategyKind | string, kind?: StrategyKind) => {
    const s = summarize(String(label));
    console.log(`[mint] after ${label} ${s.okCount}/${s.total}`);
    if (s.okCount > 0 && kind) {
      rememberMintStrategy({
        contract: collection,
        kind,
        quantity: whaleQty,
        to: sourceTx.to,
      });
    }
    if (s.okCount === s.total) {
      timer.mark("broadcast");
      return {
        attempted: true as const,
        success: true as const,
        dryRun: false as const,
        reason: s.reason,
        txHash: s.txHash,
      };
    }
    return null;
  };

  // --- Path A: SeaDrop mintPublic rebuild (UNCHANGED blast-all logic) ---
  if (openSeaLike && isSeaDropMintPublic(sourceTx.data)) {
    timer.mark("simulate");
    const sd = await mintSeaDropPublic(remaining(), sourceTx.data, whaleQty);
    mergeHits(sd.hits);
    const done = finishIfComplete("SeaDrop", "seadrop");
    if (done) return done;
    // Partial — keep filling remaining wallets via OpenSea / other paths.
  }

  const runOpenSea = async () => {
    if (!getOpenSeaApiKey() || remaining().length === 0) return null;
    timer.mark("simulate");
    const os = await mintOpenSea(purchase, remaining());
    mergeHits(os.hits);
    return finishIfComplete("OpenSea", "opensea");
  };

  const runReplay = async () => {
    if (remaining().length === 0) return null;
    timer.mark("simulate");
    const replay = await mintByReplay(
      remaining(),
      mintTargets,
      sourceTx.data,
      purchase.buyer,
      whaleQty
    );
    mergeHits(replay.hits);
    return finishIfComplete("Replay", "replay");
  };

  const runPublic = async () => {
    if (remaining().length === 0) return null;
    if (openSeaLike && isSeaDropMintPublic(sourceTx.data)) return null;
    timer.mark("simulate");
    const publicTry = await mintPublicMax(remaining(), mintTargets, whaleQty);
    mergeHits(publicTry.hits);
    return finishIfComplete("Public", "public");
  };

  // Ensure OpenSea key once (non-SeaDrop / leftover fill).
  try {
    await ensureOpenSeaApiKey();
  } catch {
    // ignore
  }

  // Fast-path: if cache says replay/public worked last time, try those before OpenSea API.
  if (preferReplayFirst) {
    const a = await runReplay();
    if (a) return a;
    const b = await runOpenSea();
    if (b) return b;
    const c = await runPublic();
    if (c) return c;
  } else {
    const b = await runOpenSea();
    if (b) return b;
    const a = await runReplay();
    if (a) return a;
    const c = await runPublic();
    if (c) return c;
  }

  const final = summarize("All paths");
  timer.mark("broadcast");
  console.log(`[mint] FINAL ${final.okCount}/${final.total} for ${purchase.txHash.slice(0, 10)}…`);

  if (final.okCount > 0) {
    // Partial success still caches the best available path hint.
    rememberMintStrategy({
      contract: collection,
      kind: openSeaLike ? "seadrop" : "replay",
      quantity: whaleQty,
      to: sourceTx.to,
    });
  }

  return {
    attempted: true,
    success: final.okCount > 0,
    dryRun: false,
    reason:
      final.okCount > 0
        ? final.reason
        : `All mint strategies failed (0/${wallets.length}): ${final.summary}`.slice(0, 500),
    txHash: final.txHash,
  };
}

type WalletHit = {
  address: string;
  ok: boolean;
  txHash?: string;
  detail?: string;
  error?: string;
};

type BatchMintResult = { hits: WalletHit[]; reason: string };

async function mintSeaDropPublic(
  wallets: Wallet[],
  whaleData: string,
  whaleQty: number
): Promise<BatchMintResult> {
  if (wallets.length === 0) {
    return { hits: [], reason: "no wallets left" };
  }

  const qtys = maxMintQuantityLadder(whaleQty);
  const byAddr = new Map<
    string,
    {
      address: string;
      ok: boolean;
      txHash?: string;
      detail?: string;
      error?: string;
    }
  >();

  for (const w of wallets) {
    byAddr.set(w.address.toLowerCase(), {
      address: w.address.toLowerCase(),
      ok: false,
      error: "pending",
    });
  }

  for (const q of qtys) {
    const pending = wallets.filter((w) => !byAddr.get(w.address.toLowerCase())?.ok);
    if (pending.length === 0) break;

    console.log(
      `[mint] SeaDrop blast x${q} on ${pending.length}/${wallets.length} wallet(s)`
    );

    await Promise.all(
      pending.map(async (wallet, index) => {
        // Tiny stagger — keeps Chainstack under RPS without delaying the pack.
        if (index > 0) await sleep(Math.min(index * 20, 400));
        const address = wallet.address.toLowerCase();
        const built = buildSeaDropMintPublicTx({
          whaleData,
          minter: wallet.address,
          quantity: q,
        });
        if (!built) {
          byAddr.set(address, {
            address,
            ok: false,
            error: "could not decode SeaDrop mintPublic",
          });
          return;
        }
        const sent = await sendMintTx(wallet, {
          to: built.to,
          data: built.data,
          valueWei: 0n,
          strategy: `SeaDrop.mintPublic(x${q})`,
          contract: built.nftContract || built.to,
        });
        if (sent.ok) {
          byAddr.set(address, {
            address,
            ok: true,
            txHash: sent.txHash,
            detail: `SeaDrop mintPublic x${q}`,
          });
        } else {
          byAddr.set(address, {
            address,
            ok: false,
            error: `x${q}:${sent.error}`,
          });
        }
      })
    );

    const okCount = [...byAddr.values()].filter((r) => r.ok).length;
    if (okCount === wallets.length) break;

    // Re-blast wallets that only failed due to RPS/throttle at this SAME max qty.
    const rpsRetry = pending.filter((w) => {
      const hit = byAddr.get(w.address.toLowerCase());
      return hit && !hit.ok && /rps|rate|429|throttle|coalesce/i.test(hit.error || "");
    });
    if (rpsRetry.length > 0) {
      console.log(
        `[mint] SeaDrop RPS re-blast x${q} on ${rpsRetry.length} wallet(s)`
      );
      await sleep(200);
      await Promise.all(
        rpsRetry.map(async (wallet, index) => {
          if (index > 0) await sleep(Math.min(index * 30, 500));
          const address = wallet.address.toLowerCase();
          const built = buildSeaDropMintPublicTx({
            whaleData,
            minter: wallet.address,
            quantity: q,
          });
          if (!built) return;
          const sent = await sendMintTx(wallet, {
            to: built.to,
            data: built.data,
            valueWei: 0n,
            strategy: `SeaDrop.mintPublic(x${q}/rps-retry)`,
            contract: built.nftContract || built.to,
          });
          if (sent.ok) {
            byAddr.set(address, {
              address,
              ok: true,
              txHash: sent.txHash,
              detail: `SeaDrop mintPublic x${q}`,
            });
          } else {
            byAddr.set(address, {
              address,
              ok: false,
              error: `x${q}:${sent.error}`,
            });
          }
        })
      );
    }

    if ([...byAddr.values()].filter((r) => r.ok).length === wallets.length) break;
    if (q === 1) break;
  }

  const results = [...byAddr.values()];
  const ok = results.filter((r) => r.ok);
  const summary = results
    .map((r) =>
      r.ok
        ? `${shortAddr(r.address)} OK ${r.txHash?.slice(0, 10)}… ${r.detail || ""}`
        : `${shortAddr(r.address)} FAIL (${r.error})`
    )
    .join(" | ");

  console.log(`[mint] SeaDrop done ok=${ok.length}/${wallets.length}`);

  return {
    hits: results,
    reason:
      ok.length > 0
        ? `SeaDrop minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`.slice(
            0,
            1200
          )
        : `SeaDrop mintPublic failed: ${summary}`.slice(0, 500),
  };
}

async function mintOpenSea(
  purchase: NftPurchase,
  wallets: Wallet[]
): Promise<BatchMintResult> {
  if (wallets.length === 0) return { hits: [], reason: "no wallets left" };
  // Resolve slug + stage once, then mint all wallets in parallel at max qty.
  let shared: Awaited<ReturnType<typeof prepareOpenSeaFreeMint>> | null = null;
  try {
    shared = await prepareOpenSeaFreeMint({
      collectionAddress: purchase.contract,
      minterAddress: wallets[0]!.address,
    });
  } catch (err) {
    return {
      hits: wallets.map((w) => ({
        address: w.address.toLowerCase(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })),
      reason: `OpenSea prepare failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const results = await Promise.all(
    wallets.map(async (wallet, index) => {
      if (index > 0) await sleep(Math.min(index * 20, 400));
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
          strategy: `OpenSeaDrop(${prepared.slug},x${prepared.quantity})`,
          contract: purchase.contract,
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
    hits: results.map((r) => ({
      address: r.address,
      ok: r.ok,
      txHash: r.ok ? r.txHash : undefined,
      detail: r.ok ? r.detail : undefined,
      error: r.ok ? undefined : r.error,
    })),
    reason:
      ok.length > 0
        ? `OpenSea minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `OpenSea mint failed: ${summary}`,
  };
}

async function mintPublicMax(
  wallets: Wallet[],
  targets: string[],
  whaleQty: number
): Promise<BatchMintResult> {
  if (wallets.length === 0) return { hits: [], reason: "no wallets left" };

  const uniqueTargets = [
    ...new Set(targets.map((t) => t.toLowerCase()).filter(Boolean)),
  ];

  const results = await Promise.all(
    wallets.map(async (wallet, index) => {
      if (index > 0) await sleep(Math.min(index * 20, 400));
      const address = wallet.address.toLowerCase();
      const errors: string[] = [];
      for (const to of uniqueTargets) {
        const candidates = buildPublicMaxMintCandidates({
          to,
          minter: wallet.address,
          whaleQuantity: whaleQty,
        });
        for (const c of candidates.slice(0, 6)) {
          const sent = await sendMintTx(wallet, {
            to: c.to,
            data: c.data,
            valueWei: 0n,
            strategy: `public:${c.label}`,
            contract: to,
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
    hits: results.map((r) => ({
      address: r.address,
      ok: r.ok,
      txHash: r.ok ? r.txHash : undefined,
      detail: r.ok ? r.detail : undefined,
      error: r.ok ? undefined : r.error,
    })),
    reason:
      ok.length > 0
        ? `Public max-minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `Public max-mint failed: ${summary}`,
  };
}

async function mintByReplay(
  wallets: Wallet[],
  targets: string | string[],
  rawData: string,
  whale: string,
  whaleQty: number
): Promise<BatchMintResult> {
  if (wallets.length === 0) return { hits: [], reason: "no wallets left" };

  const tos = [
    ...new Set(
      (Array.isArray(targets) ? targets : [targets])
        .map((t) => t.toLowerCase())
        .filter(Boolean)
    ),
  ];

  const results = await Promise.all(
    wallets.map(async (wallet, index) => {
      if (index > 0) await sleep(Math.min(index * 20, 400));
      return mintWithWallet(wallet, tos, rawData, whale, whaleQty);
    })
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

  const hits: WalletHit[] = results.map((r) => ({
    address: r.address,
    ok: !!r.ok,
    txHash: r.ok ? r.txHash : undefined,
    error: r.ok ? undefined : r.error,
  }));

  if (ok.length > 0) {
    return {
      hits,
      reason: `Website/tx replay minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`,
    };
  }

  const allWalletBound = fail.every((r) =>
    isWalletBoundFailure(r.error || "", primaryTo)
  );
  if (allWalletBound) {
    return {
      hits,
      reason:
        `Wallet-bound website mint (allowlist / signature tied to whale). ` +
        `Cannot copy without that site's mint API. (${wallets.length} wallet(s))`,
    };
  }

  return {
    hits,
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
    /** Optional diagnostics for logs */
    strategy?: string;
    tracker?: string;
    contract?: string;
  }
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  const trySend = async (
    provider: ReturnType<typeof getMintProvider>,
    label: string
  ): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> => {
    const connected = wallet.connect(provider);
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const from = await connected.getAddress();
        // ALWAYS use real eth_estimateGas — never a blind hardcoded hint.
        const estimated = await provider.estimateGas({
          from,
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
          `[mint:gas] strategy=${params.strategy || "?"} tracker=${(params.tracker || "").slice(0, 10) || "?"} ` +
            `contract=${(params.contract || params.to).slice(0, 12)}… ` +
            `fn=${mintSelectorLabel(params.data)} value=${params.valueWei} ` +
            `estimateGas=${estimated} ceiling=${resolved.ceiling} ` +
            `margin=${resolved.marginPct}% gasLimit=${resolved.ok ? resolved.gasLimit : 0} via=${label}`
        );

        if (!resolved.ok) {
          console.warn(
            `[mint:gas] REJECTED ${resolved.reason} strategy=${params.strategy || "?"}`
          );
          return { ok: false, error: resolved.reason };
        }

        const fee = await provider.getFeeData();
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
          gasLimit: resolved.gasLimit,
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
          `[mint] sending via ${label} strategy=${params.strategy || "?"} from=${from.slice(0, 8)}… ` +
            `to=${params.to.slice(0, 10)}… gasLimit=${resolved.gasLimit} (est ${estimated})`
        );
        const sent = await withWalletNonce({
          address: from,
          provider,
          fn: async (nonce) =>
            connected.sendTransaction({ ...txRequest, nonce }),
        });
        console.log(`[mint] broadcast ${sent.hash}`);

        void sent.wait().catch(() => undefined);
        return { ok: true, txHash: sent.hash };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (/nonce|already known|replacement/i.test(errMsg)) {
          invalidateWalletNonce(wallet.address);
        }
        const waitMs = parseTryAgainMs(err);
        if (waitMs != null && attempt < maxAttempts - 1) {
          console.warn(
            `[mint] ${label} RPS/throttle — retry in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`
          );
          await sleep(waitMs);
          continue;
        }
        if (classifyRpcError(err) && waitMs == null) {
          void reportMintRpcIssue(err);
        } else if (classifyRpcError(err) && attempt === maxAttempts - 1) {
          void reportMintRpcIssue(err);
        }
        return { ok: false, error: shortError(err) };
      }
    }
    return { ok: false, error: "send failed" };
  };

  const primary = await trySend(getMintProvider(), "chainstack");
  if (primary.ok) return primary;

  const backup = getMintBackupProvider();
  const err = primary.error || "";
  const networkish =
    /timeout|econn|socket|502|503|504|unavailable|rate limit|429|quota|capacity|rps/i.test(
      err
    );
  if (backup && networkish) {
    console.warn(`[mint] primary mint RPC failed (${err}) — trying backup`);
    return trySend(backup, "backup");
  }
  return primary;
}

/** Parse Chainstack/Alchemy try_again_in (ms). */
function parseTryAgainMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    !/-32005|rps limit|try_again_in|too many requests|rate limit|429/.test(lower)
  ) {
    return null;
  }
  const m = msg.match(/try_again_in["\s:]*([0-9.]+)\s*ms/i);
  if (m) {
    const ms = Math.ceil(Number(m[1]));
    if (Number.isFinite(ms) && ms > 0) return Math.min(Math.max(ms, 50), 2_000);
  }
  return 350;
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
        strategy: `replay:v${index + 1}`,
        tracker: whale,
        contract: to,
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
  const lower = msg.toLowerCase();
  if (msg.includes("execution reverted") || /\breverted\b/i.test(msg)) {
    return "reverted";
  }
  if (/-32005|rps limit|try_again_in|exceeded the rps|too many requests/.test(lower)) {
    return "rps-limited";
  }
  if (/missing revert data|could not coalesce/i.test(msg)) {
    return "rpc-coalesce/revert";
  }
  if (lower.includes("nonce has already been used") || lower.includes("already known")) {
    return "nonce already used (tx likely already broadcast)";
  }
  if (lower.includes("nonce too low")) {
    return "nonce too low";
  }
  if (msg.includes("insufficient funds")) {
    return "insufficient funds";
  }
  if (lower.includes("fully minted") || lower.includes("sold out")) {
    return "sold out";
  }
  // Never dump raw tx hex into Telegram reasons.
  return msg
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/0x[0-9a-fA-F]{48,}/g, "0x…")
    .slice(0, 140);
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
