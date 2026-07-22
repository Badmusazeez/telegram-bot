import { config } from "./config";
import { startScanner } from "./scanner/scanner";
import { loadState } from "./store/state";
import { broadcastSignal, createTelegramBot } from "./telegram/bot";

async function main(): Promise<void> {
  console.log("Starting Futures AI Trading Assistant…");
  console.log(
    `Exchange=${config.exchange} Timeframe=${config.timeframe} EMA=${config.emaFast}/${config.emaSlow} scan=${config.scanIntervalMs}ms`
  );
  console.log(
    `Min volume=$${config.minQuoteVolumeUsdt.toLocaleString()} dryRun=${config.dryRun} alerts=${config.alertsEnabled}`
  );
  console.log("Alerts only — this bot does not place orders.");

  await loadState();

  const bot = createTelegramBot();
  const stopScanner = startScanner(async (signal) => {
    await broadcastSignal(bot, signal);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down…`);
    stopScanner();
    bot.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await bot.start({
    onStart: (info) => {
      console.log(`Telegram bot @${info.username} is online`);
      console.log(
        `Scanning ${config.exchange.toUpperCase()} USDT-M Futures 24/7…`
      );
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
