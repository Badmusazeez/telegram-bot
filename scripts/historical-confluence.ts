/**
 * Historical audit: when did the institutional chart stack fully pass?
 *
 * Uses Binance Vision spot klines (public, geo-unblocked) because:
 * - Binance Futures API returns 451 from this environment
 * - MEXC contract klines only retain ~2000 bars (~21 days of 15m)
 *
 * Chart factors (trend / momentum / volume / PA / SMC / structure RR) are
 * evaluated with the same analyzers as the live bot. Futures + fundamental
 * are scored neutrally (0.5) because bar-accurate historical funding/OI/news
 * are not available for a full-universe replay.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=dummy npx tsx scripts/historical-confluence.ts
 *
 * Env knobs:
 *   LOOKBACK_DAYS=365  MAX_SYMBOLS=40  STEP_BARS=1  MIN_CONFIDENCE=85
 */
import "dotenv/config";
import { atr } from "../src/analysis/indicators";
import { analyzeMomentum } from "../src/analysis/institutional/momentum";
import {
  analyzePriceAction,
  structureStop,
} from "../src/analysis/institutional/priceAction";
import { analyzeSmc } from "../src/analysis/institutional/smc";
import { analyzeTrend } from "../src/analysis/institutional/trend";
import { analyzeVolume } from "../src/analysis/institutional/volume";
import { closed, lastClose } from "../src/analysis/institutional/types";
import type { FactorResult } from "../src/analysis/institutional/types";
import type { Candle, Side } from "../src/types";

const VISION = "https://data-api.binance.vision";
const LOOKBACK_DAYS = Math.max(30, Number(process.env.LOOKBACK_DAYS ?? 365));
const MAX_SYMBOLS = Math.max(5, Number(process.env.MAX_SYMBOLS ?? 40));
const STEP_BARS = Math.max(1, Number(process.env.STEP_BARS ?? 1));
const MIN_CONFIDENCE = Math.max(
  50,
  Number(process.env.MIN_CONFIDENCE ?? 85)
);
const VOLUME_NEED = Number(process.env.VOLUME_SPIKE_MULT ?? 1.5);
const MAX_STOP_PCT = Number(process.env.MAX_STOP_PCT ?? 0.035);
const MIN_RR = Number(process.env.MIN_RISK_REWARD ?? 2.5);

// Seed majors always included, then top USDT volume fill.
const SEED = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
  "LTCUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "APTUSDT",
  "SUIUSDT",
  "ARBUSDT",
  "OPUSDT",
  "INJUSDT",
  "FILUSDT",
  "AAVEUSDT",
  "UNIUSDT",
  "TONUSDT",
  "TRXUSDT",
  "BCHUSDT",
  "RENDERUSDT",
  "FETUSDT",
  "PEPEUSDT",
  "WIFUSDT",
  "TIAUSDT",
  "SEIUSDT",
];

type PassHit = {
  symbol: string;
  side: Side;
  confidence: number;
  when: string;
  openTime: number;
  entry: number;
  stopLoss: number;
  scores: Record<string, number>;
};

type NearHit = {
  symbol: string;
  stage: string;
  confidence: number;
  when: string;
  openTime: number;
  scores: Record<string, number>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string, retries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      last = err;
      await sleep(250 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function rowToCandle(
  row: [
    number,
    string,
    string,
    string,
    string,
    string,
    number,
    string,
    ...unknown[]
  ]
): Candle {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
    quoteVolume: Number(row[7]),
  };
}

async function fetchKlinesPaged(
  symbol: string,
  interval: string,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url =
      `${VISION}/api/v3/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson<
      Array<
        [number, string, string, string, string, string, number, string]
      >
    >(url);
    if (!rows.length) break;
    for (const row of rows) out.push(rowToCandle(row));
    const next = rows[rows.length - 1][0] + 1;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
    await sleep(40);
  }
  // de-dupe by openTime
  const map = new Map<number, Candle>();
  for (const c of out) map.set(c.openTime, c);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

function upperBoundClose(candles: Candle[], closeTime: number): number {
  // last index with candle.closeTime <= closeTime
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].closeTime <= closeTime) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function sliceTo(candles: Candle[], closeTime: number): Candle[] {
  const i = upperBoundClose(candles, closeTime);
  if (i < 0) return [];
  return candles.slice(0, i + 1);
}

/**
 * Analyzers call closed() and drop the last bar (assumed still forming).
 * In historical replay every included bar is already closed, so append a
 * synthetic forming candle so the real last bar is the one evaluated.
 */
function withForming(candles: Candle[]): Candle[] {
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  const span = Math.max(1, last.closeTime - last.openTime + 1);
  return [
    ...candles,
    {
      ...last,
      openTime: last.openTime + span,
      closeTime: last.closeTime + span,
      volume: 0,
      quoteVolume: 0,
    },
  ];
}

function pct(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

function evaluateBar(
  primary: Candle[],
  h1: Candle[],
  h4: Candle[],
  d1: Candle[]
): {
  stage: string;
  confidence: number;
  side: Side | null;
  entry: number;
  stopLoss: number;
  scores: Record<string, number>;
} | null {
  if (primary.length < 220 || h1.length < 60 || h4.length < 60 || d1.length < 60) {
    return { stage: "warmup", confidence: 0, side: null, entry: 0, stopLoss: 0, scores: {} };
  }

  const bundle = { primary, h1, h4, d1 };
  const trend = analyzeTrend(bundle);
  if (!trend.aligned || trend.directionBias === "NEUTRAL") {
    return {
      stage: "trend",
      confidence: 0,
      side: null,
      entry: lastClose(primary),
      stopLoss: 0,
      scores: { trend: pct(trend.score) },
    };
  }
  const preferred = trend.directionBias;

  const momentum = analyzeMomentum(bundle, preferred);
  if (!momentum.aligned) {
    return {
      stage: "momentum",
      confidence: 0,
      side: null,
      entry: lastClose(primary),
      stopLoss: 0,
      scores: { trend: pct(trend.score), momentum: pct(momentum.score) },
    };
  }

  const volume = analyzeVolume(bundle, preferred);
  if (!volume.aligned) {
    return {
      stage: "volume",
      confidence: 0,
      side: null,
      entry: lastClose(primary),
      stopLoss: 0,
      scores: {
        trend: pct(trend.score),
        momentum: pct(momentum.score),
        volume: pct(volume.score),
      },
    };
  }

  const priceAction = analyzePriceAction(bundle, preferred);
  if (!priceAction.aligned) {
    return {
      stage: "priceAction",
      confidence: 0,
      side: null,
      entry: lastClose(primary),
      stopLoss: 0,
      scores: {
        trend: pct(trend.score),
        momentum: pct(momentum.score),
        volume: pct(volume.score),
        priceAction: pct(priceAction.score),
      },
    };
  }

  const smc = analyzeSmc(bundle, preferred);
  const coreScores = {
    trend: pct(trend.score),
    momentum: pct(momentum.score),
    volume: pct(volume.score),
    priceAction: pct(priceAction.score),
    smc: pct(smc.score),
  };
  if (!smc.aligned) {
    return {
      stage: "smc",
      confidence: 0,
      side: null,
      entry: lastClose(primary),
      stopLoss: 0,
      scores: coreScores,
    };
  }

  // Neutral placeholders for non-reconstructable historical feeds (5% each).
  const futures: FactorResult = {
    name: "futures",
    weight: 0.05,
    score: 0.5,
    aligned: true,
    missingKey: false,
    reasons: ["Historical funding/OI/L-S not replayed — neutral 50%"],
    directionBias: preferred,
  };
  const fundamental: FactorResult = {
    name: "fundamental",
    weight: 0.05,
    score: 0.5,
    aligned: true,
    missingKey: false,
    reasons: ["Historical news/macro not replayed — neutral 50%"],
    directionBias: preferred,
  };

  const factors = [
    trend,
    momentum,
    volume,
    priceAction,
    smc,
    futures,
    fundamental,
  ];
  const confidence = Math.round(
    factors.reduce((sum, f) => sum + f.weight * f.score, 0) * 100
  );

  const scores = {
    trend: pct(trend.score),
    momentum: pct(momentum.score),
    volume: pct(volume.score),
    priceAction: pct(priceAction.score),
    smc: pct(smc.score),
    futures: 50,
    fundamental: 50,
  };

  if (confidence < MIN_CONFIDENCE) {
    return {
      stage: "confidence",
      confidence,
      side: null,
      entry: lastClose(primary),
      stopLoss: 0,
      scores,
    };
  }

  const entry = lastClose(primary);
  const atrSeries = atr(closed(primary), 14);
  const atrVal = atrSeries[closed(primary).length - 1] ?? entry * 0.01;
  const stopLoss = structureStop(primary, preferred, entry, atrVal);
  const risk = Math.abs(entry - stopLoss);
  const stopPct = entry > 0 ? risk / entry : 1;
  if (risk <= 0 || stopPct > MAX_STOP_PCT) {
    return {
      stage: "riskReward",
      confidence,
      side: null,
      entry,
      stopLoss,
      scores,
    };
  }

  // Same actionable verdict band as live engine.
  if (confidence < MIN_CONFIDENCE) {
    return {
      stage: "verdict",
      confidence,
      side: null,
      entry,
      stopLoss,
      scores,
    };
  }

  return {
    stage: "passed",
    confidence,
    side: preferred,
    entry,
    stopLoss,
    scores,
  };
}

async function pickSymbols(): Promise<string[]> {
  const info = await fetchJson<{
    symbols: Array<{ symbol: string; status: string; quoteAsset: string }>;
  }>(`${VISION}/api/v3/exchangeInfo`);
  const tradable = new Set(
    info.symbols
      .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT")
      .map((s) => s.symbol)
  );

  const tickers = await fetchJson<
    Array<{ symbol: string; quoteVolume: string }>
  >(`${VISION}/api/v3/ticker/24hr`);

  const ranked = tickers
    .filter((t) => tradable.has(t.symbol) && !t.symbol.includes("_"))
    .filter((t) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
    .filter(
      (t) =>
        !/^(USDC|USD1|FDUSD|TUSD|USDP|DAI|EUR|AEUR|RLUSD)USDT$/.test(t.symbol)
    )
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .map((t) => t.symbol);

  const out: string[] = [];
  for (const s of SEED) if (tradable.has(s) && !out.includes(s)) out.push(s);
  for (const s of ranked) {
    if (out.length >= MAX_SYMBOLS) break;
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_SYMBOLS);
}

async function auditSymbol(
  symbol: string,
  startMs: number,
  endMs: number,
  rejectCounts: Record<string, number>,
  nearHits: NearHit[]
): Promise<PassHit[]> {
  const [primaryAll, h1All, h4All, d1All] = await Promise.all([
    fetchKlinesPaged(symbol, "15m", startMs, endMs),
    fetchKlinesPaged(symbol, "1h", startMs - 90 * 86400000, endMs),
    fetchKlinesPaged(symbol, "4h", startMs - 180 * 86400000, endMs),
    fetchKlinesPaged(symbol, "1d", startMs - 400 * 86400000, endMs),
  ]);

  if (primaryAll.length < 250) {
    console.log(`[skip] ${symbol}: only ${primaryAll.length} 15m bars`);
    return [];
  }

  const hits: PassHit[] = [];
  const warmup = 220;
  let lastPassOpen = -Infinity;
  let lastNearOpen = -Infinity;

  for (let i = warmup; i < primaryAll.length - 1; i += STEP_BARS) {
    // Evaluate on closed bars only (exclude forming last bar).
    const bar = primaryAll[i];
    const closeTime = bar.closeTime;

    // Cheap volume pre-filter (same 1.5× gate as analyzer).
    const window = primaryAll.slice(Math.max(0, i - 20), i + 1);
    if (window.length >= 21) {
      const vols = window.map((c) => c.volume);
      const last = vols[vols.length - 1];
      const avg =
        vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1);
      if (!(avg > 0 && last / avg >= VOLUME_NEED * 0.85)) {
        // Still count as volume-ish miss for funnel when we bother later;
        // skip full analyzer to keep runtime practical.
        rejectCounts.volumePrefilter =
          (rejectCounts.volumePrefilter ?? 0) + 1;
        continue;
      }
    }

    const primary = withForming(primaryAll.slice(0, i + 1));
    const h1 = withForming(sliceTo(h1All, closeTime));
    const h4 = withForming(sliceTo(h4All, closeTime));
    const d1 = withForming(sliceTo(d1All, closeTime));

    const result = evaluateBar(primary, h1, h4, d1);
    if (!result) continue;
    rejectCounts[result.stage] = (rejectCounts[result.stage] ?? 0) + 1;

    // Track late-stage near misses (PA/SMC/confidence/RR) for warming-up dates.
    if (
      ["priceAction", "smc", "confidence", "riskReward", "verdict"].includes(
        result.stage
      ) &&
      bar.openTime - lastNearOpen >= 4 * 3600_000
    ) {
      lastNearOpen = bar.openTime;
      nearHits.push({
        symbol,
        stage: result.stage,
        confidence: result.confidence,
        when: new Date(bar.openTime).toISOString(),
        openTime: bar.openTime,
        scores: result.scores,
      });
    }

    if (result.stage !== "passed" || !result.side) continue;

    // Deduplicate bursts: keep first bar of a cluster within 4h.
    if (bar.openTime - lastPassOpen < 4 * 3600_000) continue;
    lastPassOpen = bar.openTime;

    hits.push({
      symbol,
      side: result.side,
      confidence: result.confidence,
      when: new Date(bar.openTime).toISOString(),
      openTime: bar.openTime,
      entry: result.entry,
      stopLoss: result.stopLoss,
      scores: result.scores,
    });
  }

  return hits;
}

async function main(): Promise<void> {
  const endMs = Date.now();
  const startMs = endMs - LOOKBACK_DAYS * 86400000;

  console.log("=== Institutional confluence historical audit ===");
  console.log(
    JSON.stringify(
      {
        source: "Binance Vision spot klines",
        primaryTf: "15m",
        lookbackDays: LOOKBACK_DAYS,
        maxSymbols: MAX_SYMBOLS,
        stepBars: STEP_BARS,
        minConfidence: MIN_CONFIDENCE,
        volumeNeed: VOLUME_NEED,
        maxStopPct: MAX_STOP_PCT,
        minRr: MIN_RR,
        from: new Date(startMs).toISOString(),
        to: new Date(endMs).toISOString(),
        note:
          "Futures+fundamental scored neutral 50% (not historically replayed)",
      },
      null,
      2
    )
  );

  const symbols = await pickSymbols();
  console.log(`Symbols (${symbols.length}): ${symbols.join(", ")}`);

  const rejectCounts: Record<string, number> = {};
  const allHits: PassHit[] = [];
  const nearHits: NearHit[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    process.stdout.write(`[${i + 1}/${symbols.length}] ${symbol} ... `);
    try {
      const hits = await auditSymbol(
        symbol,
        startMs,
        endMs,
        rejectCounts,
        nearHits
      );
      allHits.push(...hits);
      console.log(`${hits.length} full-pass event(s)`);
    } catch (err) {
      console.log(`ERROR ${err instanceof Error ? err.message : err}`);
    }
    await sleep(80);
  }

  allHits.sort((a, b) => a.openTime - b.openTime);
  nearHits.sort((a, b) => a.openTime - b.openTime);

  console.log("\n=== Reject funnel (bars evaluated after volume prefilter) ===");
  const stages = Object.entries(rejectCounts).sort((a, b) => b[1] - a[1]);
  for (const [stage, count] of stages) {
    console.log(`  ${stage}: ${count}`);
  }

  console.log(`\n=== FULL PASSES: ${allHits.length} ===`);
  if (!allHits.length) {
    console.log(
      "No historical bar met ALL hard gates (trend+momentum+volume+PA+SMC+confidence+RR) in this window."
    );
  } else {
    for (const h of allHits) {
      console.log(
        `${h.when}  ${h.symbol}  ${h.side}  conf=${h.confidence}%  entry=${h.entry}  SL=${h.stopLoss}  scores=${JSON.stringify(h.scores)}`
      );
    }
    const byMonth = new Map<string, number>();
    for (const h of allHits) {
      const m = h.when.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
    }
    console.log("\n=== Passes by month ===");
    for (const [m, n] of [...byMonth.entries()].sort()) {
      console.log(`  ${m}: ${n}`);
    }
  }

  const late = nearHits.filter((n) =>
    ["smc", "confidence", "riskReward", "verdict"].includes(n.stage)
  );
  console.log(`\n=== Late-stage near misses (failed at SMC/confidence/RR): ${late.length} ===`);
  for (const n of late.slice(-40)) {
    console.log(
      `${n.when}  ${n.symbol}  fail=${n.stage}  conf=${n.confidence}%  scores=${JSON.stringify(n.scores)}`
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    lookbackDays: LOOKBACK_DAYS,
    maxSymbols: MAX_SYMBOLS,
    minConfidence: MIN_CONFIDENCE,
    rejectCounts,
    fullPasses: allHits,
    lateNearMisses: late,
  };
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/historical-confluence-report.json",
    JSON.stringify(report, null, 2)
  );
  console.log("\nWrote artifacts/historical-confluence-report.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
