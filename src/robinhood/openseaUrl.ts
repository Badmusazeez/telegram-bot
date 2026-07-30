import { isAddress } from "ethers";

export type OpenSeaLinkRef = {
  kind: "asset" | "collection";
  chain?: string;
  contract?: string;
  tokenId?: string;
  collectionSlug?: string;
  url: string;
};

/**
 * Parse OpenSea links:
 * - https://opensea.io/assets/robinhood/0xabc.../374
 * - https://opensea.io/item/robinhood/0xabc.../374
 * - https://opensea.io/collection/cool-cats
 */
export function parseOpenSeaAssetUrl(raw: string): OpenSeaLinkRef | null {
  return parseOpenSeaUrl(raw);
}

export function parseOpenSeaUrl(raw: string): OpenSeaLinkRef | null {
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

  if (parts[0] === "collection" && parts[1]) {
    return {
      kind: "collection",
      collectionSlug: parts[1],
      url: url.toString(),
    };
  }

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
      kind: "asset",
      chain,
      contract: contract.toLowerCase(),
      tokenId: tokenId || undefined,
      url: url.toString(),
    };
  }

  return null;
}
