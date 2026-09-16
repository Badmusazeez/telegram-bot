/**
 * Import tracked (/track) wallets from another bot's data/state.json
 * (e.g. Robinhood → Arc) without printing private keys.
 *
 * Usage:
 *   npm run import-tracks -- /path/to/state.json
 *   npm run import-tracks -- /path/to/state.json --replace
 */
import { promises as fs } from "fs";
import path from "path";

type TrackedWallet = {
  address?: string;
  label?: string;
  addedAt?: string;
};

type StateFile = {
  trackedWallets?: TrackedWallet[];
  [key: string]: unknown;
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const replace = args.includes("--replace");
  const src = args.find((a) => !a.startsWith("--"));
  if (!src) {
    console.error(
      "Usage: npm run import-tracks -- /path/to/state.json [--replace]"
    );
    process.exit(1);
  }

  const abs = path.resolve(src);
  const raw = await fs.readFile(abs, "utf8");
  const parsed = JSON.parse(raw) as StateFile;
  const incoming = Array.isArray(parsed.trackedWallets)
    ? parsed.trackedWallets
    : [];
  if (incoming.length === 0) {
    throw new Error(
      "Source state.json has no trackedWallets (empty or missing)"
    );
  }

  const outDir = path.resolve(__dirname, "..", "data");
  const outFile = path.join(outDir, "state.json");
  await fs.mkdir(outDir, { recursive: true });

  let dest: StateFile = {
    trackedWallets: [],
    copyEnabled: false,
    dryRun: true,
    freeMintsOnly: true,
    priceAlertsEnabled: true,
    priceAlertPct: 10,
    maxBuyRobinhood: 0.05,
    allowedCollections: [],
    lastProcessedBlock: 0,
    notifyChatIds: [],
    recentTxHashes: [],
    watchedPrices: [],
    scheduledMints: [],
  };

  try {
    dest = {
      ...dest,
      ...(JSON.parse(await fs.readFile(outFile, "utf8")) as StateFile),
    };
  } catch {
    // fresh state
  }

  const byAddr = new Map<string, TrackedWallet>();
  if (!replace) {
    for (const w of dest.trackedWallets ?? []) {
      if (!w?.address) continue;
      const addr = normalizeAddress(w.address);
      byAddr.set(addr, {
        address: addr,
        label: w.label || shortAddress(addr),
        addedAt: w.addedAt || new Date().toISOString(),
      });
    }
  }

  let added = 0;
  for (const w of incoming) {
    if (!w?.address) continue;
    const addr = normalizeAddress(w.address);
    if (!/^0x[a-f0-9]{40}$/.test(addr)) continue;
    if (!byAddr.has(addr)) added++;
    byAddr.set(addr, {
      address: addr,
      label: (w.label || "").trim() || shortAddress(addr),
      addedAt: w.addedAt || new Date().toISOString(),
    });
  }

  const merged = [...byAddr.values()];
  dest.trackedWallets = merged;

  await fs.writeFile(outFile, JSON.stringify(dest, null, 2), "utf8");

  console.log(
    `Imported tracked wallets into ${outFile}\n` +
      `source=${incoming.length} added=${added} total=${merged.length}\n` +
      `addresses:\n` +
      merged.map((w, i) => `  ${i + 1}. ${w.address}  ${w.label}`).join("\n")
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
