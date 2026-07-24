#!/usr/bin/env node
/**
 * Validates local .env before starting the bot.
 * Usage: npm run check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  fail(`Node.js 20+ required (found ${process.version}). Install from https://nodejs.org`);
}
ok(`Node.js ${process.version}`);

if (!fs.existsSync(path.join(root, "node_modules"))) {
  fail("Dependencies missing. Run: npm install");
}
ok("node_modules present");

if (!fs.existsSync(envPath)) {
  fail("No .env file found.\n  Run this in your terminal first:\n    npm run setup");
}
ok(".env found");

try {
  require("dotenv").config({ path: envPath });
} catch {
  fail("Could not load dotenv. Run: npm install");
}

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").trim();
const timeframe = (process.env.TIMEFRAME || "15m").trim();
const emaFast = Number(process.env.EMA_FAST || "9");
const emaSlow = Number(process.env.EMA_SLOW || "21");

const problems = [];
if (!token) problems.push("TELEGRAM_BOT_TOKEN is empty");
if (!chats) {
  problems.push(
    "TELEGRAM_ALLOWED_CHAT_IDS is empty (set your Telegram chat id so only you control the bot)"
  );
}
if (Number.isFinite(emaFast) && Number.isFinite(emaSlow) && emaFast >= emaSlow) {
  problems.push("EMA_FAST must be less than EMA_SLOW");
}
const validTf = new Set([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
]);
if (!validTf.has(timeframe)) {
  problems.push(`TIMEFRAME "${timeframe}" is invalid`);
}

if (problems.length) {
  console.error("\n✗ .env needs attention:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix with:\n  npm run setup\n");
  process.exit(1);
}

ok("TELEGRAM_BOT_TOKEN set");
ok("TELEGRAM_ALLOWED_CHAT_IDS set");
ok(`TIMEFRAME=${timeframe} EMA=${emaFast}/${emaSlow}`);
console.log("\nReady to run. Start the bot with:\n  npm run start:dev\n  # or: npm run bot\n");
