#!/usr/bin/env node
/**
 * One-command local runner.
 * Usage: npm run bot
 *
 * On Windows, avoid `shell: true` + `npx` — paths like
 * `C:\Program Files\nodejs\...` get split at the space ("C:\Program").
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const require = createRequire(import.meta.url);

function run(cmd, args, { inherit = true, shell = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: inherit ? "inherit" : "pipe",
    shell,
    env: process.env,
    windowsHide: true,
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
  // npm.cmd needs a shell on some Windows setups, but quote-safe via npm.cmd name only
  run(npmCmd, ["install"], { shell: isWin });
}

if (!fs.existsSync(path.join(root, ".env"))) {
  console.log("No .env yet — launching setup wizard…\n");
  run(process.execPath, [path.join(root, "scripts", "setup.mjs")]);
}

run(process.execPath, [path.join(root, "scripts", "check-env.mjs")]);

let tsxCli;
try {
  tsxCli = require.resolve("tsx/cli", { paths: [root] });
} catch {
  console.error("tsx is not installed. Run: npm install");
  process.exit(1);
}

console.log("Starting bot (Ctrl+C to stop)…\n");
const child = spawn(
  process.execPath,
  [tsxCli, path.join(root, "src", "index.ts")],
  {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: process.env,
    windowsHide: true,
  }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
