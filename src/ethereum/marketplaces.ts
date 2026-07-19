/** Well-known Ethereum NFT marketplace / settlement contracts. */
export const MARKETPLACES: Record<string, string> = {
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "OpenSea Seaport 1.5",
  "0x0000000000000068f116a894984e2db1123eb395": "OpenSea Seaport 1.6",
  "0x00000000006c3852cbef3e08e8df289169ede581": "OpenSea Seaport 1.1",
  "0x0000000000000ad05ccc4f10045630fb830b95127": "Blur Marketplace",
  "0x29469395eaf6f95920e59f858042f0e28d98a20b": "Blur Marketplace 2",
  "0x00000000000001ad428e4906ae43d8f9852d0dd6": "OpenSea Seaport 1.4",
  "0xb2ecfe4e4d61f8790bbb9de2d4107e9d0c5b0e4b": "Blur Aggregation",
  "0x0000000000a39bb272e79075ade125fd351887ac": "Blur Pool",
};

export function marketplaceName(address: string | null | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  return MARKETPLACES[address.toLowerCase()];
}
