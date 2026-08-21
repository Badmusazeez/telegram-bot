import { config } from "./config";
import { maybeCopyPurchase } from "./eth/copyExecutor";
import { startMintScheduler } from "./eth/mintScheduler";
import { startMonitor } from "./eth/monitor";
import { startPriceWatcher } from "./eth/priceWatcher";
import { getAllMintWallets, getProvider, getWallet } from "./eth/provider";
import { BOT } from "./identity";
import {
  assertFilesystemSeparation,
  assertTelegramIdentity,
  separationBanner,
} from "./separation";
import { loadMintWallets } from "./store/mintWallets";
import { addWatchedPrice, loadState } from "./store/state";
import {
  broadcastPriceAlert,
  broadcastPurchase,
  broadcastScheduleResult,
  createTelegramBot,
} from "./telegram/bot";

async function main(): Promise<void> {
  // Never share folder / token / state with @Nftcopymint_bot (Robinhood).
  assertFilesystemSeparation();
  separationBanner();

  console.log(
    `Starting @${BOT.telegramUsername} (${BOT.title}) on ${config.chain.name} — Ethereum only, separate from @${BOT.siblingBot}`
  );
  await loadState();
  await loadMintWallets();

  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== config.chain.chainId) {
    console.warn(
      `Warning: connected chainId=${network.chainId} (expected ${config.chain.chainId} for ${config.chain.name})`
    );
  }

  const bot = createTelegramBot();
  const me = await bot.api.getMe();
  assertTelegramIdentity(me.username);

  const wallets = getAllMintWallets();
  const wallet = wallets[0] ?? getWallet();

  console.log(
    `RPC ready (chain=${config.chain.key} chainId=${network.chainId})`
  );
  console.log(
    `Telegram identity OK: @${me.username} (isolated from @${BOT.siblingBot})`
  );
  console.log(
    `freeMintsOnly=${config.freeMintsOnly} privateMints=${config.privateMintsEnabled} autoMint=${config.copyEnabled ? "on" : "off"} dryRun=${config.dryRun} maxBuy=${config.maxBuyEth} ETH`
  );
  console.log(
    `priceAlerts=${config.priceAlertsEnabled ? "on" : "off"} threshold=${config.priceAlertPct}% poll=${config.pricePollIntervalMs}ms`
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

  const stopMonitor = await startMonitor(async (purchase) => {
    console.log(
      `[hit] ${purchase.buyer} got ${purchase.contract} #${purchase.tokenId} ~${purchase.valueEth} ETH via ${purchase.marketplace}`
    );
    const copy = await maybeCopyPurchase(purchase);
    await broadcastPurchase(bot, purchase, copy);

    if (
      (purchase.isFreeMint || purchase.isPrivateMint) &&
      (copy.success || copy.dryRun)
    ) {
      await addWatchedPrice({
        contract: purchase.contract,
        tokenId: purchase.tokenId,
        label:
          purchase.tokenName ||
          purchase.collectionName ||
          `${purchase.contract.slice(0, 6)}…#${purchase.tokenId}`,
      });
      await addWatchedPrice({
        contract: purchase.contract,
        label:
          (purchase.collectionName || purchase.contract.slice(0, 10)) +
          " floor",
      });
    }
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
