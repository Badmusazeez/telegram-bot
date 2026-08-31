import { JsonRpcProvider } from "ethers";
import { config, rpcLabels } from "../config";

export type MintRpcPick = {
  provider: JsonRpcProvider;
  label: string;
  latencyMs: number;
  urlMasked: string;
};

let primary: JsonRpcProvider | null = null;
let backup: JsonRpcProvider | null = null;
let cached: { at: number; pick: MintRpcPick } | null = null;
const CACHE_MS = 8_000;

function ensure(): void {
  if (!primary) primary = new JsonRpcProvider(config.mintRpcUrl);
  if (!backup && config.mintBackupRpcUrl) {
    backup = new JsonRpcProvider(config.mintBackupRpcUrl);
  }
}

async function ping(provider: JsonRpcProvider): Promise<number | null> {
  const t0 = Date.now();
  try {
    await Promise.race([
      provider.getBlockNumber(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2_500)),
    ]);
    return Date.now() - t0;
  } catch {
    return null;
  }
}

/**
 * Pick the fastest healthy mint RPC (primary vs backup).
 * Cached briefly so we don't probe on every wallet send.
 */
export async function pickFastestMintRpc(
  force = false
): Promise<MintRpcPick> {
  ensure();
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.pick;
  }

  const candidates: Array<{
    provider: JsonRpcProvider;
    label: string;
    urlMasked: string;
  }> = [
    {
      provider: primary!,
      label: "mint-primary",
      urlMasked: rpcLabels.mint,
    },
  ];
  if (backup) {
    candidates.push({
      provider: backup,
      label: "mint-backup",
      urlMasked: rpcLabels.mintBackup || "backup",
    });
  }

  const results = await Promise.all(
    candidates.map(async (c) => {
      const latencyMs = await ping(c.provider);
      return { ...c, latencyMs };
    })
  );

  const healthy = results
    .filter((r) => r.latencyMs != null)
    .sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number));

  const best = healthy[0] ?? {
    ...candidates[0]!,
    latencyMs: 9_999,
  };

  const pick: MintRpcPick = {
    provider: best.provider,
    label: best.label,
    latencyMs: best.latencyMs ?? 9_999,
    urlMasked: best.urlMasked,
  };
  cached = { at: Date.now(), pick };
  return pick;
}

export function clearMintRpcPickCache(): void {
  cached = null;
}
