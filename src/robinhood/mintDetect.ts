import { formatEther } from "ethers";
import { isSeaDropAddress } from "./seaDrop";
import { mintSelectorLabel } from "./mintGas";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000";

/** Common free-mint / claim selectors on Robinhood + EVM. */
export const MINT_SELECTORS = new Set([
  "0x161ac21f", // SeaDrop mintPublic
  "0x9b4f3f25",
  "0x26db764c",
  "0xa0712d68", // mint(uint256)
  "0x94bf804d",
  "0x40c10f19", // mint(address,uint256)
  "0x1249c58b", // mint()
  "0x8ab53447", // mintFree() — Wrong Bird cadence mints
  "0x2db11544", // claim?
  "0x4a21a2df", // legacy scatter (detect only)
  "0x6a627842", // mint(address)
  "0xa0712d68",
  "0x84bb1e42", // claim(address,uint256,...) common
  "0x1e83409a", // claim(address)
  "0x3593564c", // execute (router / multicall-ish — only if method name says mint)
  "0xba41b0c6", // mint(uint256,bytes32[]) — Outlaws-style public/WL free mint
  "0xd2b4b861", // common mintWithProof variants (seen on custom drops)
]);

/** Selectors that are clearly NOT freemints — never copy (unless Transfer-confirmed free mint). */
export const NON_MINT_SELECTORS = new Set([
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom
  "0x42842e0e", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde", // safeTransferFrom(+data)
  "0x095ea7b3", // approve
  "0xa22cb465", // setApprovalForAll
  "0x39509351", // increaseAllowance
  "0xf2fde38b", // transferOwnership
  "0x8da5cb5b", // owner()
]);

export type DecodedMintTx = {
  isMint: boolean;
  confidence: "high" | "medium" | "low" | "none";
  selector: string;
  functionLabel: string;
  to: string;
  nftContract: string | null;
  valueWei: bigint;
  data: string;
  reason: string;
};

export function decodeNftFromMintCalldata(input?: string): string | null {
  const data = (input || "").toLowerCase();
  if (data.length < 10 + 64) return null;
  const selector = data.slice(0, 10);
  if (selector === "0x161ac21f" || selector === "0x9b4f3f25") {
    return `0x${data.slice(10 + 24, 10 + 64)}`;
  }
  return null;
}

export function isMintLikeCalldata(
  to: string | null | undefined,
  data: string | null | undefined,
  methodName?: string,
  valueWei?: bigint
): boolean {
  const value = valueWei ?? 0n;
  return classifyMintCalldata(to, data, methodName, value, {
    // Only treat unknown selectors as mint when caller passed an explicit 0 value.
    acceptUnknownZeroValue: valueWei !== undefined && valueWei === 0n,
  }).isMint;
}

export function isClearNonMintSelector(selector: string): boolean {
  return NON_MINT_SELECTORS.has((selector || "").toLowerCase().slice(0, 10));
}

/**
 * Sharper mint classifier — rejects transfers/approvals; accepts SeaDrop,
 * known mint selectors, method names containing mint/claim/drop, and
 * (optionally) any other 0-value contract call as a custom free-mint candidate.
 */
export function classifyMintCalldata(
  to: string | null | undefined,
  data: string | null | undefined,
  methodName?: string,
  valueWei: bigint = 0n,
  opts?: { acceptUnknownZeroValue?: boolean }
): DecodedMintTx {
  const raw = (data || "").toLowerCase();
  const selector = raw.slice(0, 10) || "0x";
  const toAddr = (to || "").toLowerCase();
  const method = (methodName || "").toLowerCase();
  const functionLabel = mintSelectorLabel(raw) || method || selector;

  const base = {
    selector,
    functionLabel,
    to: toAddr,
    nftContract: decodeNftFromMintCalldata(raw),
    valueWei,
    data: raw,
  };

  if (!raw || raw === "0x") {
    return {
      ...base,
      isMint: false,
      confidence: "none",
      reason: "empty calldata",
    };
  }

  if (NON_MINT_SELECTORS.has(selector)) {
    return {
      ...base,
      isMint: false,
      confidence: "none",
      reason: `non-mint selector ${selector}`,
    };
  }

  if (isSeaDropAddress(toAddr) || selector === "0x161ac21f" || selector === "0x9b4f3f25") {
    return {
      ...base,
      isMint: true,
      confidence: "high",
      nftContract: base.nftContract || null,
      reason: "SeaDrop mintPublic",
    };
  }

  if (
    method.includes("mint") ||
    method.includes("claim") ||
    method.includes("drop")
  ) {
    return {
      ...base,
      isMint: true,
      confidence: "high",
      reason: `method ${method}`,
    };
  }

  if (MINT_SELECTORS.has(selector)) {
    return {
      ...base,
      isMint: true,
      confidence: "medium",
      reason: `known mint selector ${selector}`,
    };
  }

  // Custom public / WL free-mint candidate (opt-in): unknown 0-value call.
  if (opts?.acceptUnknownZeroValue && valueWei === 0n) {
    return {
      ...base,
      isMint: true,
      confidence: "low",
      reason: `custom 0-value call ${selector} (free-mint candidate)`,
    };
  }

  return {
    ...base,
    isMint: false,
    confidence: "none",
    reason: "unknown interaction — not classified as mint",
  };
}

export function valueFromWei(raw?: string | bigint | null): number {
  if (raw === undefined || raw === null || raw === "" || raw === "0" || raw === 0n) {
    return 0;
  }
  try {
    const v = typeof raw === "bigint" ? raw : BigInt(raw);
    return Number(formatEther(v));
  } catch {
    return 0;
  }
}

export function httpRpcToWss(rpcUrl: string): string {
  const url = (rpcUrl || "").trim();
  if (!url) return url;
  // Chainstack HTTP: https://host/<token> → WSS: wss://host/ws/<token>
  if (/chainstack\.com/i.test(url)) {
    return url
      .replace(/^https:/i, "wss:")
      .replace(/^http:/i, "ws:")
      .replace(/^(wss?:\/\/[^/?#]+)\/(?!ws\/)([^/?#]+)(\?.*)?$/i, "$1/ws/$2$3");
  }
  return url.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
}
