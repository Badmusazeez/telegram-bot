import { formatEther, type Wallet } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";
import {
  gasIsAffordable,
  getAllMintWallets,
  getProvider,
} from "./provider";

/**
 * Free-mint copy executor for Robinhood Chain.
 *
 * Replays whale calldata across ALL configured mint wallets.
 */
export async function maybeCopyPurchase(
  purchase: NftPurchase
): Promise<CopyResult> {
  const state = getState();

  if (state.freeMintsOnly) {
    if (
      !purchase.isFreeMint ||
      purchase.isPaid ||
      purchase.valueRobinhood > 0
    ) {
      return {
        attempted: false,
        success: false,
        dryRun: state.dryRun,
        reason: "Skipped — paid mint/buy (free-mints-only mode).",
      };
    }
  }

  if (!state.copyEnabled) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Auto-mint is disabled. Use /copy on to enable.",
    };
  }

  if (
    state.allowedCollections.length > 0 &&
    !state.allowedCollections.includes(purchase.contract.toLowerCase())
  ) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Collection is not in the allowlist.",
    };
  }

  if (!purchase.isFreeMint) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Not a free mint — skipped.",
    };
  }

  const affordableGas = await gasIsAffordable();
  if (!affordableGas) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `Gas above MAX_GAS_GWEI (${config.maxGasGwei}).`,
    };
  }

  const provider = getProvider();
  const sourceTx = await provider.getTransaction(purchase.txHash);
  if (!sourceTx) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Could not load source mint transaction.",
    };
  }

  if (sourceTx.value > 0n) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `Skipped paid mint (${formatEther(sourceTx.value)} native).`,
    };
  }

  if (!sourceTx.to || !sourceTx.data || sourceTx.data === "0x") {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Source tx has no calldata to replay.",
    };
  }

  if (sourceTx.from.toLowerCase() !== purchase.buyer.toLowerCase()) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason:
        "Skipped airdrop/mint-to-wallet — whale did not send the mint tx.",
    };
  }

  const wallets = getAllMintWallets();
  if (wallets.length === 0) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "No mint wallets configured. Use /addkey or PRIVATE_KEY(S).",
    };
  }

  if (state.dryRun) {
    return {
      attempted: true,
      success: true,
      dryRun: true,
      reason: `DRY RUN — would mint on ${wallets.length} wallet(s) for collection ${purchase.contract} #${purchase.tokenId}.`,
    };
  }

  const results = await Promise.all(
    wallets.map((wallet) =>
      mintWithWallet(wallet, sourceTx.to!, sourceTx.data, purchase.buyer)
    )
  );

  const ok = results.filter((r) => r.ok);
  const summary = results
    .map(
      (r) =>
        `${r.address.slice(0, 6)}…${r.ok ? ` OK ${r.txHash?.slice(0, 10)}…` : ` FAIL (${r.error})`}`
    )
    .join(" | ");

  return {
    attempted: true,
    success: ok.length > 0,
    dryRun: false,
    reason:
      ok.length > 0
        ? `Minted on ${ok.length}/${wallets.length} wallet(s): ${summary}`
        : `All ${wallets.length} wallet(s) failed: ${summary}`,
    txHash: ok[0]?.txHash,
  };
}

async function mintWithWallet(
  wallet: Wallet,
  to: string,
  rawData: string,
  whale: string
): Promise<{ address: string; ok: boolean; txHash?: string; error?: string }> {
  const address = wallet.address.toLowerCase();
  const candidates = buildCalldataCandidates(rawData, whale, address);
  const provider = getProvider();
  const errors: string[] = [];

  for (const [index, data] of candidates.entries()) {
    try {
      const gasEstimate = await provider.estimateGas({
        from: wallet.address,
        to,
        data,
        value: 0n,
      });
      if (gasEstimate > BigInt(config.maxMintGasLimit)) {
        errors.push(`v${index + 1} gas too high`);
        continue;
      }
      const sent = await wallet.sendTransaction({
        to,
        data,
        value: 0n,
        gasLimit: (gasEstimate * 120n) / 100n,
      });
      const receipt = await sent.wait();
      if (!receipt || receipt.status !== 1) {
        errors.push(`v${index + 1} reverted`);
        continue;
      }
      return { address, ok: true, txHash: sent.hash };
    } catch (err) {
      errors.push(`v${index + 1} ${shortError(err)}`);
    }
  }

  return { address, ok: false, error: errors.join("; ") || "unknown" };
}

function buildCalldataCandidates(
  data: string,
  whale: string,
  buyer: string
): string[] {
  const original = data.toLowerCase();
  const rewritten = replaceAddressInCalldata(original, whale, buyer);
  const out = [original];
  if (rewritten !== original) {
    out.push(rewritten);
  }
  return out;
}

function replaceAddressInCalldata(
  data: string,
  fromAddr: string,
  toAddr: string
): string {
  const from = fromAddr.toLowerCase().replace(/^0x/, "");
  const to = toAddr.toLowerCase().replace(/^0x/, "");
  if (from.length !== 40 || to.length !== 40) {
    return data;
  }
  const fromPadded = from.padStart(64, "0");
  const toPadded = to.padStart(64, "0");
  if (!data.includes(fromPadded)) {
    return data;
  }
  return data.split(fromPadded).join(toPadded);
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("execution reverted")) {
    return "reverted";
  }
  return msg.slice(0, 80);
}
