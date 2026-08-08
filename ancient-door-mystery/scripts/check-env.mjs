#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env — run: npm run setup");
  process.exit(1);
}

const text = fs.readFileSync(envPath, "utf8");
const token = text
  .split("\n")
  .find((line) => line.startsWith("TELEGRAM_BOT_TOKEN="))
  ?.slice("TELEGRAM_BOT_TOKEN=".length)
  .trim();

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is empty in .env");
  process.exit(1);
}

console.log(".env looks ready.");
