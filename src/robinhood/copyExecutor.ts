import { formatEther } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";
import { gasIsAffordable, getProvider, getWallet } from "./provider";

/**
 * Free-mint copy executor for Robinhood Chain.
 *
 * Replays the whale's 0-value mint calldata from our buyer wallet.
 * If the calldata hardcodes the whale as recipient (common on OpenSea drops),
 * we also try a rewritten payload with our address substituted.
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

  const wallet = getWallet();
  if (!wallet && !state.dryRun) {
    return {
      attempted: false,
      success: false,
      dryRun: false,
      reason: "PRIVATE_KEY missing — cannot auto-mint.",
    };
  }

  const buyer = wallet?.address.toLowerCase() ?? "0x0000000000000000000000000000000000000001";
  const candidates = buildCalldataCandidates(
    sourceTx.data,
    purchase.buyer,
    buyer
  );

  if (state.dryRun) {
    return {
      attempted: true,
      success: true,
      dryRun: true,
      reason: `DRY RUN — would try ${candidates.length} free-mint calldata variant(s) to ${sourceTx.to} (collection ${purchase.contract}, token #${purchase.tokenId}).`,
    };
  }

  if (!wallet) {
    return {
      attempted: false,
      success: false,
      dryRun: false,
      reason: "PRIVATE_KEY missing — cannot auto-mint.",
    };
  }

  const errors: string[] = [];

  for (const [index, data] of candidates.entries()) {
    try {
      const gasEstimate = await provider.estimateGas({
        from: wallet.address,
        to: sourceTx.to,
        data,
        value: 0n,
      });

      if (gasEstimate > BigInt(config.maxMintGasLimit)) {
        errors.push(
          `variant ${index + 1}: gas ${gasEstimate} > MAX_MINT_GAS_LIMIT`
        );
        continue;
      }

      const sent = await wallet.sendTransaction({
        to: sourceTx.to,
        data,
        value: 0n,
        gasLimit: (gasEstimate * 120n) / 100n,
      });

      const receipt = await sent.wait();
      if (!receipt || receipt.status !== 1) {
        errors.push(`variant ${index + 1}: tx reverted ${sent.hash}`);
        continue;
      }

      return {
        attempted: true,
        success: true,
        dryRun: false,
        reason: `Free mint copied successfully on Robinhood Chain (variant ${index + 1}).`,
        txHash: sent.hash,
      };
    } catch (err) {
      errors.push(`variant ${index + 1}: ${shortError(err)}`);
    }
  }

  return {
    attempted: true,
    success: false,
    dryRun: false,
    reason: friendlierFailure(errors, sourceTx.to),
  };
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
    return "execution reverted";
  }
  return msg.slice(0, 160);
}

function friendlierFailure(errors: string[], to: string): string {
  const joined = errors.join(" | ");
  const looksLikeOpenSea =
    to.toLowerCase() === "0x00005ea00ac477b1030ce78506496e8c2de24bf5";

  if (looksLikeOpenSea || joined.includes("execution reverted")) {
    return (
      "Auto-mint failed: this free mint is wallet-bound (OpenSea drop / allowlist / signature). " +
      "Exact tx replay cannot mint to your wallet. Try a public open mint, or mint manually from OpenSea. " +
      `Details: ${joined}`
    );
  }

  return `Auto-mint failed after trying ${errors.length} variant(s): ${joined}`;
}
