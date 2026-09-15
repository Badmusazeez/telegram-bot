import { config } from "../config";
import {
  collectRpcQuotaReport,
  formatRpcQuotaReport,
} from "./rpcQuota";
import { forceTrackBackup, hasTrackBackup } from "./trackRpc";

export type RpcQuotaSender = (html: string) => Promise<void>;

/** Auto-failover Alchemy → Chainstack track backup at this CU %. */
const ALCHEMY_FAILOVER_PCT = 90;

/**
 * Telegram RPC quota % pulse every 6 hours (Alchemy + Chainstack).
 * When Alchemy is FULL / ≥90%, force tracker onto Chainstack backup.
 */
export function startRpcQuotaWatcher(send: RpcQuotaSender): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const report = await collectRpcQuotaReport();
      const html = formatRpcQuotaReport(report);
      await send(html);
      console.log(
        `[rpc-quota] alchemy=${report.alchemy.percentUsed ?? "?"}%% ` +
          `${report.alchemy.status} chainstack=${report.chainstack.percentUsed ?? "?"}%% ` +
          `${report.chainstack.status}`
      );

      const pct = report.alchemy.percentUsed;
      const alchemyDead =
        report.alchemy.status === "FULL" ||
        (pct != null && pct >= ALCHEMY_FAILOVER_PCT);
      if (alchemyDead && hasTrackBackup()) {
        const ok = await forceTrackBackup(
          `Alchemy quota ${pct ?? "?"}% (${report.alchemy.status}) — using Chainstack track backup`
        );
        if (ok) {
          await send(
            [
              `<b>🔀 Alchemy nearly full — tracker switched to Chainstack</b>`,
              `Alchemy: <b>${pct ?? "?"}%</b> (${report.alchemy.status})`,
              `Tracking continues on Chainstack backup so mints keep firing.`,
              `Mint RPC was already Chainstack.`,
            ].join("\n")
          );
        }
      }
    } catch (err) {
      console.warn(
        `[rpc-quota] failed: ${err instanceof Error ? err.message : err}`
      );
    }
  };

  // First report ~2 minutes after boot, then every 6h (configurable).
  const interval = config.rpcQuotaIntervalMs;
  const first = setTimeout(() => void tick(), 2 * 60_000);
  const timer = setInterval(() => void tick(), interval);

  console.log(
    `[rpc-quota] Telegram report every ${Math.round(interval / 3_600_000)}h (first in 2m)`
  );

  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
