import { Interface, type JsonRpcProvider } from "ethers";
import { analyzeMintFailure, classifyMintFailure } from "./failureAnalyze";

export { analyzeMintFailure, classifyMintFailure };

/**
 * Dynamically probe NFT/mint contracts for timing / slot view functions.
 * Does not assume nextFreeAt() exists — tries several common patterns.
 */

export type SlotProbeSource =
  | "nextFreeAt"
  | "nextMintTime"
  | "getNextMintTime"
  | "publicSaleStart"
  | "publicSaleStartTime"
  | "startTime"
  | "mintStart"
  | "claimStart"
  | "saleStart"
  | "phaseStart"
  | "none";

export type SlotProbeResult = {
  hasTiming: boolean;
  source: SlotProbeSource;
  /** Unix ms when the next/current window opens (if known). */
  opensAtMs: number | null;
  /** Unix ms when the window ends (if known). */
  endsAtMs: number | null;
  /** Raw uint from chain (seconds or ms — normalized to ms in opensAtMs). */
  rawValue: bigint | null;
  /** true if opensAtMs is in the future (armed wait needed). */
  isFuture: boolean;
  /** true if window appears open now. */
  isOpen: boolean;
  detail: string;
};

const VIEW_IFACE = new Interface([
  "function nextFreeAt() view returns (uint256)",
  "function nextMintTime() view returns (uint256)",
  "function getNextMintTime() view returns (uint256)",
  "function publicSaleStart() view returns (uint256)",
  "function publicSaleStartTime() view returns (uint256)",
  "function startTime() view returns (uint256)",
  "function mintStart() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function saleStart() view returns (uint256)",
  "function phaseStart() view returns (uint256)",
  "function endTime() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function mintEnd() view returns (uint256)",
]);

const OPEN_CANDIDATES: Array<{ name: string; source: SlotProbeSource }> = [
  { name: "nextFreeAt", source: "nextFreeAt" },
  { name: "nextMintTime", source: "nextMintTime" },
  { name: "getNextMintTime", source: "getNextMintTime" },
  { name: "publicSaleStart", source: "publicSaleStart" },
  { name: "publicSaleStartTime", source: "publicSaleStartTime" },
  { name: "startTime", source: "startTime" },
  { name: "mintStart", source: "mintStart" },
  { name: "claimStart", source: "claimStart" },
  { name: "saleStart", source: "saleStart" },
  { name: "phaseStart", source: "phaseStart" },
];

const END_CANDIDATES = ["endTime", "publicSaleEnd", "mintEnd"];

/** Normalize chain timestamp (sec or ms) to ms. */
export function normalizeTimestampMs(raw: bigint, nowMs = Date.now()): number | null {
  if (raw <= 0n) return null;
  // Heuristic: values that look like unix seconds (< year ~2100 in sec)
  // vs ms (13 digits).
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (raw < 1_000_000_000_000n) {
    // seconds
    return n * 1000;
  }
  if (raw < 10_000_000_000_000n) {
    // already ms
    return n;
  }
  // Absurdly large — ignore
  void nowMs;
  return null;
}

async function callUint(
  provider: JsonRpcProvider,
  to: string,
  fn: string
): Promise<bigint | null> {
  try {
    const data = VIEW_IFACE.encodeFunctionData(fn, []);
    const ret = await provider.call({ to, data });
    if (!ret || ret === "0x") return null;
    const decoded = VIEW_IFACE.decodeFunctionResult(fn, ret);
    const v = decoded[0] as bigint;
    return typeof v === "bigint" ? v : BigInt(v);
  } catch {
    return null;
  }
}

/**
 * Probe a contract for mint timing. Safe no-op when no view functions exist.
 */
export async function probeMintSlot(
  provider: JsonRpcProvider,
  contract: string,
  nowMs = Date.now()
): Promise<SlotProbeResult> {
  const to = contract.toLowerCase();
  if (!to.startsWith("0x") || to.length !== 42) {
    return {
      hasTiming: false,
      source: "none",
      opensAtMs: null,
      endsAtMs: null,
      rawValue: null,
      isFuture: false,
      isOpen: true,
      detail: "invalid contract",
    };
  }

  // Probe all timing views in parallel; keep OPEN_CANDIDATES priority order.
  const openHits = await Promise.all(
    OPEN_CANDIDATES.map(async (c) => {
      const raw = await callUint(provider, to, c.name);
      if (raw == null) return null;
      const opensAtMs = normalizeTimestampMs(raw, nowMs);
      if (opensAtMs == null) return null;
      return { c, raw, opensAtMs };
    })
  );
  const hit = openHits.find((h) => h != null);
  if (hit) {
    const endRaws = await Promise.all(
      END_CANDIDATES.map(async (endFn) => {
        const endRaw = await callUint(provider, to, endFn);
        if (endRaw == null) return null;
        return normalizeTimestampMs(endRaw, nowMs);
      })
    );
    let endsAtMs: number | null = null;
    for (const endMs of endRaws) {
      if (endMs != null && endMs > hit.opensAtMs) {
        endsAtMs = endMs;
        break;
      }
    }

    const isFuture = hit.opensAtMs > nowMs + 250;
    const ended = endsAtMs != null && endsAtMs <= nowMs;
    const isOpen = !isFuture && !ended;

    return {
      hasTiming: true,
      source: hit.c.source,
      opensAtMs: hit.opensAtMs,
      endsAtMs,
      rawValue: hit.raw,
      isFuture,
      isOpen,
      detail: `${hit.c.source}=${new Date(hit.opensAtMs).toISOString()}${
        endsAtMs ? ` end=${new Date(endsAtMs).toISOString()}` : ""
      }`,
    };
  }

  return {
    hasTiming: false,
    source: "none",
    opensAtMs: null,
    endsAtMs: null,
    rawValue: null,
    isFuture: false,
    isOpen: true,
    detail: "no timing views found — use immediate mint path",
  };
}
