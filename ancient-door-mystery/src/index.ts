import { createBot } from "./bot";

async function main(): Promise<void> {
  const bot = createBot();
  console.log("Ancient Door Mystery bot starting…");
  await bot.start({
    onStart: (info) => {
      console.log(`Listening as @${info.username}`);
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
