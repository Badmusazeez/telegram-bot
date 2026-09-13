#!/usr/bin/env node
/**
 * Validates .env + hard separation from @Nftcopymint_bot before start.
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

// ── hard separation from Robinhood / @Nftcopymint_bot ─────────────────────
let pkgName = "";
try {
  pkgName = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  ).name;
} catch {
  fail("Cannot read package.json");
}
if (pkgName === "robinhood-nft-copy-bot") {
  fail(
    "This is the Robinhood bot package.\n  Install @porshmints_bot into ~/porshmints-bot instead."
  );
}
if (pkgName !== "porshmints-bot") {
  fail(`Wrong package "${pkgName}" (expected porshmints-bot)`);
}
ok(`package is ${pkgName} (not Robinhood)`);

if (fs.existsSync(path.join(root, "src", "robinhood"))) {
  fail("Found src/robinhood/ — wrong folder. Use ~/porshmints-bot only.");
}
ok("no src/robinhood/ (isolated tree)");

if (path.basename(root) === "telegram-bot") {
  fail(
    "Folder is named telegram-bot (Robinhood path).\n  Use a separate directory: ~/porshmints-bot"
  );
}
ok(`folder basename OK (${path.basename(root)})`);

for (const f of ["data/state.json", "data/mint-wallets.json"]) {
  if (fs.existsSync(path.join(root, f))) {
    fail(
      `Found ${f} (Robinhood state).\n  This bot only uses data/porshmints-*.json — wrong/mixed install.`
    );
  }
}
ok("no Robinhood data/state.json collision");

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
  process.env.INK_RPC_URL ||
  process.env.ETH_RPC_URL ||
  process.env.RPC_URL ||
  ""
).trim();
const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "").trim();
const key = (process.env.PRIVATE_KEY || "").trim();
const tracked = (process.env.TRACKED_WALLETS || "").trim();
const chain = (process.env.CHAIN || "ink").trim().toLowerCase();

if (chain === "robinhood" || chain === "rh" || chain === "4663") {
  fail(
    `CHAIN=${chain} is Robinhood.\n  @porshmints_bot must use CHAIN=ink only.`
  );
}
if (chain === "ethereum" || chain === "eth" || chain === "1") {
  fail(
    `CHAIN=${chain} is Ethereum mainnet.\n  @porshmints_bot is Ink-only (CHAIN=ink).`
  );
}
if (chain && chain !== "ink" && chain !== "inkchain" && chain !== "inkonchain") {
  fail(`CHAIN=${chain} unsupported. Use CHAIN=ink`);
}
ok(`CHAIN=${chain || "ink"} (Ink)`);

const problems = [];
if (!token) problems.push("TELEGRAM_BOT_TOKEN is empty");
if (!rpc) {
  problems.push(
    "ETH_RPC_URL / INK_RPC_URL missing (e.g. https://rpc-gel.inkonchain.com)"
  );
}
if (rpc.includes("eth-mainnet.g.alchemy.com") || rpc.includes("YOUR_KEY")) {
  problems.push(
    "ETH_RPC_URL still looks like Ethereum/placeholder — use an Ink RPC (https://rpc-gel.inkonchain.com)"
  );
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
  console.error(
    "Remember: TELEGRAM_BOT_TOKEN must be @porshmints_bot — never @Nftcopymint_bot.\n"
  );
  process.exit(1);
}

ok("TELEGRAM_BOT_TOKEN set (must be @porshmints_bot only)");
ok("TELEGRAM_ALLOWED_CHAT_IDS set");
ok("Ink RPC set (ETH_RPC_URL / INK_RPC_URL)");
if (key) ok("PRIVATE_KEY set (Ink wallet — not Robinhood key)");
else console.log("! PRIVATE_KEY empty (alerts-only / dry-run until you set it)");
if (tracked) ok("TRACKED_WALLETS set");
else console.log("! TRACKED_WALLETS empty (use /track in Telegram)");

// Optional live token check against BotFather identity
if (token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = await res.json();
    if (!body.ok) {
      fail(
        `Telegram getMe failed: ${body.description || res.status}\n  Check TELEGRAM_BOT_TOKEN for @porshmints_bot.`
      );
    }
    const username = String(body.result?.username || "");
    if (username.toLowerCase() === "nftcopymint_bot") {
      fail(
        `Token belongs to @${username} (Robinhood bot).\n  Create a NEW @BotFather token for @porshmints_bot.`
      );
    }
    if (username.toLowerCase() !== "porshmints_bot") {
      fail(
        `Token is @${username}, expected @porshmints_bot.\n  Use the correct BotFather bot / token.`
      );
    }
    ok(`Telegram token is @${username} (not @Nftcopymint_bot)`);
  } catch (err) {
    console.log(
      `! Could not verify token with Telegram API (${err?.message || err}). Continuing.`
    );
  }
}

console.log("\n@porshmints_bot (Ink) ready — isolated from @Nftcopymint_bot.");
console.log("Start with:");
console.log("  ./run.sh");
console.log("  # or: npm run start:dev");
console.log("  # production: npm run build && npm start");
console.log("  # systemd:    sudo systemctl start porshmints-bot");
console.log(
  "\nDo NOT restart or edit the Robinhood bot service for this install.\n"
);
