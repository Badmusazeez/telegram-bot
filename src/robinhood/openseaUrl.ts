import { isAddress, getAddress } from "ethers";

export type OpenSeaLinkRef = {
  kind: "asset" | "collection" | "contract";
  chain?: string;
  contract?: string;
  tokenId?: string;
  collectionSlug?: string;
  url: string;
};

/**
 * Strip chat punctuation / wrapping quotes that break OpenSea URL parses.
 * e.g. "...0xdcd9….be." or "<url>" pasted from Telegram.
 */
export function normalizeOpenSeaInput(raw: string): string {
  let text = raw.trim();
  if (!text) return text;
  // Unwrap common wrappers
  if (
    (text.startsWith("<") && text.endsWith(">")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Trailing sentence punctuation (user: "...0xdcd9….be.")
  text = text.replace(/[.,;:!?)\]}>]+$/g, "").trim();
  return text;
}

/**
 * Parse OpenSea links:
 * - https://opensea.io/assets/robinhood/0xabc.../374
 * - https://opensea.io/assets/robinhood/0xabc...   (contract = collection)
 * - https://opensea.io/item/robinhood/0xabc.../374
 * - https://opensea.io/collection/cool-cats
 * - bare 0xContract (assumes Robinhood chain)
 */
export function parseOpenSeaAssetUrl(raw: string): OpenSeaLinkRef | null {
  return parseOpenSeaUrl(raw);
}

export function parseOpenSeaUrl(raw: string): OpenSeaLinkRef | null {
  const text = normalizeOpenSeaInput(raw);
  if (!text) {
    return null;
  }

  // Bare Robinhood contract address → treat as collection-by-contract
  if (/^0x[a-fA-F0-9]{40}$/.test(text) && isAddress(text)) {
    const contract = getAddress(text).toLowerCase();
    return {
      kind: "contract",
      chain: "robinhood",
      contract,
      url: `https://opensea.io/assets/robinhood/${contract}`,
    };
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

  // Clean trailing junk on path segments (e.g. contract. with period)
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((p) => p.replace(/[.,;:!?)\]}>]+$/g, ""));

  if (parts[0] === "collection" && parts[1]) {
    return {
      kind: "collection",
      collectionSlug: parts[1],
      url: url.toString().replace(/[.,;:!?)\]}>]+$/g, ""),
    };
  }

  if (
    parts.length >= 3 &&
    (parts[0] === "assets" || parts[0] === "item")
  ) {
    const chain = parts[1].toLowerCase();
    const contractRaw = parts[2];
    const tokenId = parts[3] || undefined;
    if (!isAddress(contractRaw)) {
      return null;
    }
    const contract = getAddress(contractRaw).toLowerCase();
    // Contract-only (no token id) is how OpenSea often links a whole collection.
    if (!tokenId) {
      return {
        kind: "contract",
        chain,
        contract,
        url: `https://opensea.io/assets/${chain}/${contract}`,
      };
    }
    return {
      kind: "asset",
      chain,
      contract,
      tokenId,
      url: `https://opensea.io/assets/${chain}/${contract}/${tokenId}`,
    };
  }

  return null;
}
