import { formatEther, type Wallet } from "ethers";
import { getMintProvider } from "./provider";

const MIN_GAS_WEI = 50_000_000_000_000n; // 0.00005 RH

export type WalletReadiness = {
  address: string;
  ready: boolean;
  balanceWei: bigint | null;
  balanceRh: string;
  reason?: string;
};

/**
 * Fast pre-flight for mint wallets. Does not drop wallets from the blast —
 * caller decides. Never logs private keys.
 */
export async function checkMintWalletReadiness(
  wallets: Wallet[]
): Promise<{ ready: Wallet[]; notReady: WalletReadiness[]; all: WalletReadiness[] }> {
  const provider = getMintProvider();
  const all = await Promise.all(
    wallets.map(async (w) => {
      const address = w.address.toLowerCase();
      try {
        const balanceWei = await provider.getBalance(w.address);
        const ready = balanceWei >= MIN_GAS_WEI;
        return {
          address,
          ready,
          balanceWei,
          balanceRh: formatEther(balanceWei),
          reason: ready ? undefined : "low native balance for gas",
        } satisfies WalletReadiness;
      } catch {
        // Unknown — treat as ready so we don't skip a funded wallet on RPC flake.
        return {
          address,
          ready: true,
          balanceWei: null,
          balanceRh: "?",
          reason: "balance check failed — attempting anyway",
        } satisfies WalletReadiness;
      }
    })
  );

  const ready = wallets.filter((w) =>
    all.find((r) => r.address === w.address.toLowerCase())?.ready
  );
  const notReady = all.filter((r) => !r.ready);
  return { ready, notReady, all };
}
