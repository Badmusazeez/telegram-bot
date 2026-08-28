import { config } from "../config";
import {
  getState,
  updateWatchedPrice,
} from "../store/state";
import type { PriceChangeAlert, WatchedPriceItem } from "../types";

export type PriceAlertHandler = (alert: PriceChangeAlert) => Promise<void>;

async function fetchOpenSeaJson(url: string): Promise<unknown | null> {
  if (!config.openseaApiKey) {
    return null;
  }
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-api-key": config.openseaApiKey,
    },
  });
  if (!res.ok) {
    throw new Error(`OpenSea HTTP ${res.status}`);
  }
  return res.json();
}

/** Best listing price for a specific token, in native ETH units. */
export async function fetchTokenBestListing(
  contract: string,
  tokenId: string
): Promise<number | null> {
  const chain = config.chain.openseaChain;
  const url = `https://api.opensea.io/api/v2/orders/${chain}/seaport/listings?asset_contract_address=${contract}&token_ids=${tokenId}&order_by=eth_price&order_direction=asc&limit=1`;
  const data = (await fetchOpenSeaJson(url)) as {
    orders?: Array<{
      price?: { current?: { value?: string; decimals?: number } };
    }>;
  } | null;
  if (!data) {
    return null;
  }
  const order = data.orders?.[0];
  if (!order?.price?.current?.value) {
    return null;
  }
  const decimals = order.price.current.decimals ?? 18;
  return Number(order.price.current.value) / 10 ** decimals;
}

/** Collection floor via OpenSea contract endpoint (best-effort). */
export async function fetchCollectionFloor(
  contract: string
): Promise<number | null> {
  const chain = config.chain.openseaChain;
  const nftUrl = `https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`;
  const contractInfo = (await fetchOpenSeaJson(nftUrl)) as {
    collection?: string;
  } | null;
  const slug = contractInfo?.collection;
  if (!slug) {
    return null;
  }
  const statsUrl = `https://api.opensea.io/api/v2/collections/${slug}/stats`;
  const stats = (await fetchOpenSeaJson(statsUrl)) as {
    total?: { floor_price?: number };
  } | null;
  const floor = stats?.total?.floor_price;
  return typeof floor === "number" && Number.isFinite(floor) ? floor : null;
}

async function currentPrice(item: WatchedPriceItem): Promise<number | null> {
  if (item.tokenId) {
    return fetchTokenBestListing(item.contract, item.tokenId);
  }
  return fetchCollectionFloor(item.contract);
}

function shouldAlert(
  oldPrice: number | null,
  newPrice: number,
  thresholdPct: number
): { yes: boolean; changePct: number | null } {
  if (oldPrice === null || oldPrice <= 0) {
    return { yes: false, changePct: null };
  }
  const changePct = ((newPrice - oldPrice) / oldPrice) * 100;
  return {
    yes: Math.abs(changePct) >= thresholdPct,
    changePct,
  };
}

export async function scanPriceChanges(): Promise<PriceChangeAlert[]> {
  const state = getState();
  if (!state.priceAlertsEnabled || state.watchedPrices.length === 0) {
    return [];
  }
  if (!config.openseaApiKey) {
    console.warn(
      "[price] OPENSEA_API_KEY missing — cannot poll NFT prices"
    );
    return [];
  }

  const alerts: PriceChangeAlert[] = [];
  const threshold = state.priceAlertPct;

  for (const item of state.watchedPrices) {
    try {
      const price = await currentPrice(item);
      if (price === null) {
        continue;
      }
      const { yes, changePct } = shouldAlert(item.lastPrice, price, threshold);
      const openSeaUrl = item.tokenId
        ? `https://opensea.io/assets/${config.chain.openseaChain}/${item.contract}/${item.tokenId}`
        : `https://opensea.io/assets/${config.chain.openseaChain}/${item.contract}`;

      if (yes) {
        alerts.push({
          item: { ...item },
          oldPrice: item.lastPrice,
          newPrice: price,
          changePct,
          openSeaUrl,
        });
      }

      await updateWatchedPrice(item.id, price);
    } catch (err) {
      console.error(
        `[price] watch failed for ${item.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return alerts;
}

export async function startPriceWatcher(
  onAlert: PriceAlertHandler
): Promise<() => void> {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const alerts = await scanPriceChanges();
      for (const alert of alerts) {
        await onAlert(alert);
      }
    } catch (err) {
      console.error("[price] scan failed:", err);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => {
    void tick();
  }, 15_000);
  const timer = setInterval(() => {
    void tick();
  }, config.pricePollIntervalMs);

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
