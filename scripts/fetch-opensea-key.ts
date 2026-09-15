/**
 * Fetch an instant OpenSea API key and save it for the bot.
 *
 *   curl -X POST https://api.opensea.io/api/v2/auth/keys
 *   npm run opensea-key -- --refresh
 */
process.env.TELEGRAM_BOT_TOKEN ||= "local-opensea-key-script";
process.env.TRACK_RPC_URL ||=
  process.env.ROBINHOOD_RPC_URL ||
  "https://robinhood-mainnet.g.alchemy.com/v2/dummy";

async function main(): Promise<void> {
  const { createInstantOpenSeaApiKey, ensureOpenSeaApiKey, getOpenSeaKeyStatus } =
    await import("../src/robinhood/openseaAuth");

  const force = process.argv.includes("--refresh") || process.argv.includes("-f");
  if (force) {
    const created = await createInstantOpenSeaApiKey();
    console.log(JSON.stringify(created, null, 2));
  } else {
    await ensureOpenSeaApiKey();
    console.log(JSON.stringify(getOpenSeaKeyStatus(), null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
