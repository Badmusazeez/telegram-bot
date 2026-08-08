#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

console.log("Ancient Door Mystery — setup\n");

if (!fs.existsSync(examplePath)) {
  console.error("Missing .env.example");
  process.exit(1);
}

const token = (await ask("TELEGRAM_BOT_TOKEN (from @BotFather): ")).trim();
const allowed = (
  await ask("TELEGRAM_ALLOWED_CHAT_IDS (optional, comma-separated): ")
).trim();

if (!token) {
  console.error("Token is required.");
  process.exit(1);
}

const contents =
  `TELEGRAM_BOT_TOKEN=${token}\n` +
  `TELEGRAM_ALLOWED_CHAT_IDS=${allowed}\n`;

fs.writeFileSync(envPath, contents, "utf8");
console.log(`\nWrote ${envPath}`);
rl.close();
