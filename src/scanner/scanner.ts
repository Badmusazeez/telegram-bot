import { config } from "../config";
import {
  fetchExchangePairs,
  fetchKlines,
  fetchTickers24h,
  mapPool,
} from "../exchange";
import { toMexcSymbol } from "../exchange/mexc";
import {
  bumpReject,
  emptyFunnel,
  finalizeFunnel,
  formatFunnelLog,
} from "../analysis/funnel";
import { evaluateSymbol } from "../analysis/signalEngine";
import {
  getState,
  isOnCooldown,
  rememberSignal,
  updateState,
} from "../store/state";
import type { ScanFunnel, TradeSignal } from "../types";

export type SignalHandler = (signal: TradeSignal) => Promise<void>;

function normalizeFilterSymbol(symbol: string): string {
  return config.exchange === "mexc" ? toMexcSymbol(symbol) : symbol.toUpperCase();
}

async function selectSymbols(): Promise<{
  symbols: string[];
  totalUniverse: number;
  passedLiquidity: number;
}> {
  const [pairs, tickers] = await Promise.all([
    fetchExchangePairs(),
    fetchTickers24h(),
  ]);

  const volumeBySymbol = new Map(
    tickers.map((t) => [t.symbol, t.quoteVolume] as const)
  );

  let symbols = pairs.map((p) => p.symbol);
  const totalUniverse = symbols.length;

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
  const passedLiquidity = symbols.length;

  symbols.sort(
    (a, b) => (volumeBySymbol.get(b) ?? 0) - (volumeBySymbol.get(a) ?? 0)
  );

  if (config.maxPairs > 0) {
    symbols = symbols.slice(0, config.maxPairs);
  }

  return { symbols, totalUniverse, passedLiquidity };
}

function recordEval(funnel: ScanFunnel, stage: string): void {
  const passedThrough: Record<string, () => void> = {
    trend: () => {
      bumpReject(funnel, "trend");
    },
    momentum: () => {
      funnel.passedTrend += 1;
      bumpReject(funnel, "momentum");
    },
    volume: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      bumpReject(funnel, "volume");
    },
    priceAction: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      bumpReject(funnel, "priceAction");
    },
    smc: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      funnel.passedPriceAction += 1;
      bumpReject(funnel, "smc");
    },
    conflict: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      funnel.passedPriceAction += 1;
      funnel.passedSmc += 1;
      bumpReject(funnel, "conflict");
    },
    confidence: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      funnel.passedPriceAction += 1;
      funnel.passedSmc += 1;
      bumpReject(funnel, "confidence");
    },
    riskReward: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      funnel.passedPriceAction += 1;
      funnel.passedSmc += 1;
      funnel.passedConfidence += 1;
      bumpReject(funnel, "riskReward");
    },
    verdict: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      funnel.passedPriceAction += 1;
      funnel.passedSmc += 1;
      funnel.passedConfidence += 1;
      funnel.passedRiskReward += 1;
      bumpReject(funnel, "verdict");
    },
    passed: () => {
      funnel.passedTrend += 1;
      funnel.passedMomentum += 1;
      funnel.passedVolume += 1;
      funnel.passedPriceAction += 1;
      funnel.passedSmc += 1;
      funnel.passedConfidence += 1;
      funnel.passedRiskReward += 1;
      funnel.finalSignals += 1;
    },
  };

  const fn = passedThrough[stage];
  if (fn) fn();
  else bumpReject(funnel, "scanned");
}

export async function runScan(onSignal: SignalHandler): Promise<TradeSignal[]> {
  const started = Date.now();
  const found: TradeSignal[] = [];
  let errors = 0;
  let pairsScanned = 0;
  const funnel = emptyFunnel();
  const nearMissCandidates: Array<{ line: string; distance: number }> = [];

  await updateState((s) => {
    s.stats.running = true;
  });

  let lastError: string | null = null;

  try {
    const selected = await selectSymbols();
    const symbols = selected.symbols;
    funnel.totalUniverse = selected.totalUniverse;
    funnel.passedLiquidity = selected.passedLiquidity;
    pairsScanned = symbols.length;
    funnel.scanned = pairsScanned;

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
        const primary = await fetchKlines(symbol, config.timeframe, 260);
        const h1 = await fetchKlines(symbol, "1h", 260);
        const h4 = await fetchKlines(symbol, "4h", 220);
        const d1 = await fetchKlines(symbol, "1d", 220);
        const result = await evaluateSymbol(symbol, primary, h1, { h4, d1 });
        recordEval(funnel, result.stage);
        if (result.nearMissLine && result.stage !== "passed") {
          nearMissCandidates.push({
            line: result.nearMissLine,
            distance: result.nearMissDistance,
          });
        }

        if (!result.signal) return;

        if (isOnCooldown(result.signal.symbol, result.signal.side)) {
          console.log(
            `[skip] ${result.signal.symbol} ${result.signal.side} on cooldown`
          );
          return;
        }

        const state = getState();
        if (state.recentSignalIds.includes(result.signal.id)) {
          return;
        }

        found.push(result.signal);
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
    finalizeFunnel(funnel);
    nearMissCandidates.sort((a, b) => a.distance - b.distance);
    // Ranked scorecards (per-stage %); keep a few for /status + logs
    funnel.nearMisses = nearMissCandidates.slice(0, 5).map((n) => n.line);
    const duration = Date.now() - started;
    await updateState((s) => {
      s.stats.running = false;
      s.stats.lastScanAt = Date.now();
      s.stats.lastScanDurationMs = duration;
      s.stats.pairsScanned = pairsScanned;
      s.stats.errors += errors;
      s.stats.lastFunnel = funnel;
      if (lastError) s.stats.lastError = lastError;
      else if (errors === 0 && pairsScanned > 0) s.stats.lastError = null;
    });
    console.log(
      `[scan] done in ${(duration / 1000).toFixed(1)}s — ${found.length} signal(s), ${errors} error(s)`
    );
    console.log(`[funnel]\n${formatFunnelLog(funnel)}`);
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
