import { getState, rememberTxFast } from "../store/state";
import type { NftPurchase } from "../types";
import type { PurchaseHandler, RpcIssueHandler } from "./monitor";
import {
  ZERO_ADDRESS,
  httpRpcToWss,
  classifyMintCalldata,
  valueFromWei,
} from "./mintDetect";
import { config } from "../config";
import { classifyTrackRpcError } from "./rpcHealth";

/**
 * Pending-tx watcher — fires BEFORE block confirmation when supported.
 * Prefers Chainstack backup WSS when Alchemy track is primary (CU exhaustion).
 * Alchemy → alchemy_pendingTransactions; others → newPendingTransactions + getTx.
 */
export async function startPendingWatcher(
  onPurchase: PurchaseHandler,
  onRpcIssue?: RpcIssueHandler
): Promise<() => void> {
  // Prefer Chainstack backup WSS when Alchemy is the primary track RPC —
  // Alchemy pending dies when monthly CU is full.
  const httpUrl =
    config.trackBackupRpcUrl && /alchemy\.com/i.test(config.trackRpcUrl)
      ? config.trackBackupRpcUrl
      : config.trackRpcUrl;
  const wssUrl = httpRpcToWss(httpUrl);
  const useAlchemyPending = /alchemy\.com/i.test(httpUrl);
  if (!wssUrl.startsWith("ws")) {
    console.warn("[pending] no WSS URL derived from track RPC — skipped");
    return () => undefined;
  }
  console.log(
    `[pending] WSS via ${/chainstack/i.test(httpUrl) ? "Chainstack backup" : "primary track RPC"}` +
      ` (${useAlchemyPending ? "alchemy_pendingTransactions" : "newPendingTransactions"})`
  );

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let subId: string | null = null;
  let rpcId = 2;
  const pendingHashFetches = new Set<string>();

  const fire = (purchase: NftPurchase) => {
    void (async () => {
      if (stopped) return;
      try {
        await onPurchase(purchase);
      } catch (err) {
        console.error(
          `[pending] handler failed for ${purchase.txHash}:`,
          err instanceof Error ? err.message : err
        );
      }
    })();
  };

  const handlePendingTx = (tx: {
    hash?: string;
    from?: string;
    to?: string;
    input?: string;
    value?: string;
  }) => {
    const state = getState();
    if (state.trackedWallets.length === 0) return;

    const from = (tx.from || "").toLowerCase();
    const buyers = new Set(
      state.trackedWallets.map((w) => w.address.toLowerCase())
    );
    if (!buyers.has(from)) return;

    const to = (tx.to || "").toLowerCase();
    const input = (tx.input || "").toLowerCase();
    const valueRobinhood = valueFromWei(tx.value);
    const valueWei =
      tx.value && tx.value !== "0" ? BigInt(tx.value) : 0n;
    const classified = classifyMintCalldata(to, input, undefined, valueWei, {
      acceptUnknownZeroValue: valueWei === 0n,
    });
    if (!classified.isMint) return;

    // Fire immediately on mint-like calldata. Paid (value>0) skipped only when
    // free-mints-only is on — value=0 attempts revert on-chain if stage is paid.
    if (state.freeMintsOnly && valueRobinhood > 0) return;

    const txHash = (tx.hash || "").toLowerCase();
    if (!txHash) return;

    const nft = classified.nftContract || to || ZERO_ADDRESS;
    // Dedupe by tx only so we don't wait for contract decode — fastest path.
    const dedupeKey = `${txHash}:${nft}:mint`;
    if (!rememberTxFast(dedupeKey)) return;

    console.log(
      `[pending] INSTANT hit ${txHash.slice(0, 12)}… from=${from.slice(0, 8)}… ` +
        `fn=${classified.functionLabel} conf=${classified.confidence}`
    );

    fire({
      txHash,
      buyer: from,
      seller: ZERO_ADDRESS,
      contract: nft,
      tokenId: "0",
      valueRobinhood,
      blockNumber: 0,
      timestamp: Math.floor(Date.now() / 1000),
      marketplace: "free-mint",
      isFreeMint: valueRobinhood <= 0,
      isPaid: valueRobinhood > 0,
      sourceTo: to || undefined,
      sourceData: input || undefined,
      detectedAtMs: Date.now(),
    });
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(wssUrl);
    } catch (err) {
      console.warn(
        `[pending] WebSocket create failed: ${err instanceof Error ? err.message : err}`
      );
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (stopped || !ws) return;
      const addresses = getState().trackedWallets.map((w) =>
        w.address.toLowerCase()
      );
      if (addresses.length === 0) {
        console.warn("[pending] no tracked wallets yet — waiting");
      }
      const payload = useAlchemyPending
        ? {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: [
              "alchemy_pendingTransactions",
              {
                fromAddress: addresses.length ? addresses : undefined,
                hashesOnly: false,
              },
            ],
          }
        : {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["newPendingTransactions"],
          };
      ws.send(JSON.stringify(payload));
      console.log(
        `[pending] subscribed ${
          useAlchemyPending
            ? "alchemy_pendingTransactions"
            : "newPendingTransactions"
        } for ${addresses.length} wallet(s) via WSS`
      );

      pingTimer = setInterval(() => {
        try {
          // Node undici WebSocket may not expose ping(); keep-alive via traffic is enough.
          const sock = ws as WebSocket & { ping?: () => void };
          sock.ping?.();
        } catch {
          // ignore
        }
      }, 25_000);
    };

    const fetchPendingByHash = (hash: string) => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      const h = hash.toLowerCase();
      if (!h || pendingHashFetches.has(h) || pendingHashFetches.size > 40) return;
      pendingHashFetches.add(h);
      const id = rpcId++;
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "eth_getTransactionByHash",
          params: [h],
        })
      );
      // Drop from in-flight set shortly even if no reply (avoid leak).
      setTimeout(() => pendingHashFetches.delete(h), 8_000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          method?: string;
          params?: { subscription?: string; result?: unknown };
          error?: { message?: string };
        };
        if (msg.error) {
          console.warn(`[pending] subscribe error: ${msg.error.message}`);
          const issue = classifyTrackRpcError(msg.error);
          if (issue && onRpcIssue) void onRpcIssue(issue);
          return;
        }
        if (msg.id === 1 && typeof msg.result === "string") {
          subId = msg.result;
          return;
        }
        // Chainstack path: eth_getTransactionByHash replies
        if (
          !useAlchemyPending &&
          typeof msg.id === "number" &&
          msg.id >= 2 &&
          msg.result &&
          typeof msg.result === "object"
        ) {
          const tx = msg.result as {
            hash?: string;
            from?: string;
            to?: string;
            input?: string;
            value?: string;
          };
          if (tx.hash) handlePendingTx(tx);
          return;
        }
        if (msg.method === "eth_subscription" && msg.params?.result) {
          const result = msg.params.result;
          if (typeof result === "object" && result && "hash" in result) {
            handlePendingTx(
              result as {
                hash?: string;
                from?: string;
                to?: string;
                input?: string;
                value?: string;
              }
            );
          } else if (
            !useAlchemyPending &&
            typeof result === "string" &&
            result.startsWith("0x")
          ) {
            fetchPendingByHash(result);
          }
        }
      } catch {
        // ignore malformed
      }
    };

    ws.onerror = () => {
      console.warn("[pending] WebSocket error");
    };

    ws.onclose = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      subId = null;
      ws = null;
      if (!stopped) {
        console.warn("[pending] WebSocket closed — reconnecting…");
        scheduleReconnect();
      }
    };
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // Resubscribe with latest tracked wallet list
      connect();
    }, 3_000);
  };

  connect();

  // Re-subscribe periodically so newly /track'ed wallets are included
  const refreshTimer = setInterval(() => {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.close();
    } catch {
      // reconnect via onclose
    }
  }, 5 * 60_000);

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    clearInterval(refreshTimer);
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}
