/**
 * Import mint wallets from another bot's data/mint-wallets.json
 * (e.g. copy from Mac Robinhood bot) without printing private keys.
 *
 * Usage:
 *   npm run import-keys -- /path/to/mint-wallets.json
 *   npm run import-keys -- /path/to/mint-wallets.json --replace
 */
import { promises as fs } from "fs";
import path from "path";
import { Wallet } from "ethers";

type Rec = {
  address?: string;
  privateKey?: string;
  label?: string;
  addedAt?: string;
};

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const replace = args.includes("--replace");
  const src = args.find((a) => !a.startsWith("--"));
  if (!src) {
    console.error(
      "Usage: npm run import-keys -- /path/to/mint-wallets.json [--replace]"
    );
    process.exit(1);
  }

  const abs = path.resolve(src);
  const raw = await fs.readFile(abs, "utf8");
  const parsed = JSON.parse(raw) as Rec[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Source file empty or not an array");
  }

  const outDir = path.resolve(__dirname, "..", "data");
  const outFile = path.join(outDir, "mint-wallets.json");
  await fs.mkdir(outDir, { recursive: true });

  let existing: Rec[] = [];
  if (!replace) {
    try {
      existing = JSON.parse(await fs.readFile(outFile, "utf8")) as Rec[];
    } catch {
      existing = [];
    }
  }

  const byAddr = new Map<string, Rec>();
  for (const w of existing) {
    if (w.privateKey) {
      const addr = new Wallet(w.privateKey).address.toLowerCase();
      byAddr.set(addr, {
        address: addr,
        privateKey: w.privateKey.startsWith("0x")
          ? w.privateKey
          : `0x${w.privateKey}`,
        label: w.label || addr.slice(0, 10),
        addedAt: w.addedAt || new Date().toISOString(),
      });
    }
  }

  let added = 0;
  for (const w of parsed) {
    if (!w.privateKey) continue;
    const key = w.privateKey.startsWith("0x") ? w.privateKey : `0x${w.privateKey}`;
    const addr = new Wallet(key).address.toLowerCase();
    if (!byAddr.has(addr)) added++;
    byAddr.set(addr, {
      address: addr,
      privateKey: key,
      label: w.label || addr.slice(0, 10),
      addedAt: w.addedAt || new Date().toISOString(),
    });
  }

  const merged = [...byAddr.values()];
  await fs.writeFile(outFile, JSON.stringify(merged, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log(
    `Imported into ${outFile}\n` +
      `source=${parsed.length} added=${added} total=${merged.length}\n` +
      `addresses:\n` +
      merged.map((w, i) => `  ${i + 1}. ${w.address}`).join("\n")
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
