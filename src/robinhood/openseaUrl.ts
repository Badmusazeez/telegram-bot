import { isAddress } from "ethers";

export type OpenSeaAssetRef = {
  chain: string;
  contract: string;
  tokenId?: string;
  url: string;
};

/**
 * Parse OpenSea asset links like:
 * https://opensea.io/assets/robinhood/0xabc.../374
 * https://opensea.io/assets/ethereum/0xabc.../1
 * opensea.io/item/robinhood/0xabc/374 (newer style)
 */
export function parseOpenSeaAssetUrl(raw: string): OpenSeaAssetRef | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "opensea.io") {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  // /assets/{chain}/{contract}/{tokenId}
  // /item/{chain}/{contract}/{tokenId}
  if (
    parts.length >= 3 &&
    (parts[0] === "assets" || parts[0] === "item")
  ) {
    const chain = parts[1].toLowerCase();
    const contract = parts[2];
    const tokenId = parts[3];
    if (!isAddress(contract)) {
      return null;
    }
    return {
      chain,
      contract: contract.toLowerCase(),
      tokenId: tokenId || undefined,
      url: url.toString(),
    };
  }

  return null;
}
