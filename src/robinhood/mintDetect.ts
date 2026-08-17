import { formatEther } from "ethers";
import { isSeaDropAddress } from "./seaDrop";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000";

/** Common free-mint selectors on Robinhood. */
export const MINT_SELECTORS = new Set([
  "0x161ac21f", // SeaDrop mintPublic
  "0x9b4f3f25",
  "0x26db764c",
  "0xa0712d68", // mint(uint256)
  "0x94bf804d",
  "0x40c10f19",
  "0x1249c58b", // mint()
  "0x2db11544",
  "0x4a21a2df", // legacy scatter selector (detect only)
]);

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
  const method = (methodName || "").toLowerCase();
  if (
    method.includes("mint") ||
    method.includes("claim") ||
    method.includes("drop")
  ) {
    return true;
  }
  if (isSeaDropAddress(to || "")) return true;
  const sel = (data || "").slice(0, 10).toLowerCase();
  return MINT_SELECTORS.has(sel);
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
