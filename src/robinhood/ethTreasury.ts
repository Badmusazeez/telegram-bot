import {
  Wallet,
  formatEther,
  isAddress,
  parseEther,
  type JsonRpcProvider,
} from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import {
  getAllMintWallets,
  getMintProvider,
  getWallet,
} from "./provider";
import {
  withWalletNonce,
  warmWalletNonce,
  invalidateWalletNonce,
} from "./nonceManager";
import { clearWalletReadinessCache } from "./walletReady";
import { classifyRpcError } from "./rpcHealth";
import { reportMintRpcIssue } from "./mintRpcAlerts";

/** Leave this much ETH on source wallets after consolidate (covers gas). */
export const CONSOLIDATE_DUST_WEI = 80_000_000_000_000n; // 0.00008 ETH
const TRANSFER_GAS_LIMIT = 21_000n;

export type EthMoveWalletResult = {
  address: string;
  ok: boolean;
  txHash?: string;
  valueWei?: bigint;
  error?: string;
};

export type EthMoveResult = {
  dryRun: boolean;
  success: boolean;
  action: "consolidate" | "disburse";
  from?: string;
  to?: string;
  amountEachWei?: bigint;
  reason: string;
  results: EthMoveWalletResult[];
};

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/transaction=["']?0x[0-9a-fA-F]+["']?/gi, "transaction=<hex>")
    .replace(/0x[0-9a-fA-F]{48,}/g, "0x…")
    .slice(0, 160);
}

async function feeFields(provider: JsonRpcProvider): Promise<{
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  tipWei: bigint;
}> {
  const fee = await provider.getFeeData().catch(() => null);
  if (fee?.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
    const maxFeePerGas = (fee.maxFeePerGas * 130n) / 100n;
    const maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * 130n) / 100n;
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      tipWei: maxFeePerGas,
    };
  }
  if (fee?.gasPrice != null) {
    const gasPrice = (fee.gasPrice * 130n) / 100n;
    return { gasPrice, tipWei: gasPrice };
  }
  // Fallback ~0.1 gwei
  const gasPrice = 100_000_000n;
  return { gasPrice, tipWei: gasPrice };
}

/**
 * Funding / treasury wallet for disburse.
 * Prefers FUNDING_PRIVATE_KEY, else first mint wallet.
 */
export function getFundingWallet(): Wallet | null {
  const provider = getMintProvider();
  if (config.fundingPrivateKey) {
    try {
      return new Wallet(config.fundingPrivateKey, provider);
    } catch {
      return null;
    }
  }
  return getWallet()?.connect(provider) ?? null;
}

export function parseEthAmount(raw: string): bigint | null {
  const t = raw.trim().toLowerCase().replace(/eth$/, "").trim();
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  try {
    const wei = parseEther(t);
    if (wei <= 0n) return null;
    return wei;
  } catch {
    return null;
  }
}

async function sendNative(params: {
  from: Wallet;
  to: string;
  valueWei: bigint;
}): Promise<EthMoveWalletResult> {
  const provider = getMintProvider();
  const connected = params.from.connect(provider);
  const address = params.from.address.toLowerCase();
  const to = params.to.toLowerCase();

  try {
    await warmWalletNonce(address, provider);
    const fees = await feeFields(provider);
    const sent = await withWalletNonce({
      address,
      provider,
      fn: async (nonce) => {
        const tx: {
          to: string;
          value: bigint;
          gasLimit: bigint;
          nonce: number;
          chainId: number;
          maxFeePerGas?: bigint;
          maxPriorityFeePerGas?: bigint;
          gasPrice?: bigint;
        } = {
          to,
          value: params.valueWei,
          gasLimit: TRANSFER_GAS_LIMIT,
          nonce,
          chainId: Number(config.chain.chainId),
        };
        if (fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null) {
          tx.maxFeePerGas = fees.maxFeePerGas;
          tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
        } else if (fees.gasPrice != null) {
          tx.gasPrice = fees.gasPrice;
        }
        return connected.sendTransaction(tx);
      },
    });
    return {
      address,
      ok: true,
      txHash: sent.hash,
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
 * Sweep ETH from mint wallets → destination (default: funding / wallet #1).
 * Leaves dust for gas on each source.
 */
export async function runConsolidate(options: {
  toAddress?: string;
  onProgress?: (line: string) => void | Promise<void>;
} = {}): Promise<EthMoveResult> {
  clearWalletReadinessCache();
  const state = getState();
  const provider = getMintProvider();
  const funding = getFundingWallet();
  const toRaw = (options.toAddress || funding?.address || "").toLowerCase();

  if (!toRaw || !isAddress(toRaw)) {
    return {
      dryRun: state.dryRun,
      success: false,
      action: "consolidate",
      reason:
        "No destination. Pass /consolidate 0xAddress or set FUNDING_PRIVATE_KEY / mint key #1.",
      results: [],
    };
  }
  const to = toRaw;

  const sources = getAllMintWallets().filter(
    (w) => w.address.toLowerCase() !== to
  );
  if (sources.length === 0) {
    return {
      dryRun: state.dryRun,
      success: false,
      action: "consolidate",
      to,
      reason: "No source mint wallets (need ≥2 keys, destination excluded).",
      results: [],
    };
  }

  const fees = await feeFields(provider);
  const gasCost = TRANSFER_GAS_LIMIT * fees.tipWei;
  const keep = CONSOLIDATE_DUST_WEI + gasCost;

  if (options.onProgress) {
    await options.onProgress(
      `🧹 Consolidate → ${to.slice(0, 10)}… · ` +
        `${sources.length} source(s) · leave ~${formatEther(keep)} ETH dust`
    );
  }

  const plan: Array<{ wallet: Wallet; valueWei: bigint; bal: bigint }> = [];
  for (const w of sources) {
    const bal = await provider.getBalance(w.address);
    if (bal <= keep) continue;
    plan.push({ wallet: w, valueWei: bal - keep, bal });
  }

  if (plan.length === 0) {
    return {
      dryRun: state.dryRun,
      success: false,
      action: "consolidate",
      to,
      reason: `Nothing to sweep — all sources ≤ dust+gas (~${formatEther(keep)} ETH).`,
      results: sources.map((w) => ({
        address: w.address.toLowerCase(),
        ok: false,
        error: "balance too low after dust reserve",
      })),
    };
  }

  if (state.dryRun) {
    const total = plan.reduce((s, p) => s + p.valueWei, 0n);
    return {
      dryRun: true,
      success: true,
      action: "consolidate",
      to,
      reason:
        `DRY RUN — would sweep ${plan.length} wallet(s) → ${to.slice(0, 10)}… ` +
        `total ~${formatEther(total)} ETH. /dryrun off to go live.`,
      results: plan.map((p) => ({
        address: p.wallet.address.toLowerCase(),
        ok: true,
        valueWei: p.valueWei,
      })),
    };
  }

  const results = await Promise.all(
    plan.map((p) =>
      sendNative({ from: p.wallet, to, valueWei: p.valueWei })
    )
  );
  const wins = results.filter((r) => r.ok);
  const total = wins.reduce((s, r) => s + (r.valueWei ?? 0n), 0n);

  return {
    dryRun: false,
    success: wins.length > 0,
    action: "consolidate",
    to,
    reason:
      wins.length > 0
        ? `Consolidated ${wins.length}/${plan.length} → ${to.slice(0, 10)}… (~${formatEther(total)} ETH broadcast)`
        : `Consolidate failed: 0/${plan.length} sends`,
    results,
  };
}

/**
 * Send `amountEach` ETH from funding wallet to target mint wallets.
 */
export async function runDisburse(options: {
  amountEachWei: bigint;
  /** Target addresses (lowercase). Empty / omit = all mint wallets except funding. */
  targets?: string[];
  onProgress?: (line: string) => void | Promise<void>;
}): Promise<EthMoveResult> {
  clearWalletReadinessCache();
  const state = getState();
  const provider = getMintProvider();
  const funding = getFundingWallet();

  if (!funding) {
    return {
      dryRun: state.dryRun,
      success: false,
      action: "disburse",
      reason:
        "No funding wallet. Set FUNDING_PRIVATE_KEY or configure mint wallet #1.",
      results: [],
    };
  }

  const from = funding.address.toLowerCase();
  const all = getAllMintWallets();
  let targets: Wallet[];

  if (options.targets && options.targets.length > 0) {
    const want = new Set(options.targets.map((a) => a.toLowerCase()));
    targets = all.filter((w) => want.has(w.address.toLowerCase()));
    // Allow disbursing to addresses that are mint wallets only
    const missing = [...want].filter(
      (a) => !all.some((w) => w.address.toLowerCase() === a)
    );
    if (missing.length) {
      return {
        dryRun: state.dryRun,
        success: false,
        action: "disburse",
        from,
        amountEachWei: options.amountEachWei,
        reason: `Not your mint key(s): ${missing
          .map((a) => a.slice(0, 10) + "…")
          .join(", ")}`,
        results: [],
      };
    }
  } else {
    targets = all.filter((w) => w.address.toLowerCase() !== from);
  }

  // Never send to self
  targets = targets.filter((w) => w.address.toLowerCase() !== from);

  if (targets.length === 0) {
    return {
      dryRun: state.dryRun,
      success: false,
      action: "disburse",
      from,
      amountEachWei: options.amountEachWei,
      reason:
        "No target wallets (funding wallet is excluded; add more mint keys).",
      results: [],
    };
  }

  const fees = await feeFields(provider);
  const gasPerTx = TRANSFER_GAS_LIMIT * fees.tipWei;
  const need =
    options.amountEachWei * BigInt(targets.length) +
    gasPerTx * BigInt(targets.length) +
    CONSOLIDATE_DUST_WEI;
  const bal = await provider.getBalance(from);

  if (options.onProgress) {
    await options.onProgress(
      `💸 Disburse ${formatEther(options.amountEachWei)} ETH × ` +
        `${targets.length} → from ${from.slice(0, 10)}… ` +
        `(bal ${formatEther(bal)} ETH)`
    );
  }

  if (bal < need) {
    return {
      dryRun: state.dryRun,
      success: false,
      action: "disburse",
      from,
      amountEachWei: options.amountEachWei,
      reason:
        `Funding wallet low: have ${formatEther(bal)} ETH, need ~${formatEther(need)} ETH ` +
        `(${targets.length}×${formatEther(options.amountEachWei)} + gas).`,
      results: [],
    };
  }

  if (state.dryRun) {
    return {
      dryRun: true,
      success: true,
      action: "disburse",
      from,
      amountEachWei: options.amountEachWei,
      reason:
        `DRY RUN — would send ${formatEther(options.amountEachWei)} ETH to ` +
        `${targets.length} wallet(s) from ${from.slice(0, 10)}…. /dryrun off to go live.`,
      results: targets.map((w) => ({
        address: w.address.toLowerCase(),
        ok: true,
        valueWei: options.amountEachWei,
      })),
    };
  }

  // Sequential from funding wallet (shared nonce)
  const results: EthMoveWalletResult[] = [];
  for (const w of targets) {
    const sent = await sendNative({
      from: funding,
      to: w.address,
      valueWei: options.amountEachWei,
    });
    // Attribute result to recipient for clearer Telegram output
    results.push({
      ...sent,
      address: w.address.toLowerCase(),
    });
    if (options.onProgress) {
      await options.onProgress(
        sent.ok
          ? `✅ ${w.address.slice(0, 10)}… ${formatEther(options.amountEachWei)} ETH · ${sent.txHash?.slice(0, 12)}…`
          : `❌ ${w.address.slice(0, 10)}… ${sent.error}`
      );
    }
  }

  const wins = results.filter((r) => r.ok);
  return {
    dryRun: false,
    success: wins.length > 0,
    action: "disburse",
    from,
    amountEachWei: options.amountEachWei,
    reason:
      wins.length > 0
        ? `Disbursed ${formatEther(options.amountEachWei)} ETH to ${wins.length}/${targets.length} wallet(s)`
        : `Disburse failed: 0/${targets.length} sends`,
    results,
  };
}

/** Parse `/disburse <amount> [wallet args…]` → amount + remaining wallet raw. */
export function parseDisburseArgs(raw: string): {
  amountWei: bigint;
  walletRaw: string;
} | null {
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(/\s+/).filter(Boolean);
  const amountWei = parseEthAmount(parts[0]!);
  if (amountWei == null) return null;
  return {
    amountWei,
    walletRaw: parts.slice(1).join(" "),
  };
}
