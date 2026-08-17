import { getState, rememberTxFast } from "../store/state";
import type { NftPurchase } from "../types";
import type { PurchaseHandler, RpcIssueHandler } from "./monitor";
import {
  ZERO_ADDRESS,
  decodeNftFromMintCalldata,
  isMintLikeCalldata,
  valueFromWei,
} from "./mintDetect";
import { classifyTrackRpcError } from "./rpcHealth";
import { withTrackRpc } from "./trackRpc";

/**
 * Confirmed-path backup: walk a few new Alchemy tip blocks and catch
 * tracked-wallet outbound mint txs that Blockscout/pending may have missed.
 * Cheap — only scans newly mined blocks (≤4 per tick).
 */
export async function startTipScanWatcher(
  onPurchase: PurchaseHandler,
  onRpcIssue?: RpcIssueHandler
): Promise<() => void> {
  let stopped = false;
  let inFlight = false;
  let lastBlock = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const fire = (purchase: NftPurchase) => {
    void (async () => {
      if (stopped) return;
      try {
        await onPurchase(purchase);
      } catch (err) {
        console.error(
          `[tip-scan] handler failed for ${purchase.txHash}:`,
          err instanceof Error ? err.message : err
        );
      }
    })();
  };

  const scan = async (): Promise<void> => {
    if (stopped || inFlight) return;
    const state = getState();
    if (state.trackedWallets.length === 0) return;

    inFlight = true;
    try {
      const tip = await withTrackRpc((p) => p.getBlockNumber());
      if (lastBlock === 0) {
        lastBlock = Math.max(0, tip - 1);
        return;
      }
      if (tip <= lastBlock) return;

      const from = lastBlock + 1;
      const to = tip - from > 3 ? from + 3 : tip;
      const buyers = new Map(
        state.trackedWallets.map((w) => [
          w.address.toLowerCase(),
          w.address.toLowerCase(),
        ] as const)
      );

      for (let bn = from; bn <= to; bn++) {
        const block = await withTrackRpc((p) =>
          p.getBlock(bn, true)
        );
        if (!block?.prefetchedTransactions?.length) continue;

        for (const tx of block.prefetchedTransactions) {
          const fromAddr = (tx.from || "").toLowerCase();
          if (!buyers.has(fromAddr)) continue;
          if (!tx.to || !tx.data || tx.data === "0x") continue;
          if (!isMintLikeCalldata(tx.to, tx.data)) continue;

          const valueRobinhood = valueFromWei(tx.value);
          if (state.freeMintsOnly && valueRobinhood > 0) continue;

          const txHash = (tx.hash || "").toLowerCase();
          if (!txHash) continue;

          const to = tx.to.toLowerCase();
          const input = tx.data.toLowerCase();
          const nft = decodeNftFromMintCalldata(input) || to || ZERO_ADDRESS;
          const dedupeKey = `${txHash}:${nft}:mint`;
          if (!rememberTxFast(dedupeKey)) continue;

          console.log(
            `[tip-scan] hit ${txHash.slice(0, 12)}… blk=${bn} from=${fromAddr.slice(0, 8)}…`
          );

          fire({
            txHash,
            buyer: fromAddr,
            seller: ZERO_ADDRESS,
            contract: nft,
            tokenId: "0",
            valueRobinhood,
            blockNumber: bn,
            timestamp: block.timestamp
              ? Number(block.timestamp)
              : Math.floor(Date.now() / 1000),
            marketplace: "free-mint",
            isFreeMint: true,
            isPaid: valueRobinhood > 0,
            sourceTo: to || undefined,
            sourceData: input || undefined,
            detectedAtMs: Date.now(),
          });
        }
      }
      lastBlock = to;
    } catch (err) {
      const issue = classifyTrackRpcError(err);
      if (issue && onRpcIssue) {
        void onRpcIssue(issue);
      }
      console.warn(
        `[tip-scan] tick failed: ${err instanceof Error ? err.message : err}`
      );
    } finally {
      inFlight = false;
    }
  };

  void scan();
  timer = setInterval(() => void scan(), 2_500);
  console.log("[tip-scan] Alchemy tip-block backup every 2500ms (≤4 blocks/tick)");

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
}
