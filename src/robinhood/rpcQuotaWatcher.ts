import { config } from "../config";
import {
  collectRpcQuotaReport,
  formatRpcQuotaReport,
} from "./rpcQuota";

export type RpcQuotaSender = (html: string) => Promise<void>;

/**
 * Telegram RPC quota % pulse every 6 hours (Alchemy + Chainstack).
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
