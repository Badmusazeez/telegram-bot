/**
 * Hard isolation from @Nftcopymint_bot (Robinhood).
 * This process must NEVER share folder, token, .env, keys, or state with it.
 */
import fs from "node:fs";
import path from "node:path";
import { BOT } from "./identity";

const SIBLING_MARKERS = [
  "src/robinhood",
  "data/state.json",
  "data/mint-wallets.json",
  "data/opensea-api-key.json",
] as const;

function fail(message: string): never {
  console.error("\n════════════════════════════════════════════════════════");
  console.error(`  REFUSING TO START @${BOT.telegramUsername}`);
  console.error("  This bot is SEPARATE from @" + BOT.siblingBot);
  console.error("════════════════════════════════════════════════════════");
  console.error(`\n${message}\n`);
  console.error("Correct layout on the VPS:");
  console.error("  ~/telegram-bot/     → @" + BOT.siblingBot + " (Robinhood) — leave alone");
  console.error("  ~/porshmints-bot/   → @" + BOT.telegramUsername + " (Ethereum) — this bot");
  console.error("\nNever share: folder, TELEGRAM_BOT_TOKEN, .env, PRIVATE_KEY, or data/\n");
  process.exit(1);
}

function readPackageName(root: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

/** Abort if this checkout looks like the Robinhood bot or a mixed install. */
export function assertFilesystemSeparation(root = process.cwd()): void {
  const pkgName = readPackageName(root);
  if (pkgName === "robinhood-nft-copy-bot") {
    fail(
      `package.json name is "${pkgName}".\n` +
        `You are inside the Robinhood bot folder.\n` +
        `Install @${BOT.telegramUsername} into ~/porshmints-bot instead.`
    );
  }
  if (pkgName && pkgName !== BOT.name) {
    fail(
      `package.json name is "${pkgName}" (expected "${BOT.name}").\n` +
        `Wrong checkout — use the porshmints / Ethereum branch only.`
    );
  }

  if (fs.existsSync(path.join(root, "src", "robinhood"))) {
    fail(
      `Found src/robinhood/ in this folder.\n` +
        `That belongs to @${BOT.siblingBot}. Do not run @${BOT.telegramUsername} here.`
    );
  }

  // Sibling default state files in THIS directory usually mean someone copied
  // or is reusing the Robinhood install tree. Our files are porshmints-*.
  const siblingState = path.join(root, "data", "state.json");
  const ourState = path.join(root, "data", "porshmints-state.json");
  if (fs.existsSync(siblingState) && !fs.existsSync(ourState)) {
    fail(
      `Found data/state.json (Robinhood/@${BOT.siblingBot} state) without our data/porshmints-state.json.\n` +
        `You are likely in the wrong folder. Use a fresh ~/porshmints-bot clone.`
    );
  }

  const chain = (process.env.CHAIN || "").trim().toLowerCase();
  if (chain === "robinhood" || chain === "rh" || chain === "4663") {
    fail(
      `CHAIN="${process.env.CHAIN}" is Robinhood.\n` +
        `@${BOT.telegramUsername} is Ethereum-only (CHAIN=ethereum).`
    );
  }
}

/**
 * After Telegram getMe(), refuse sibling / wrong bot tokens.
 * Prevents 409 conflicts and accidental control of @Nftcopymint_bot.
 */
export function assertTelegramIdentity(username: string | undefined): void {
  const u = (username || "").replace(/^@/, "").toLowerCase();
  const expected = BOT.telegramUsername.toLowerCase();
  const sibling = BOT.siblingBot.toLowerCase();

  if (!u) {
    fail("Telegram getMe() returned no username. Check TELEGRAM_BOT_TOKEN.");
  }
  if (u === sibling) {
    fail(
      `This TELEGRAM_BOT_TOKEN belongs to @${BOT.siblingBot} (Robinhood).\n` +
        `Create a NEW bot in @BotFather for @${BOT.telegramUsername} and put THAT token in ~/porshmints-bot/.env only.`
    );
  }
  if (u !== expected) {
    fail(
      `Token is for @${u}, but this code is @${BOT.telegramUsername} only.\n` +
        `Use the BotFather token for @${BOT.telegramUsername}, or update identity if you renamed the bot.`
    );
  }
}

export function separationBanner(): void {
  console.log(
    [
      "",
      `── isolation ──────────────────────────────────────────`,
      `  this bot : @${BOT.telegramUsername}  (${BOT.title} / Ethereum)`,
      `  other bot: @${BOT.siblingBot}  (Robinhood) — DO NOT TOUCH`,
      `  folder   : must be ~/porshmints-bot (not the Robinhood folder)`,
      `  token    : must be @${BOT.telegramUsername} only`,
      `──────────────────────────────────────────────────────`,
      "",
    ].join("\n")
  );
}

export const SEPARATION_SIBLING_MARKERS = SIBLING_MARKERS;
