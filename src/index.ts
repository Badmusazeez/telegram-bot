import { config } from "./config";
import { maybeCopyPurchase } from "./robinhood/copyExecutor";
import { startMintScheduler } from "./robinhood/mintScheduler";
import { startBlockscoutWatcher } from "./robinhood/blockscoutWatcher";
import { enrichPurchase, startMonitor } from "./robinhood/monitor";
import {
  ensureOpenSeaApiKey,
  getOpenSeaKeyStatus,
} from "./robinhood/openseaAuth";
import { startPriceWatcher } from "./robinhood/priceWatcher";
import { rpcLabels } from "./config";
import { getAllMintWallets, getMintProvider, getProvider, getWallet } from "./robinhood/provider";
import { loadMintWallets } from "./store/mintWallets";
import { addWatchedPrice, getState, loadState } from "./store/state";
import type { NftPurchase } from "./types";
import {
  formatTrackRpcIssue,
  formatTrackRpcSwitch,
} from "./robinhood/rpcHealth";
import { setTrackRpcSwitchHandler } from "./robinhood/trackRpc";
import {
  broadcastPriceAlert,
  broadcastPurchase,
  broadcastRpcAlert,
  broadcastScheduleResult,
  createTelegramBot,
} from "./telegram/bot";

async function main(): Promise<void> {
  // Ensure relative paths / cwd issues never break state persistence under pm2
  process.chdir(config.projectRoot);
  console.log(`Starting robinhood-nft-copy-bot on ${config.chain.name}…`);
  await loadState();
  await loadMintWallets();

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
  } catch (err) {
    console.warn(
      `OpenSea API key auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    console.warn(
      "Tip: on the VPS run: curl -s -X POST https://api.opensea.io/api/v2/auth/keys"
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
  console.log(`Mint  RPC (Alchemy): ${rpcLabels.mint}`);
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
    console.log(
      `[hit] ${purchase.buyer} got ${purchase.contract} #${purchase.tokenId} ~${purchase.valueRobinhood} via ${purchase.marketplace}`
    );
    // Copy immediately; enrich metadata in parallel for Telegram (do not delay mint).
    const [copy, enriched] = await Promise.all([
      maybeCopyPurchase(purchase),
      enrichPurchase(purchase),
    ]);
    await broadcastPurchase(bot, enriched, copy);

    if (purchase.isFreeMint && copy.success && !copy.dryRun) {
      await addWatchedPrice({
        contract: purchase.contract,
        tokenId: purchase.tokenId,
        label:
          enriched.tokenName ||
          enriched.collectionName ||
          `${purchase.contract.slice(0, 6)}…#${purchase.tokenId}`,
      });
      await addWatchedPrice({
        contract: purchase.contract,
        label:
          (enriched.collectionName || purchase.contract.slice(0, 10)) +
          " floor",
      });
    }
  };

  // Blockscout FIRST — must not wait on Alchemy catch-up (that was missing signals).
  const stopBlockscout = await startBlockscoutWatcher(onPurchase);

  const stopMonitor = await startMonitor(onPurchase, async (issue) => {
    console.warn(`[rpc] track issue ${issue.kind}: ${issue.message}`);
    await broadcastRpcAlert(bot, formatTrackRpcIssue(issue), issue.kind);
  });

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

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down…`);
    stopMonitor();
    stopBlockscout();
    stopPrices();
    stopSchedules();
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
