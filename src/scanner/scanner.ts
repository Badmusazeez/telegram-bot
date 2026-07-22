import { config } from "../config";
import {
  fetchExchangePairs,
  fetchKlines,
  fetchTickers24h,
  mapPool,
} from "../exchange";
import { toMexcSymbol } from "../exchange/mexc";
import { evaluateSymbol } from "../analysis/signalEngine";
import {
  getState,
  isOnCooldown,
  rememberSignal,
  updateState,
} from "../store/state";
import type { TradeSignal } from "../types";

export type SignalHandler = (signal: TradeSignal) => Promise<void>;

function normalizeFilterSymbol(symbol: string): string {
  return config.exchange === "mexc" ? toMexcSymbol(symbol) : symbol.toUpperCase();
}

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
    const allow = new Set(config.symbolWhitelist.map(normalizeFilterSymbol));
    symbols = symbols.filter((s) => allow.has(normalizeFilterSymbol(s)));
  }

  if (config.symbolBlacklist.size > 0) {
    const deny = new Set(
      [...config.symbolBlacklist].map((s) => normalizeFilterSymbol(s))
    );
    symbols = symbols.filter((s) => !deny.has(normalizeFilterSymbol(s)));
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

  let lastError: string | null = null;

  try {
    const symbols = await selectSymbols();
    pairsScanned = symbols.length;
    if (pairsScanned === 0) {
      lastError =
        `0 pairs matched filters on ${config.exchange}. Lower MIN_QUOTE_VOLUME_USDT in .env, or the exchange returned no symbols.`;
      console.warn(`[scan] ${lastError}`);
    } else {
      console.log(
        `[scan] ${symbols.length} ${config.exchange.toUpperCase()} USDT-M perpetuals (min vol $${config.minQuoteVolumeUsdt.toLocaleString()}) on ${config.timeframe}`
      );
    }

    await mapPool(symbols, 1, async (symbol) => {
      try {
        // Sequential TF fetches — parallel bursts trigger MEXC code 510
        const primary = await fetchKlines(symbol, config.timeframe, 260);
        const h1 = await fetchKlines(symbol, "1h", 260);
        const h4 = await fetchKlines(symbol, "4h", 220);
        const d1 = await fetchKlines(symbol, "1d", 220);
        const signal = await evaluateSymbol(symbol, primary, h1, { h4, d1 });
        if (!signal) return;

        if (isOnCooldown(signal.symbol, signal.side)) {
          console.log(`[skip] ${signal.symbol} ${signal.side} on cooldown`);
          return;
        }

        const state = getState();
        if (state.recentSignalIds.includes(signal.id)) {
          return;
        }

        found.push(signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = `${symbol}: ${msg}`;
        const isRate = /510|rate limited|too frequent|429/i.test(msg);
        if (!isRate) {
          errors += 1;
          console.warn(`[warn] ${symbol}: ${msg}`);
        } else {
          console.warn(`[rate-limit] ${symbol}: backing off`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    });

    // Rank by confidence; only alert the best N per scan
    found.sort((a, b) => b.confidence - a.confidence);
    const toSend =
      config.maxAlertsPerScan > 0
        ? found.slice(0, config.maxAlertsPerScan)
        : found;

    for (const signal of toSend) {
      await rememberSignal(signal);
      console.log(
        `[signal] ${signal.side} ${signal.symbol} @ ${signal.entry} conf=${signal.confidence}% ${signal.quality}`
      );
      await onSignal(signal);
    }

    if (found.length > toSend.length) {
      console.log(
        `[scan] suppressed ${found.length - toSend.length} lower-confidence signal(s) (MAX_ALERTS_PER_SCAN=${config.maxAlertsPerScan})`
      );
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    errors += 1;
    console.error("[scan] fatal:", lastError);
  } finally {
    const duration = Date.now() - started;
    await updateState((s) => {
      s.stats.running = false;
      s.stats.lastScanAt = Date.now();
      s.stats.lastScanDurationMs = duration;
      s.stats.pairsScanned = pairsScanned;
      s.stats.errors += errors;
      if (lastError) s.stats.lastError = lastError;
      else if (errors === 0 && pairsScanned > 0) s.stats.lastError = null;
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[scan] unexpected:", msg);
      await updateState((s) => {
        s.stats.errors += 1;
        s.stats.lastError = msg;
      });
    } finally {
      running = false;
      if (!stopped) schedule();
    }
  };

  console.log(
    `[scanner] 24/7 ${config.exchange.toUpperCase()} every ${config.scanIntervalMs / 1000}s · EMA ${config.emaFast}/${config.emaSlow} · conf≥${config.minConfidence}%`
  );
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
