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
  fail('Dependencies missing. Run: npm install');
}
ok("node_modules present");

if (!fs.existsSync(envPath)) {
  fail("No .env file found.\n  Run this in your terminal first:\n    npm run setup");
}
ok(".env found");

// Load dotenv without compiling TypeScript
try {
  require("dotenv").config({ path: envPath });
} catch {
  fail("Could not load dotenv. Run: npm install");
}

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const rpc = (process.env.ETH_RPC_URL || "").trim();
const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").trim();

const problems = [];
if (!token) problems.push("TELEGRAM_BOT_TOKEN is empty");
if (!rpc || rpc.includes("YOUR_KEY")) {
  problems.push("ETH_RPC_URL is missing or still has YOUR_KEY placeholder");
}
if (!/^https?:\/\//i.test(rpc)) {
  problems.push("ETH_RPC_URL must start with http:// or https://");
}
if (!chats) {
  problems.push(
    "TELEGRAM_ALLOWED_CHAT_IDS is empty (set your Telegram chat id so only you can control the bot)"
  );
}

if (problems.length) {
  console.error("\n✗ .env needs attention:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix with:\n  npm run setup\n");
  process.exit(1);
}

ok("TELEGRAM_BOT_TOKEN set");
ok("TELEGRAM_ALLOWED_CHAT_IDS set");
ok("ETH_RPC_URL set");
console.log("\nReady to run. Start the bot with:\n  npm run start:dev\n  # or: npm run bot\n");
