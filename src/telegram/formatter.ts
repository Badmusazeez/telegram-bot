import { config } from "../config";
import type { ScannerStats, TradeSignal } from "../types";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toPrecision(4);
}

function chartUrl(signal: TradeSignal): string {
  if (signal.exchange === "mexc") {
    return `https://www.mexc.com/futures/${encodeURIComponent(signal.symbol)}`;
  }
  return `https://www.binance.com/en/futures/${encodeURIComponent(signal.symbol)}`;
}

export function formatSignalAlert(signal: TradeSignal): string {
  const emoji =
    signal.side === "BUY"
      ? signal.verdict?.includes("STRONG")
        ? "🟢🔥"
        : "🟢"
      : signal.verdict?.includes("STRONG")
        ? "🔴🔥"
        : "🔴";

  const direction = signal.side === "BUY" ? "LONG" : "SHORT";
  const factors = (signal.factorScores ?? [])
    .map(
      (f) =>
        `• ${esc(f.name)}: ${f.score}% (w${Math.round(f.weight * 100)}%)${f.aligned ? " ✓" : ""}`
    )
    .join("\n");

  const why = (signal.whyValid ?? signal.technical.reasons)
    .slice(0, 8)
    .map((r) => `• ${esc(r)}`)
    .join("\n");

  const invalid = (signal.invalidation ?? [])
    .map((r) => `• ${esc(r)}`)
    .join("\n");
  const risks = (signal.majorRisks ?? [])
    .slice(0, 5)
    .map((r) => `• ${esc(r)}`)
    .join("\n");

  return [
    `${emoji} <b>${esc(signal.verdict ?? signal.side)}</b> · ${esc(direction)} ${esc(signal.symbol)}`,
    `<b>Confidence:</b> ${signal.confidence}% · ${esc(signal.exchange.toUpperCase())} · ${esc(signal.timeframe)}`,
    `<b>HTF trend:</b> ${esc(signal.htfTrend ?? signal.trendTimeframe)}`,
    "",
    `<b>Why valid</b>`,
    why || "• Multi-factor alignment",
    "",
    `<b>Factor scores</b>`,
    factors || "• n/a",
    "",
    `<b>Entry:</b> <code>${fmtPrice(signal.entry)}</code>`,
    `<b>Stop Loss:</b> <code>${fmtPrice(signal.stopLoss)}</code>`,
    `<b>TP1:</b> <code>${fmtPrice(signal.takeProfit1)}</code> (R:R ${signal.riskReward1.toFixed(2)})`,
    `<b>TP2:</b> <code>${fmtPrice(signal.takeProfit2)}</code> (R:R ${(signal.riskReward2 ?? 0).toFixed(2)})`,
    `<b>TP3:</b> <code>${fmtPrice(signal.takeProfit3 ?? signal.takeProfit2)}</code> (R:R ${(signal.riskReward3 ?? signal.riskReward2).toFixed(2)})`,
    `<b>Position size:</b> <code>${(signal.positionSize ?? 0).toPrecision(4)}</code> (risk ${signal.riskPercent ?? 1}% of $${signal.accountBalance ?? 0})`,
    `<b>Est. hold:</b> ${esc(signal.estimatedHolding ?? "n/a")}`,
    "",
    `<b>Invalidation</b>`,
    invalid || "• Structure SL break",
    "",
    `<b>Major risks</b>`,
    risks || "• Volatility",
    "",
    `<b>Final verdict:</b> ${esc(signal.verdict ?? "NO TRADE")}`,
    `<a href="${chartUrl(signal)}">Open chart</a>`,
    `<i>Alert only — not financial advice.</i>`,
  ].join("\n");
}

export function formatStatus(stats: ScannerStats, paused: boolean): string {
  const last = stats.lastScanAt
    ? new Date(stats.lastScanAt).toISOString()
    : "never";
  return [
    `<b>Institutional Futures Assistant</b>`,
    `Exchange: <b>${esc(config.exchange.toUpperCase())}</b> · TF ${esc(config.timeframe)} + 1H/4H/D`,
    `Gate: confidence ≥ ${config.minConfidence}% · RR ≥ ${config.minRiskReward} · vol ≥ 1.5×`,
    `Status: ${paused ? "⏸ paused" : stats.running ? "🔎 scanning" : "✅ idle"}`,
    `Last scan: <code>${last}</code>`,
    `Duration: ${(stats.lastScanDurationMs / 1000).toFixed(1)}s`,
    `Pairs: ${stats.pairsScanned} · Signals: ${stats.signalsFound} · Alerts: ${stats.alertsSent}`,
    `Errors: ${stats.errors}`,
    stats.lastError
      ? `Last error: <code>${esc(stats.lastError.slice(0, 300))}</code>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function helpText(): string {
  return [
    "<b>Commands</b>",
    "/start — register for alerts",
    "/status — scanner + institutional gates",
    "/pause · /resume · /help",
    "",
    "Only alerts with ≥85% multi-factor confidence (trend, momentum, volume, price action, SMC, futures, fundamentals). Incomplete setups = NO TRADE.",
  ].join("\n");
}
