#!/usr/bin/env node
/**
 * One-command local runner.
 * Usage: npm run bot
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const npxCmd = isWin ? "npx.cmd" : "npx";

function run(cmd, args, { inherit = true } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: inherit ? "inherit" : "pipe",
    shell: isWin,
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("");
console.log("=== Starting Binance Futures AI Trading Assistant ===");
console.log(`Folder: ${root}`);
console.log("");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`Node.js 20+ required (found ${process.version}).`);
  console.error("Install from https://nodejs.org then reopen your terminal.");
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "node_modules"))) {
  console.log("Installing dependencies (npm install)…");
  run(npmCmd, ["install"]);
}

if (!fs.existsSync(path.join(root, ".env"))) {
  console.log("No .env yet — launching setup wizard…\n");
  run(process.execPath, [path.join(root, "scripts", "setup.mjs")]);
}

run(process.execPath, [path.join(root, "scripts", "check-env.mjs")]);

console.log("Starting bot (Ctrl+C to stop)…\n");
const child = spawn(npxCmd, ["tsx", "src/index.ts"], {
  cwd: root,
  stdio: "inherit",
  shell: isWin,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
