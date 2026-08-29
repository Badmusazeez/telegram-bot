import { config } from "./config";
import { maybeCopyPurchase } from "./robinhood/copyExecutor";
import { startMintScheduler } from "./robinhood/mintScheduler";
import { startBlockscoutWatcher } from "./robinhood/blockscoutWatcher";
import { startHeartbeat } from "./robinhood/heartbeat";
import { startRpcQuotaWatcher } from "./robinhood/rpcQuotaWatcher";
import { enrichPurchase, startMonitor } from "./robinhood/monitor";
import { startPendingWatcher } from "./robinhood/pendingWatcher";
import { startTipScanWatcher } from "./robinhood/tipScanWatcher";
import {
  ensureOpenSeaApiKey,
  getOpenSeaApiKey,
  getOpenSeaKeyStatus,
  invalidateOpenSeaApiKey,
} from "./robinhood/openseaAuth";
import { startPriceWatcher } from "./robinhood/priceWatcher";
import { rpcLabels } from "./config";
import { getAllMintWallets, getMintProvider, getProvider, getWallet } from "./robinhood/provider";
import { loadMintWallets } from "./store/mintWallets";
import { addWatchedPrice, getState, loadState } from "./store/state";
import type { NftPurchase } from "./types";
import {
  formatRpcLimitAlert,
  formatTrackRpcSwitch,
  type TrackRpcIssue,
} from "./robinhood/rpcHealth";
import { setTrackRpcSwitchHandler } from "./robinhood/trackRpc";
import { setMintRpcIssueHandler } from "./robinhood/mintRpcAlerts";
import {
  broadcastHtml,
  broadcastPriceAlert,
  broadcastPurchase,
  broadcastRpcAlert,
  broadcastScheduleResult,
  createTelegramBot,
} from "./telegram/bot";
import { formatSlotRaceEvent } from "./telegram/formatter";
import { setSlotRaceHandler } from "./robinhood/slotRace";

/** Throttle LOST_RACE Telegram spam (one per contract every 2s). */
const lostRaceTelegramAt = new Map<string, number>();

async function main(): Promise<void> {
  // Ensure relative paths / cwd issues never break state persistence under pm2
  process.chdir(config.projectRoot);
  console.log(`Starting robinhood-nft-copy-bot on ${config.chain.name}…`);
  await loadState();
  await loadMintWallets();
  await import("./store/botStats").then((m) => m.loadBotStats());

  const bootState = getState();
  if (!bootState.copyEnabled) {
    console.warn(
      "[boot] AUTO-MINT IS OFF — Telegram: /copy on   (or /golive)"
    );
  }
  if (bootState.dryRun) {
    console.warn(
      "[boot] DRY-RUN IS ON — bot will NOT send mint txs. Telegram: /dryrun off   (or /golive)"
    );
  }

  try {
    await ensureOpenSeaApiKey();
    const os = getOpenSeaKeyStatus();
    console.log(
      `OpenSea API key: ${os.present ? `${os.source} ${os.maskedKey}` : "missing"}` +
        (os.expiresAt ? ` (expires ${os.expiresAt})` : "")
    );
    if (os.present) {
      const key = getOpenSeaApiKey();
      if (key) {
        const probe = await fetch(
          `https://api.opensea.io/api/v2/chain/${config.chain.openseaChain}/contract/0x00005ea00ac477b1030ce78506496e8c2de24bf5`,
          {
            headers: { accept: "application/json", "x-api-key": key },
            signal: AbortSignal.timeout(8_000),
          }
        );
        if (probe.status === 401 || probe.status === 403) {
          invalidateOpenSeaApiKey(`boot probe ${probe.status}`);
          try {
            await ensureOpenSeaApiKey({ forceRefresh: true });
            const st = getOpenSeaKeyStatus();
            console.log(
              `[opensea] refreshed after boot 401 → ${st.source} ${st.maskedKey || ""}`
            );
          } catch (err) {
            console.warn(
              `[opensea] boot key refresh failed: ${err instanceof Error ? err.message : String(err)} — SeaDrop public mints still work without API`
            );
          }
        }
      }
    }
  } catch (err) {
    console.warn(
      `OpenSea API key auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    console.warn(
      "Tip: SeaDrop public free mints work without OpenSea API. Or: curl -s -X POST https://api.opensea.io/api/v2/auth/keys"
    );
  }

  const trackProvider = getProvider();
  const mintProvider = getMintProvider();
  const network = await trackProvider.getNetwork();
  if (network.chainId !== config.chain.chainId) {
    console.warn(
      `Warning: track RPC chainId=${network.chainId} (expected ${config.chain.chainId} for ${config.chain.name})`
    );
  }
  try {
    const mintNet = await mintProvider.getNetwork();
    if (mintNet.chainId !== config.chain.chainId) {
      console.warn(
        `Warning: mint RPC chainId=${mintNet.chainId} (expected ${config.chain.chainId} for ${config.chain.name})`
      );
    }
  } catch (err) {
    console.warn(
      `Warning: mint RPC check failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const bot = createTelegramBot();
  const wallets = getAllMintWallets();
  const wallet = wallets[0] ?? getWallet();

  console.log(
    `RPC ready (chain=${config.chain.key} chainId=${network.chainId})`
  );
  console.log(`Track RPC (Alchemy): ${rpcLabels.track}`);
  console.log(`Mint  RPC (Chainstack): ${rpcLabels.mint}`);
  if (rpcLabels.trackBackup !== "(none)") {
    console.log(`Track RPC (backup): ${rpcLabels.trackBackup}`);
  }
  if (rpcLabels.mintBackup !== "(none)") {
    console.log(`Mint  RPC (backup): ${rpcLabels.mintBackup}`);
  }

  setTrackRpcSwitchHandler(async (event) => {
    await broadcastRpcAlert(
      bot,
      formatTrackRpcSwitch(event),
      `switch:${event.to}`
    );
  });

  setMintRpcIssueHandler(async (issue) => {
    console.warn(`[rpc] mint/Chainstack issue ${issue.kind}: ${issue.message}`);
    await broadcastRpcAlert(
      bot,
      formatRpcLimitAlert("mint", issue),
      `mint:${issue.kind}`
    );
  });

  console.log(
    `poll=${config.pollIntervalMs}ms lookback=${config.lookbackBlocks} maxScan=${config.chain.maxScanBlocks}`
  );
  console.log(
    `freeMintsOnly=${bootState.freeMintsOnly} autoMint=${bootState.copyEnabled ? "on" : "off"} dryRun=${bootState.dryRun}`
  );
  console.log(
    `priceAlerts=${config.priceAlertsEnabled ? "on" : "off"} threshold=${config.priceAlertPct}% pricePoll=${config.pricePollIntervalMs}ms`
  );
  if (wallets.length > 0) {
    console.log(`Mint wallets (${wallets.length}):`);
    for (const w of wallets) {
      console.log(`  - ${w.address}`);
    }
  } else {
    console.log(
      wallet
        ? `Signer wallet: ${wallet.address}`
        : "Signer wallet: not configured (alerts-only / dry-run)"
    );
  }

  const onPurchase = async (purchase: NftPurchase) => {
    // Count every tracked-whale mint detection toward monthly Tracks.
    void import("./store/botStats")
      .then(({ recordTrackHit }) => recordTrackHit())
      .catch(() => undefined);
    console.log(
      `[hit] ${purchase.buyer} got ${purchase.contract} #${purchase.tokenId} ~${purchase.valueRobinhood} via ${purchase.marketplace}`
    );
    // Copy FIRST — do not wait on NFT metadata enrichment.
    const copy = await maybeCopyPurchase(purchase);
    const enriched = await enrichPurchase(purchase).catch(() => purchase);
    await broadcastPurchase(bot, enriched, copy);

    if (purchase.isFreeMint && copy.success && !copy.dryRun) {
      void addWatchedPrice({
        contract: purchase.contract,
        tokenId: purchase.tokenId,
        label:
          enriched.tokenName ||
          enriched.collectionName ||
          `${purchase.contract.slice(0, 6)}…#${purchase.tokenId}`,
      }).catch(() => undefined);
      void addWatchedPrice({
        contract: purchase.contract,
        label:
          (enriched.collectionName || purchase.contract.slice(0, 10)) +
          " floor",
      }).catch(() => undefined);
    }
  };

  const onTrackRpcIssue = async (issue: TrackRpcIssue) => {
    console.warn(`[rpc] track/Alchemy issue ${issue.kind}: ${issue.message}`);
    await broadcastRpcAlert(
      bot,
      formatRpcLimitAlert("track", issue),
      `track:${issue.kind}`
    );
  };

  // Fastest → confirmed backups. Shared rememberTxFast dedupes across paths.
  const stopPending = await startPendingWatcher(onPurchase, onTrackRpcIssue);
  const stopBlockscout = await startBlockscoutWatcher(onPurchase);
  const stopTipScan = await startTipScanWatcher(onPurchase, onTrackRpcIssue);

  const stopMonitor = await startMonitor(onPurchase, onTrackRpcIssue);

  const stopPrices = await startPriceWatcher(async (alert) => {
    console.log(
      `[price] ${alert.item.label} ${alert.oldPrice} -> ${alert.newPrice} (${alert.changePct?.toFixed(2)}%)`
    );
    await broadcastPriceAlert(bot, alert);
  });

  const stopSchedules = await startMintScheduler(async (job, result) => {
    console.log(`[schedule] ${job.id} ${result.success ? "ok" : "fail"}: ${result.reason}`);
    await broadcastScheduleResult(bot, job, result);
  });

  const stopHeartbeat = startHeartbeat(async (html) => {
    await broadcastHtml(bot, html);
  });

  const stopRpcQuota = startRpcQuotaWatcher(async (html) => {
    await broadcastHtml(bot, html);
  });

  setSlotRaceHandler(async (event) => {
    // BURST is already collapsed to one SUBMITTED summary in slotRace.
    if (event.phase === "LOST_RACE") {
      const key = event.contract.toLowerCase();
      const now = Date.now();
      const last = lostRaceTelegramAt.get(key) ?? 0;
      if (now - last < 2_000) return;
      lostRaceTelegramAt.set(key, now);
    }
    await broadcastHtml(bot, formatSlotRaceEvent(event));
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down…`);
    stopPending();
    stopMonitor();
    stopBlockscout();
    stopTipScan();
    stopPrices();
    stopSchedules();
    stopHeartbeat();
    stopRpcQuota();
    bot.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await bot.start({
    onStart: (info) => {
      console.log(`Telegram bot @${info.username} is online`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
