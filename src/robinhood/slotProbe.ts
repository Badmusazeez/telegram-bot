import { Interface, type JsonRpcProvider } from "ethers";

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

  for (const c of OPEN_CANDIDATES) {
    const raw = await callUint(provider, to, c.name);
    if (raw == null) continue;
    const opensAtMs = normalizeTimestampMs(raw, nowMs);
    if (opensAtMs == null) continue;

    let endsAtMs: number | null = null;
    for (const endFn of END_CANDIDATES) {
      const endRaw = await callUint(provider, to, endFn);
      if (endRaw == null) continue;
      const endMs = normalizeTimestampMs(endRaw, nowMs);
      // Ignore end times that are not after the open time.
      if (endMs != null && endMs > opensAtMs) {
        endsAtMs = endMs;
        break;
      }
    }

    const isFuture = opensAtMs > nowMs + 250;
    const ended = endsAtMs != null && endsAtMs <= nowMs;
    const isOpen = !isFuture && !ended;

    return {
      hasTiming: true,
      source: c.source,
      opensAtMs,
      endsAtMs,
      rawValue: raw,
      isFuture,
      isOpen,
      detail: `${c.source}=${new Date(opensAtMs).toISOString()}${
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

/** Classify a revert / error as LOST_RACE vs too-early vs other. */
export function classifyMintFailure(error: string): {
  kind: "LOST_RACE" | "TOO_EARLY" | "SOLD_OUT" | "OTHER";
  reason: string;
} {
  const lower = (error || "").toLowerCase();
  if (
    /too early|not started|not live|before start|wait until|nextfreeat|next mint|cooldown|not yet/i.test(
      lower
    )
  ) {
    return { kind: "TOO_EARLY", reason: error.slice(0, 160) };
  }
  if (
    /sold out|fully minted|exceeds max|max supply|no tokens left|insufficient supply/i.test(
      lower
    )
  ) {
    return { kind: "SOLD_OUT", reason: error.slice(0, 160) };
  }
  if (
    /already (claimed|minted|claimed)|claimed already|not your (turn|slot)|slot (taken|consumed)|someone else|lost.?race|cannot claim|claim closed|transfer.*failed/i.test(
      lower
    ) ||
    (/reverted/.test(lower) && /slot|freeat|cooldown|occupied/.test(lower))
  ) {
    return {
      kind: "LOST_RACE",
      reason: "another transaction consumed the slot",
    };
  }
  // Generic revert right after a slot window often means lost race on claim machines.
  if (/^reverted$|execution reverted|rpc-coalesce\/revert/i.test(lower.trim())) {
    return {
      kind: "LOST_RACE",
      reason: "another transaction consumed the slot (or stage rejected)",
    };
  }
  return { kind: "OTHER", reason: error.slice(0, 160) };
}
