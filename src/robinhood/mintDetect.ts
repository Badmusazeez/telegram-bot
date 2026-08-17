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
  "0x2db11544", // claim?
  "0x4a21a2df", // legacy scatter (detect only)
  "0x6a627842", // mint(address)
  "0xa0712d68",
  "0x84bb1e42", // claim(address,uint256,...) common
  "0x1e83409a", // claim(address)
  "0x3593564c", // execute (router / multicall-ish — only if method name says mint)
]);

/** Selectors that are clearly NOT freemints — never copy. */
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
  methodName?: string
): boolean {
  return classifyMintCalldata(to, data, methodName).isMint;
}

/**
 * Sharper mint classifier — rejects transfers/approvals; accepts SeaDrop,
 * known mint selectors, and method names containing mint/claim/drop.
 */
export function classifyMintCalldata(
  to: string | null | undefined,
  data: string | null | undefined,
  methodName?: string,
  valueWei: bigint = 0n
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

  // Heuristic: calldata mentions "mint" in ASCII (rare) — skip.
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
  return rpcUrl
    .replace(/^https:/i, "wss:")
    .replace(/^http:/i, "ws:");
}
