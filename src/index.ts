import { config } from "./config";
import { maybeCopyPurchase } from "./ethereum/copyExecutor";
import { startMonitor } from "./ethereum/monitor";
import { getProvider, getWallet } from "./ethereum/provider";
import { loadState } from "./store/state";
import { broadcastPurchase, createTelegramBot } from "./telegram/bot";

async function main(): Promise<void> {
  console.log(`Starting NFT copy bot on ${config.chain.name}…`);
  await loadState();

  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== config.chain.chainId) {
    console.warn(
      `Warning: connected chainId=${network.chainId} (expected ${config.chain.chainId} for ${config.chain.name})`
    );
  }

  const bot = createTelegramBot();
  const wallet = getWallet();

  console.log(`RPC ready (chain=${config.chain.key} chainId=${network.chainId})`);
  console.log(
    `Copy=${config.copyEnabled ? "on" : "off"} dryRun=${config.dryRun} maxBuy=${config.maxBuyEth} ETH`
  );
  console.log(
    wallet
      ? `Signer wallet: ${wallet.address}`
      : "Signer wallet: not configured (alerts-only / dry-run)"
  );

  const stopMonitor = await startMonitor(async (purchase) => {
    console.log(
      `[hit] ${purchase.buyer} got ${purchase.contract} #${purchase.tokenId} ~${purchase.valueEth} ETH via ${purchase.marketplace}`
    );
    const copy = await maybeCopyPurchase(purchase);
    await broadcastPurchase(bot, purchase, copy);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down…`);
    stopMonitor();
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
