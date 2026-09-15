/** Well-known Robinhood Chain / shared NFT marketplace settlement contracts. */
export const MARKETPLACES: Record<string, string> = {
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "OpenSea Seaport 1.5",
  "0x0000000000000068f116a894984e2db1123eb395": "OpenSea Seaport 1.6",
  "0x00000000006c3852cbef3e08e8df289169ede581": "OpenSea Seaport 1.1",
  "0x00000000000001ad428e4906ae43d8f9852d0dd6": "OpenSea Seaport 1.4",
};

export function marketplaceName(
  address: string | null | undefined
): string | undefined {
  if (!address) {
    return undefined;
  }
  return MARKETPLACES[address.toLowerCase()];
}
