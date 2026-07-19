import { formatEther } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";
import { gasIsAffordable, getProvider, getWallet } from "./provider";

/**
 * Free-mint copy executor for Robinhood Chain.
 *
 * When a tracked wallet initiates a 0-value mint tx, replay the same calldata
 * from our wallet (after estimateGas). Paid mints/buys are skipped.
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

  if (state.dryRun) {
    return {
      attempted: true,
      success: true,
      dryRun: true,
      reason: `DRY RUN — would replay free mint calldata to ${sourceTx.to} for collection ${purchase.contract} (token #${purchase.tokenId}).`,
    };
  }

  const wallet = getWallet();
  if (!wallet) {
    return {
      attempted: false,
      success: false,
      dryRun: false,
      reason: "PRIVATE_KEY missing — cannot auto-mint.",
    };
  }

  try {
    const gasEstimate = await provider.estimateGas({
      from: wallet.address,
      to: sourceTx.to,
      data: sourceTx.data,
      value: 0n,
    });

    if (gasEstimate > BigInt(config.maxMintGasLimit)) {
      return {
        attempted: true,
        success: false,
        dryRun: false,
        reason: `Gas estimate ${gasEstimate} exceeds MAX_MINT_GAS_LIMIT ${config.maxMintGasLimit}.`,
      };
    }

    const sent = await wallet.sendTransaction({
      to: sourceTx.to,
      data: sourceTx.data,
      value: 0n,
      gasLimit: (gasEstimate * 120n) / 100n,
    });

    const receipt = await sent.wait();
    if (!receipt || receipt.status !== 1) {
      return {
        attempted: true,
        success: false,
        dryRun: false,
        reason: `Mint tx failed on-chain: ${sent.hash}`,
        txHash: sent.hash,
      };
    }

    return {
      attempted: true,
      success: true,
      dryRun: false,
      reason: `Free mint copied successfully on Robinhood Chain.`,
      txHash: sent.hash,
    };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      dryRun: false,
      reason: `Auto-mint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
