import { Interface } from "ethers";

/** Official OpenSea SeaDrop (Robinhood + other chains). */
export const SEADROP_ADDRESS =
  "0x00005ea00ac477b1030ce78506496e8c2de24bf5";

const SEADROP_IFACE = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
]);

const MINT_PUBLIC_SELECTOR = "0x161ac21f";

export function isSeaDropAddress(to: string | null | undefined): boolean {
  return (to || "").toLowerCase() === SEADROP_ADDRESS;
}

export function isSeaDropMintPublic(data: string | null | undefined): boolean {
  return (data || "").toLowerCase().startsWith(MINT_PUBLIC_SELECTOR);
}

export type SeaDropMintPublicArgs = {
  nftContract: string;
  feeRecipient: string;
  minterIfNotPayer: string;
  quantity: number;
};

/** Decode whale SeaDrop mintPublic calldata (ignores trailing junk). */
export function decodeSeaDropMintPublic(
  data: string
): SeaDropMintPublicArgs | null {
  const raw = data.toLowerCase();
  if (!raw.startsWith(MINT_PUBLIC_SELECTOR) || raw.length < 10 + 64 * 4) {
    return null;
  }
  try {
    // Parse only the 4-arg mintPublic prefix (ignore trailing bytes some explorers append).
    const trimmed = raw.slice(0, 10 + 64 * 4);
    const parsed = SEADROP_IFACE.parseTransaction({ data: trimmed });
    if (!parsed || parsed.name !== "mintPublic") return null;
    const qty = Number(parsed.args[3]);
    if (!Number.isFinite(qty) || qty < 1) return null;
    return {
      nftContract: String(parsed.args[0]).toLowerCase(),
      feeRecipient: String(parsed.args[1]).toLowerCase(),
      minterIfNotPayer: String(parsed.args[2]).toLowerCase(),
      quantity: Math.floor(qty),
    };
  } catch {
    return null;
  }
}

/**
 * Rebuild SeaDrop mintPublic for OUR wallet at a chosen quantity.
 * Does NOT need OpenSea API — works for public free stages.
 */
export function buildSeaDropMintPublicTx(params: {
  whaleData: string;
  minter: string;
  quantity: number;
}): { to: string; data: string; valueWei: bigint; nftContract: string } | null {
  const decoded = decodeSeaDropMintPublic(params.whaleData);
  if (!decoded) return null;
  const qty = Math.max(1, Math.min(Math.floor(params.quantity), 100));
  const data = SEADROP_IFACE.encodeFunctionData("mintPublic", [
    decoded.nftContract,
    decoded.feeRecipient,
    params.minter,
    BigInt(qty),
  ]);
  return {
    to: SEADROP_ADDRESS,
    data,
    valueWei: 0n,
    nftContract: decoded.nftContract,
  };
}
