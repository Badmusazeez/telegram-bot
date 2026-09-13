import { Interface, formatEther, id, type Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import { getAllMintWallets, getMintProvider } from "./provider";
import { withWalletNonce, invalidateWalletNonce, warmWalletNonce } from "./nonceManager";
import { checkMintWalletReadiness, clearWalletReadinessCache } from "./walletReady";
import { classifyRpcError } from "./rpcHealth";
import { reportMintRpcIssue } from "./mintRpcAlerts";
import { recordMintSession } from "../store/botStats";
import {
  buildMintResultStats,
  classifyMintError,
  formatMintResultStats,
  type MintWalletOutcome,
} from "./mintResultReport";

/** The Unwritten — paid acquire lane (fast). Decipher/PoW is browser-only. */
export const UNWRITTEN = {
  contract: "0xcc840af97a2b4ba57410ebc48f2c736f8dacef82",
  name: "The Unwritten",
  slug: "the-unwritten-547251270",
  openSeaUrl: "https://opensea.io/collection/the-unwritten-547251270",
  siteUrl: "https://theunwritten.xyz/",
  maxSupply: 8888,
} as const;

const IFACE = new Interface([
  "function totalMinted() view returns (uint256)",
  "function nextOpenBlock() view returns (uint256)",
  "function priceOf(uint256 depth) view returns (uint256)",
  "function expectedHashes(uint256 depth) view returns (uint256)",
  "function acquire(uint256 maxPrice) payable returns (uint256)",
]);

export const ACQUIRE_SELECTOR = id("acquire(uint256)").slice(0, 10);

/** Site uses +2% headroom so a small price bump doesn't revert. */
export const ACQUIRE_SLIPPAGE_BPS = 10200n; // 102%

export type UnwrittenAcquireOptions = {
  walletFilter?: "all" | string | string[];
  /** Extra slippage bps over on-chain price (default 200 = +2%). */
  slippageBps?: number;
  onProgress?: (line: string) => void | Promise<void>;
};

export type UnwrittenWalletResult = {
  address: string;
  ok: boolean;
  txHash?: string;
  tokenId?: number;
  gasLimit?: bigint;
  valueWei?: bigint;
  error?: string;
};

export type UnwrittenAcquireResult = {
  dryRun: boolean;
  success: boolean;
  contract: string;
  name: string;
  openSeaUrl: string;
  siteUrl: string;
  depth: number;
  priceWei: bigint;
  valueWei: bigint;
  reason: string;
  results: UnwrittenWalletResult[];
  statsText?: string;
};

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/0x[0-9a-fA-F]{48,}/g, "0x…")
    .slice(0, 160);
}

function normalizeWalletFilter(
  filter: UnwrittenAcquireOptions["walletFilter"]
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

export function computeAcquireValue(
  priceWei: bigint,
  slippageBps = 200
): bigint {
  // price * (10000 + slippageBps) / 10000 — matches site's * 102/100 when bps=200
  const bps = 10_000n + BigInt(Math.max(0, Math.floor(slippageBps)));
  return (priceWei * bps) / 10_000n;
}

export async function readUnwrittenMintState(provider = getMintProvider()): Promise<{
  depth: number;
  priceWei: bigint;
  expectedHashes: bigint;
  nextOpenBlock: number;
  tip: number;
  open: boolean;
  soldOut: boolean;
}> {
  const to = UNWRITTEN.contract;
  const [mintedRet, openRet, tip] = await Promise.all([
    provider.call({
      to,
      data: IFACE.encodeFunctionData("totalMinted", []),
    }),
    provider.call({
      to,
      data: IFACE.encodeFunctionData("nextOpenBlock", []),
    }),
    provider.getBlockNumber(),
  ]);
  const depth = Number(IFACE.decodeFunctionResult("totalMinted", mintedRet)[0]);
  const nextOpenBlock = Number(
    IFACE.decodeFunctionResult("nextOpenBlock", openRet)[0]
  );
  let priceWei = 0n;
  let expectedHashes = 0n;
  if (depth < UNWRITTEN.maxSupply) {
    const [priceRet, workRet] = await Promise.all([
      provider.call({
        to,
        data: IFACE.encodeFunctionData("priceOf", [BigInt(depth)]),
      }),
      provider.call({
        to,
        data: IFACE.encodeFunctionData("expectedHashes", [BigInt(depth)]),
      }),
    ]);
    priceWei = IFACE.decodeFunctionResult("priceOf", priceRet)[0] as bigint;
    expectedHashes = IFACE.decodeFunctionResult(
      "expectedHashes",
      workRet
    )[0] as bigint;
  }
  return {
    depth,
    priceWei,
    expectedHashes,
    nextOpenBlock,
    tip: Number(tip),
    open: Number(tip) >= nextOpenBlock,
    soldOut: depth >= UNWRITTEN.maxSupply,
  };
}

async function fireAcquire(params: {
  wallet: Wallet;
  valueWei: bigint;
  maxPrice: bigint;
}): Promise<UnwrittenWalletResult> {
  const provider = getMintProvider();
  const connected = params.wallet.connect(provider);
  const address = params.wallet.address.toLowerCase();
  const data = IFACE.encodeFunctionData("acquire", [params.maxPrice]);
  const gasLimit = 350_000n;

  try {
    await warmWalletNonce(address, provider);
    const fee = await provider.getFeeData().catch(() => null);
    const sent = await withWalletNonce({
      address,
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
          to: UNWRITTEN.contract,
          data,
          value: params.valueWei,
          gasLimit,
          nonce,
          chainId: Number(config.chain.chainId),
        };
        if (fee?.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
          tx.maxFeePerGas = (fee.maxFeePerGas * 130n) / 100n;
          tx.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * 130n) / 100n;
        } else if (fee?.gasPrice != null) {
          tx.gasPrice = (fee.gasPrice * 130n) / 100n;
        }
        return connected.sendTransaction(tx);
      },
    });
    return {
      address,
      ok: true,
      txHash: sent.hash,
      gasLimit,
      valueWei: params.valueWei,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/nonce/i.test(msg)) invalidateWalletNonce(address);
    if (classifyRpcError(err)) void reportMintRpcIssue(err);
    return { address, ok: false, error: shortErr(err), valueWei: params.valueWei };
  }
}

/**
 * Burst paid `acquire()` on The Unwritten — fastest lane (no PoW).
 * Each successful wallet mints the next sequential inscription.
 */
export async function runUnwrittenAcquire(
  options: UnwrittenAcquireOptions = {}
): Promise<UnwrittenAcquireResult> {
  clearWalletReadinessCache();
  const walletFilter = normalizeWalletFilter(options.walletFilter);
  const slippageBps = options.slippageBps ?? 200;
  const onProgress = options.onProgress;
  const state = getState();
  const provider = getMintProvider();

  const empty = (
    reason: string,
    extra?: Partial<UnwrittenAcquireResult>
  ): UnwrittenAcquireResult => ({
    dryRun: state.dryRun,
    success: false,
    contract: UNWRITTEN.contract,
    name: UNWRITTEN.name,
    openSeaUrl: UNWRITTEN.openSeaUrl,
    siteUrl: UNWRITTEN.siteUrl,
    depth: 0,
    priceWei: 0n,
    valueWei: 0n,
    reason,
    results: [],
    ...extra,
  });

  let mintState;
  try {
    mintState = await readUnwrittenMintState(provider);
  } catch (err) {
    return empty(`Failed to read mint state: ${shortErr(err)}`);
  }

  if (mintState.soldOut) {
    return empty("Sold out (8888/8888).", {
      depth: mintState.depth,
      priceWei: mintState.priceWei,
    });
  }
  if (!mintState.open) {
    return empty(
      `Public mint not open yet (nextOpenBlock ${mintState.nextOpenBlock}, tip ${mintState.tip}).`,
      { depth: mintState.depth, priceWei: mintState.priceWei }
    );
  }

  const valueWei = computeAcquireValue(mintState.priceWei, slippageBps);
  // Need price + ~0.0003 ETH gas headroom
  const minBalance = valueWei + 300_000_000_000_000n;

  const allConfigured = getAllMintWallets();
  if (allConfigured.length === 0) {
    return empty("No mint wallets. /addkey or PRIVATE_KEYS.", {
      depth: mintState.depth,
      priceWei: mintState.priceWei,
      valueWei,
    });
  }

  let picked = allConfigured;
  if (walletFilter !== "all") {
    const want = new Set(walletFilter);
    picked = allConfigured.filter((w) => want.has(w.address.toLowerCase()));
    const missing = walletFilter.filter(
      (a) => !allConfigured.some((w) => w.address.toLowerCase() === a)
    );
    if (missing.length) {
      return empty(
        `Not your mint key(s): ${missing.map((a) => a.slice(0, 10) + "…").join(", ")}`,
        { depth: mintState.depth, priceWei: mintState.priceWei, valueWei }
      );
    }
    if (picked.length === 0) {
      return empty("No matching mint keys.", {
        depth: mintState.depth,
        priceWei: mintState.priceWei,
        valueWei,
      });
    }
  }

  const readiness = await checkMintWalletReadiness(picked, { force: true });
  const funded = readiness.ready.filter((w) => {
    const row = readiness.all.find(
      (r) => r.address === w.address.toLowerCase()
    );
    return (row?.balanceWei ?? 0n) >= minBalance;
  });
  const underfunded = readiness.ready.filter((w) => !funded.includes(w));

  if (onProgress) {
    await onProgress(
      `📜 The Unwritten · depth ${mintState.depth}/8888 · ` +
        `price ${formatEther(mintState.priceWei)} ETH · ` +
        `send ${formatEther(valueWei)} ETH (+${slippageBps / 100}% slip) · ` +
        `${funded.length}/${picked.length} wallet(s) funded`
    );
  }

  if (funded.length === 0) {
    const need = formatEther(minBalance);
    return empty(
      `No wallet has ≥ ${need} ETH (price+slip+gas). ` +
        `${underfunded.length || readiness.empty.length + readiness.lowGas.length} short.`,
      {
        depth: mintState.depth,
        priceWei: mintState.priceWei,
        valueWei,
        results: underfunded.map((w) => ({
          address: w.address.toLowerCase(),
          ok: false,
          error: `need ≥ ${need} ETH`,
        })),
      }
    );
  }

  if (state.dryRun) {
    const outcomes: MintWalletOutcome[] = funded.map((w) => ({
      address: w.address.toLowerCase(),
      ok: true,
      bucket: "success" as const,
    }));
    const stats = buildMintResultStats({
      configured: picked.length,
      fundedReady: funded.length,
      empty: readiness.empty.length,
      lowGas: readiness.lowGas.length + underfunded.length,
      outcomes,
    });
    return {
      dryRun: true,
      success: true,
      contract: UNWRITTEN.contract,
      name: UNWRITTEN.name,
      openSeaUrl: UNWRITTEN.openSeaUrl,
      siteUrl: UNWRITTEN.siteUrl,
      depth: mintState.depth,
      priceWei: mintState.priceWei,
      valueWei,
      reason:
        `DRY RUN — would acquire() x${funded.length} wallet(s) @ ` +
        `${formatEther(valueWei)} ETH each (next Nº ${mintState.depth + 1}). ` +
        `/dryrun off to go live.\n\n${formatMintResultStats(stats)}`,
      results: funded.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
        valueWei,
      })),
      statsText: formatMintResultStats(stats),
    };
  }

  if (onProgress) {
    await onProgress(
      `🚀 Firing acquire() on ${funded.length} wallet(s) in parallel…`
    );
  }

  const results = await Promise.all(
    funded.map((wallet) =>
      fireAcquire({
        wallet,
        valueWei,
        maxPrice: valueWei,
      })
    )
  );

  const wins = results.filter((r) => r.ok);
  const outcomes: MintWalletOutcome[] = results.map((r) => ({
    address: r.address,
    ok: r.ok,
    txHash: r.ok ? r.txHash : undefined,
    error: r.ok ? undefined : r.error,
    bucket: r.ok ? "success" : classifyMintError(r.error),
  }));
  const stats = buildMintResultStats({
    configured: picked.length,
    fundedReady: funded.length,
    empty: readiness.empty.length,
    lowGas: readiness.lowGas.length + underfunded.length,
    outcomes,
  });
  const statsText = formatMintResultStats(stats);

  void recordMintSession({
    dryRun: false,
    success: wins.length > 0,
    attempted: true,
    okWallets: wins.length,
    failWallets: Math.max(0, funded.length - wins.length),
    gasUsedEstimate: results.reduce((s, r) => s + (r.gasLimit ?? 0n), 0n),
  });

  return {
    dryRun: false,
    success: wins.length > 0,
    contract: UNWRITTEN.contract,
    name: UNWRITTEN.name,
    openSeaUrl: UNWRITTEN.openSeaUrl,
    siteUrl: UNWRITTEN.siteUrl,
    depth: mintState.depth,
    priceWei: mintState.priceWei,
    valueWei,
    reason:
      (wins.length > 0
        ? `Acquire broadcast: ${wins.length}/${funded.length} wallet(s) submitted @ ${formatEther(valueWei)} ETH (from depth ${mintState.depth})`
        : `Acquire failed: 0/${funded.length} broadcasts`) +
      `\n\n${statsText}`,
    results,
    statsText,
  };
}
