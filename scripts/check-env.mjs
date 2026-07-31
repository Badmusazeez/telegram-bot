#!/usr/bin/env node
/**
 * Validates .env before starting the bot on a VPS / local machine.
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
  fail(`Node.js 20+ required (found ${process.version})`);
}
ok(`Node.js ${process.version}`);

if (!fs.existsSync(path.join(root, "node_modules"))) {
  fail("Dependencies missing. Run: npm install");
}
ok("node_modules present");

if (!fs.existsSync(envPath)) {
  fail("No .env file found.\n  cp env.example .env && nano .env");
}
ok(".env found");

try {
  require("dotenv").config({ path: envPath });
} catch {
  fail("Could not load dotenv. Run: npm install");
}

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const rpc = (
  process.env.ETH_RPC_URL ||
  process.env.RPC_URL ||
  ""
).trim();
const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").trim();
const key = (process.env.PRIVATE_KEY || "").trim();
const tracked = (process.env.TRACKED_WALLETS || "").trim();

const problems = [];
if (!token) problems.push("TELEGRAM_BOT_TOKEN is empty");
if (!rpc || rpc.includes("YOUR_KEY")) {
  problems.push("ETH_RPC_URL is missing or still has YOUR_KEY placeholder");
}
if (rpc && !/^https?:\/\//i.test(rpc)) {
  problems.push("ETH_RPC_URL must start with http:// or https://");
}
if (!chats) {
  problems.push(
    "TELEGRAM_ALLOWED_CHAT_IDS is empty (set your Telegram chat id)"
  );
}

if (problems.length) {
  console.error("\n✗ .env needs attention:");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nEdit with:\n  nano .env\n");
  process.exit(1);
}

ok("TELEGRAM_BOT_TOKEN set");
ok("TELEGRAM_ALLOWED_CHAT_IDS set");
ok("ETH_RPC_URL set");
if (key) ok("PRIVATE_KEY set");
else console.log("! PRIVATE_KEY empty (alerts-only / dry-run until you set it)");
if (tracked) ok("TRACKED_WALLETS set");
else console.log("! TRACKED_WALLETS empty (use /track in Telegram)");

console.log("\n@porshmints_bot (Ethereum) ready. Start with:");
console.log("  npm run start:dev");
console.log("  # or production: npm run build && npm start");
console.log("  # or systemd:    sudo systemctl start porshmints-bot");
console.log("  # Keep separate from @Nftcopymint_bot (Robinhood).\n");
