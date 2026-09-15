/**
 * Classify mint wallet readiness for a single mint operation.
 * Caches balance results so the same mint doesn't re-query every wallet
 * repeatedly across strategies.
 */

import { formatEther, type Wallet } from "ethers";
import { getMintProvider } from "./provider";
import { getMintRpcGate } from "./rpcGate";

const MIN_GAS_WEI = 50_000_000_000_000n; // 0.00005 RH

export type WalletReadyKind =
  | "ready"
  | "empty"
  | "low_gas"
  | "ineligible"
  | "unknown";

export type WalletReadiness = {
  address: string;
  ready: boolean;
  kind: WalletReadyKind;
  balanceWei: bigint | null;
  balanceRh: string;
  reason?: string;
};

export type WalletReadinessReport = {
  configured: number;
  ready: Wallet[];
  empty: WalletReadiness[];
  lowGas: WalletReadiness[];
  unknown: WalletReadiness[];
  ineligible: WalletReadiness[];
  notReady: WalletReadiness[];
  all: WalletReadiness[];
};

type CacheEntry = {
  at: number;
  byAddr: Map<string, WalletReadiness>;
};

let opCache: CacheEntry | null = null;
const CACHE_MS = 45_000;

export function clearWalletReadinessCache(): void {
  opCache = null;
}

/**
 * Fast pre-flight for mint wallets. Caches within CACHE_MS for the mint window.
 * Does not drop wallets by itself — caller decides.
 */
export async function checkMintWalletReadiness(
  wallets: Wallet[],
  opts?: { force?: boolean; markIneligible?: string[] }
): Promise<WalletReadinessReport> {
  const now = Date.now();
  const provider = getMintProvider();
  const gate = getMintRpcGate();
  const ineligibleSet = new Set(
    (opts?.markIneligible || []).map((a) => a.toLowerCase())
  );

  const needFetch = wallets.filter((w) => {
    if (opts?.force || !opCache || now - opCache.at > CACHE_MS) return true;
    return !opCache.byAddr.has(w.address.toLowerCase());
  });

  if (needFetch.length > 0) {
    if (!opCache || now - opCache.at > CACHE_MS) {
      opCache = { at: now, byAddr: new Map() };
    }
    await Promise.all(
      needFetch.map(async (w) => {
        const address = w.address.toLowerCase();
        try {
          const balanceWei = await gate.run(() =>
            provider.getBalance(w.address)
          );
          let kind: WalletReadyKind = "ready";
          let ready = true;
          let reason: string | undefined;
          if (balanceWei === 0n) {
            kind = "empty";
            ready = false;
            reason = "empty wallet (0 balance)";
          } else if (balanceWei < MIN_GAS_WEI) {
            kind = "low_gas";
            ready = false;
            reason = "insufficient gas balance";
          }
          opCache!.byAddr.set(address, {
            address,
            ready,
            kind,
            balanceWei,
            balanceRh: formatEther(balanceWei),
            reason,
          });
        } catch {
          // Unknown — treat as ready so we don't skip a funded wallet on RPC flake.
          opCache!.byAddr.set(address, {
            address,
            ready: true,
            kind: "unknown",
            balanceWei: null,
            balanceRh: "?",
            reason: "balance check failed — attempting anyway",
          });
        }
      })
    );
  }

  const all: WalletReadiness[] = wallets.map((w) => {
    const address = w.address.toLowerCase();
    const base =
      opCache?.byAddr.get(address) ||
      ({
        address,
        ready: true,
        kind: "unknown" as const,
        balanceWei: null,
        balanceRh: "?",
        reason: "no balance data",
      } satisfies WalletReadiness);
    if (ineligibleSet.has(address)) {
      return {
        ...base,
        ready: false,
        kind: "ineligible" as const,
        reason: "not eligible / already minted",
      };
    }
    return base;
  });

  const ready = wallets.filter((w) => {
    const row = all.find((r) => r.address === w.address.toLowerCase());
    return row?.ready;
  });
  const empty = all.filter((r) => r.kind === "empty");
  const lowGas = all.filter((r) => r.kind === "low_gas");
  const unknown = all.filter((r) => r.kind === "unknown");
  const ineligible = all.filter((r) => r.kind === "ineligible");
  const notReady = all.filter((r) => !r.ready);

  return {
    configured: wallets.length,
    ready,
    empty,
    lowGas,
    unknown,
    ineligible,
    notReady,
    all,
  };
}

/** Back-compat shim used by older call sites expecting { funded, skippedEmpty }. */
export async function getFundedFromReadiness(
  wallets: Wallet[]
): Promise<{ funded: Wallet[]; skippedEmpty: number; report: WalletReadinessReport }> {
  const report = await checkMintWalletReadiness(wallets);
  return {
    funded: report.ready,
    skippedEmpty: report.empty.length + report.lowGas.length,
    report,
  };
}
