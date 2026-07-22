import { config } from "../config";
import {
  fetchExchangePairs,
  fetchKlines,
  fetchTickers24h,
  mapPool,
} from "../binance/client";
import { evaluateSymbol } from "../analysis/signalEngine";
import {
  getState,
  isOnCooldown,
  rememberSignal,
  updateState,
} from "../store/state";
import type { TradeSignal } from "../types";

export type SignalHandler = (signal: TradeSignal) => Promise<void>;

async function selectSymbols(): Promise<string[]> {
  const [pairs, tickers] = await Promise.all([
    fetchExchangePairs(),
    fetchTickers24h(),
  ]);

  const volumeBySymbol = new Map(
    tickers.map((t) => [t.symbol, t.quoteVolume] as const)
  );

  let symbols = pairs.map((p) => p.symbol);

  if (config.symbolWhitelist.length > 0) {
    const allow = new Set(config.symbolWhitelist);
    symbols = symbols.filter((s) => allow.has(s));
  }

  if (config.symbolBlacklist.size > 0) {
    symbols = symbols.filter((s) => !config.symbolBlacklist.has(s));
  }

  symbols = symbols.filter(
    (s) => (volumeBySymbol.get(s) ?? 0) >= config.minQuoteVolumeUsdt
  );

  symbols.sort(
    (a, b) => (volumeBySymbol.get(b) ?? 0) - (volumeBySymbol.get(a) ?? 0)
  );

  if (config.maxPairs > 0) {
    symbols = symbols.slice(0, config.maxPairs);
  }

  return symbols;
}

export async function runScan(onSignal: SignalHandler): Promise<TradeSignal[]> {
  const started = Date.now();
  const found: TradeSignal[] = [];
  let errors = 0;
  let pairsScanned = 0;

  await updateState((s) => {
    s.stats.running = true;
  });

  try {
    const symbols = await selectSymbols();
    pairsScanned = symbols.length;
    console.log(
      `[scan] ${symbols.length} USDT-M perpetuals (min vol $${config.minQuoteVolumeUsdt.toLocaleString()}) on ${config.timeframe}`
    );

    await mapPool(symbols, 4, async (symbol) => {
      try {
        const candles = await fetchKlines(symbol, config.timeframe, 180);
        const signal = await evaluateSymbol(symbol, candles);
        if (!signal) return;

        if (isOnCooldown(signal.symbol, signal.side)) {
          console.log(`[skip] ${signal.symbol} ${signal.side} on cooldown`);
          return;
        }

        const state = getState();
        if (state.recentSignalIds.includes(signal.id)) {
          return;
        }

        await rememberSignal(signal);
        found.push(signal);
        console.log(
          `[signal] ${signal.side} ${signal.symbol} @ ${signal.entry} conf=${signal.confidence}%`
        );
        await onSignal(signal);
      } catch (err) {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Invalid symbol")) {
          console.warn(`[warn] ${symbol}: ${msg}`);
        }
      }
    });
  } finally {
    const duration = Date.now() - started;
    await updateState((s) => {
      s.stats.running = false;
      s.stats.lastScanAt = Date.now();
      s.stats.lastScanDurationMs = duration;
      s.stats.pairsScanned = pairsScanned;
      s.stats.errors += errors;
    });
    console.log(
      `[scan] done in ${(duration / 1000).toFixed(1)}s — ${found.length} signal(s), ${errors} error(s)`
    );
  }

  return found;
}

export function startScanner(onSignal: SignalHandler): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const schedule = () => {
    timer = setTimeout(() => {
      void tick();
    }, config.scanIntervalMs);
  };

  const tick = async () => {
    if (stopped || running) return;
    if (getState().paused) {
      console.log("[scan] paused — use /resume in Telegram");
      schedule();
      return;
    }
    running = true;
    try {
      await runScan(onSignal);
    } catch (err) {
      console.error("[scan] fatal:", err);
      await updateState((s) => {
        s.stats.errors += 1;
      });
    } finally {
      running = false;
      if (!stopped) schedule();
    }
  };

  console.log(
    `[scanner] 24/7 loop every ${config.scanIntervalMs / 1000}s (EMA ${config.emaFast}/${config.emaSlow})`
  );
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
