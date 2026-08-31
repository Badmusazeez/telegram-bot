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
import { getAllMintWallets, getMintProvider, getWallet } from "./robinhood/provider";
import { loadMintWallets } from "./store/mintWallets";
import { addWatchedPrice, getState, loadState } from "./store/state";
import type { NftPurchase } from "./types";
import {
  formatRpcLimitAlert,
  formatTrackRpcSwitch,
  type TrackRpcIssue,
} from "./robinhood/rpcHealth";
import {
  forceTrackBackup,
  hasTrackBackup,
  withTrackRpc,
  setTrackRpcSwitchHandler,
} from "./robinhood/trackRpc";
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

async function withBootTimeout<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const work = fn().catch((err) => {
    console.warn(
      `[boot] ${label} failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  });
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[boot] ${label} timed out after ${ms}ms — continuing`);
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

  // Create Telegram bot early so a hung RPC never leaves you with "online" pm2
  // but zero replies to /status. bot.start() still runs last (long-poll loop).
  const bot = createTelegramBot();
  console.log(
    `[boot] Telegram token loaded (allowed chats: ${
      config.allowedChatIds.size === 0
        ? "ANY"
        : [...config.allowedChatIds].join(",")
    })`
  );
  const me = await withBootTimeout("telegram-getMe", 8_000, () => bot.api.getMe());
  if (!me) {
    console.error(
      "[boot] Telegram getMe failed — check TELEGRAM_BOT_TOKEN and network egress to api.telegram.org"
    );
  } else {
    console.log(`[boot] Telegram API ok — @${me.username} (id=${me.id})`);
  }

  await withBootTimeout("opensea-key", 12_000, async () => {
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
  });

  // Never call raw provider.getNetwork() — ethers retries forever when Alchemy
  // is FULL and Telegram never reaches bot.start().
  let trackChainId: bigint | null = null;
  const trackNet = await withBootTimeout("track-rpc", 10_000, async () => {
    try {
      return await withTrackRpc((p) => p.getNetwork());
    } catch (err) {
      if (hasTrackBackup()) {
        console.warn(
          `[boot] track primary failed — forcing Chainstack backup: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        await forceTrackBackup(
          `boot: ${err instanceof Error ? err.message : String(err)}`
        );
        return await withTrackRpc((p) => p.getNetwork());
      }
      throw err;
    }
  });
  if (trackNet) {
    trackChainId = trackNet.chainId;
    if (trackNet.chainId !== config.chain.chainId) {
      console.warn(
        `Warning: track RPC chainId=${trackNet.chainId} (expected ${config.chain.chainId} for ${config.chain.name})`
      );
    }
  } else {
    console.warn(
      "[boot] track RPC unreachable — starting Telegram anyway (detection may lag until RPC recovers)"
    );
  }

  const mintProvider = getMintProvider();
  await withBootTimeout("mint-rpc", 8_000, async () => {
    const mintNet = await mintProvider.getNetwork();
    if (mintNet.chainId !== config.chain.chainId) {
      console.warn(
        `Warning: mint RPC chainId=${mintNet.chainId} (expected ${config.chain.chainId} for ${config.chain.name})`
      );
    }
    return mintNet;
  });

  const wallets = getAllMintWallets();
  const wallet = wallets[0] ?? getWallet();

  console.log(
    `RPC ready (chain=${config.chain.key} chainId=${trackChainId ?? "?"})`
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
  // Never let a watcher hang block Telegram — each has its own timeout.
  const stopPending =
    (await withBootTimeout("pending-watcher", 5_000, () =>
      startPendingWatcher(onPurchase, onTrackRpcIssue)
    )) ?? (() => undefined);
  const stopBlockscout =
    (await withBootTimeout("blockscout-watcher", 5_000, () =>
      startBlockscoutWatcher(onPurchase)
    )) ?? (() => undefined);
  const stopTipScan =
    (await withBootTimeout("tip-scan-watcher", 5_000, () =>
      startTipScanWatcher(onPurchase, onTrackRpcIssue)
    )) ?? (() => undefined);

  const stopMonitor =
    (await withBootTimeout("monitor", 5_000, () =>
      startMonitor(onPurchase, onTrackRpcIssue)
    )) ?? (() => undefined);

  const stopPrices =
    (await withBootTimeout("price-watcher", 5_000, () =>
      startPriceWatcher(async (alert) => {
        console.log(
          `[price] ${alert.item.label} ${alert.oldPrice} -> ${alert.newPrice} (${alert.changePct?.toFixed(2)}%)`
        );
        await broadcastPriceAlert(bot, alert);
      })
    )) ?? (() => undefined);

  const stopSchedules =
    (await withBootTimeout("mint-scheduler", 5_000, () =>
      startMintScheduler(async (job, result) => {
        console.log(
          `[schedule] ${job.id} ${result.success ? "ok" : "fail"}: ${result.reason}`
        );
        await broadcastScheduleResult(bot, job, result);
      })
    )) ?? (() => undefined);

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

  console.log("[boot] starting Telegram long-poll (bot.start)…");
  await bot.start({
    onStart: (info) => {
      console.log(`Telegram bot @${info.username} is online — send /status`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
