import { getState } from "../store/state";
import type { CopyResult, NftPurchase } from "../types";
import { config } from "../config";
import { gasIsAffordable, getWallet } from "./provider";

/**
 * Copy executor with hard safety rails.
 *
 * Live marketplace fulfillment needs OpenSea/Blur order APIs and careful
 * calldata construction. This bot ships a production-safe pipeline:
 * - evaluates risk/limits
 * - dry-runs by default
 * - when live + OpenSea key is present, attempts to locate a listing and
 *   reports the actionable buy path (fulfillment can be extended)
 */
export async function maybeCopyPurchase(
  purchase: NftPurchase
): Promise<CopyResult> {
  const state = getState();

  if (!state.copyEnabled) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "Copy mode is disabled. Use /copy on to enable.",
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

  const isMarketplace =
    !!purchase.marketplace &&
    purchase.marketplace !== "transfer" &&
    purchase.marketplace !== "on-chain";

  if (purchase.valueEth <= 0 && !isMarketplace) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: "No on-chain ETH value detected (likely private transfer).",
    };
  }

  if (purchase.valueEth > 0 && purchase.valueEth > state.maxBuyEth) {
    return {
      attempted: false,
      success: false,
      dryRun: state.dryRun,
      reason: `Price ${purchase.valueEth.toFixed(4)} ETH exceeds max ${state.maxBuyEth} ETH.`,
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

  if (state.dryRun) {
    const priceLabel =
      purchase.valueEth > 0
        ? `~${purchase.valueEth.toFixed(4)} ETH`
        : "unknown WETH/ETH price";
    return {
      attempted: true,
      success: true,
      dryRun: true,
      reason: `DRY RUN — would copy buy of token #${purchase.tokenId} for ${priceLabel}${purchase.marketplace ? ` via ${purchase.marketplace}` : ""}.`,
    };
  }

  const wallet = getWallet();
  if (!wallet) {
    return {
      attempted: false,
      success: false,
      dryRun: false,
      reason: "PRIVATE_KEY missing — cannot submit live copy trades.",
    };
  }

  // Live path: look up OpenSea listing for transparency / future fulfillment.
  if (config.openseaApiKey) {
    try {
      const listing = await fetchOpenSeaListing(
        purchase.contract,
        purchase.tokenId
      );
      if (!listing) {
        return {
          attempted: true,
          success: false,
          dryRun: false,
          reason:
            "No active OpenSea listing found for this token (may have been sniped).",
        };
      }

      if (listing.priceEth > state.maxBuyEth) {
        return {
          attempted: true,
          success: false,
          dryRun: false,
          reason: `OpenSea ask ${listing.priceEth.toFixed(4)} ETH exceeds max ${state.maxBuyEth} ETH.`,
        };
      }

      // Explicit non-auto-fulfill guard: live broadcast of marketplace
      // fulfillments is intentionally not enabled by default because a bad
      // calldata path can drain funds. Operators can plug fulfillment here.
      return {
        attempted: true,
        success: false,
        dryRun: false,
        reason: `Live listing found at ${listing.priceEth.toFixed(4)} ETH (order ${listing.orderHash.slice(0, 10)}…). Auto-fulfill is disabled for safety — set DRY_RUN=true alerts-only, or extend copyExecutor.fulfillOrder().`,
      };
    } catch (err) {
      return {
        attempted: true,
        success: false,
        dryRun: false,
        reason: `OpenSea lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    attempted: true,
    success: false,
    dryRun: false,
    reason:
      "Live copy requires OPENSEA_API_KEY. Bot continues alerting; fulfillment not configured.",
  };
}

async function fetchOpenSeaListing(
  contract: string,
  tokenId: string
): Promise<{ priceEth: number; orderHash: string } | null> {
  const chain = config.chain.openseaChain;
  const url = `https://api.opensea.io/api/v2/orders/${chain}/seaport/listings?asset_contract_address=${contract}&token_ids=${tokenId}&order_by=eth_price&order_direction=asc&limit=1`;
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-api-key": config.openseaApiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`OpenSea HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    orders?: Array<{
      order_hash: string;
      price?: { current?: { value?: string; decimals?: number } };
    }>;
  };
  const order = data.orders?.[0];
  if (!order?.price?.current?.value) {
    return null;
  }
  const decimals = order.price.current.decimals ?? 18;
  const priceEth =
    Number(order.price.current.value) / 10 ** decimals;
  return { priceEth, orderHash: order.order_hash };
}
