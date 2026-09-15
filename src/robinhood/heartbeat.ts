import { formatEther } from "ethers";
import { config } from "../config";
import { getState } from "../store/state";
import { getBlockscoutStatus } from "./blockscoutWatcher";
import { getLastCopySummary } from "./copyExecutor";
import { getAllMintWallets, getMintProvider } from "./provider";
import { getActiveTrackRole } from "./trackRpc";

const HEARTBEAT_MS = 2 * 60 * 60 * 1000; // 2 hours

export type HeartbeatSender = (html: string) => Promise<void>;

/**
 * Periodic Telegram pulse so you know watchers are alive.
 * Mentions low gas on mint wallets when balance is thin.
 */
export function startHeartbeat(send: HeartbeatSender): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const state = getState();
      const bs = getBlockscoutStatus();
      const lastCopy = getLastCopySummary();
      const wallets = getAllMintWallets();
      const provider = getMintProvider();

      let lowGasNote = "";
      if (wallets.length > 0) {
        const bals = await Promise.all(
          wallets.map(async (w) => {
            try {
              const bal = await provider.getBalance(w.address);
              return { addr: w.address, bal };
            } catch {
              return { addr: w.address, bal: null as bigint | null };
            }
          })
        );
        const low = bals.filter(
          (b) => b.bal !== null && b.bal < 100_000_000_000_000n // 0.0001
        );
        if (low.length > 0) {
          lowGasNote =
            `\n⚠️ <b>Low gas</b> on ${low.length} mint wallet(s): ` +
            low
              .map(
                (b) =>
                  `<code>${b.addr.slice(0, 8)}…</code> ${
                    b.bal !== null ? formatEther(b.bal) : "?"
                  } RH`
              )
              .join(", ");
        }
      }

      const text = [
        `<b>🤖 Bot heartbeat</b>`,
        ``,
        `<b>Chain:</b> ${config.chain.name}`,
        `<b>Tracked:</b> ${state.trackedWallets.length} wallet(s)`,
        `<b>Auto-mint:</b> ${state.copyEnabled ? "ON" : "OFF"} · dryRun=${state.dryRun ? "on" : "off"}`,
        `<b>Free-mints-only:</b> ${state.freeMintsOnly ? "yes" : "no"}`,
        `<b>Max mint qty:</b> ${config.maxMintQuantity}`,
        `<b>Track RPC:</b> ${getActiveTrackRole()}`,
        `<b>Blockscout:</b> ${bs.lastOkAt ? `ok ${bs.lastOkAt}` : "waiting"}` +
          (bs.lastError ? ` · lastErr=${bs.lastError.slice(0, 80)}` : ""),
        lastCopy
          ? `<b>Last copy:</b> ${lastCopy.success ? "✅" : "❌"} ${lastCopy.reason.slice(0, 120)}`
          : `<b>Last copy:</b> none yet`,
        lowGasNote,
        ``,
        `<i>Paths: pending WSS → Blockscout → tip-scan → Alchemy logs</i>`,
      ]
        .filter((l) => l !== undefined)
        .join("\n");

      await send(text);
      console.log("[heartbeat] sent");
    } catch (err) {
      console.warn(
        `[heartbeat] failed: ${err instanceof Error ? err.message : err}`
      );
    }
  };

  // First pulse after 5 min (avoid boot spam), then every 2h.
  const first = setTimeout(() => void tick(), 5 * 60_000);
  const timer = setInterval(() => void tick(), HEARTBEAT_MS);

  console.log("[heartbeat] Telegram pulse every 2h (first in 5m)");

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
