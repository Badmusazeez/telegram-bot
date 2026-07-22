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

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(4)}%`;
}

export function formatSignalAlert(signal: TradeSignal): string {
  const emoji = signal.side === "BUY" ? "🟢" : "🔴";
  const tech = signal.technical.reasons.map((r) => `• ${esc(r)}`).join("\n");
  const fund = signal.fundamental.reasons.map((r) => `• ${esc(r)}`).join("\n");

  return [
    `${emoji} <b>${signal.side} ${esc(signal.symbol)}</b> · ${esc(signal.timeframe)}`,
    `<b>Confidence:</b> ${signal.confidence}%`,
    "",
    `<b>Entry:</b> <code>${fmtPrice(signal.entry)}</code>`,
    `<b>Stop Loss:</b> <code>${fmtPrice(signal.stopLoss)}</code>`,
    `<b>Take Profit 1:</b> <code>${fmtPrice(signal.takeProfit1)}</code> (R:R ${signal.riskReward1.toFixed(2)})`,
    `<b>Take Profit 2:</b> <code>${fmtPrice(signal.takeProfit2)}</code> (R:R ${signal.riskReward2.toFixed(2)})`,
    "",
    `<b>Technical</b> (score ${signal.technical.score})`,
    `EMA ${fmtPrice(signal.technical.emaFast)} / ${fmtPrice(signal.technical.emaSlow)} · RSI ${signal.technical.rsi.toFixed(1)} · ATR ${fmtPrice(signal.technical.atr)}`,
    tech,
    "",
    `<b>Fundamental</b> (score ${signal.fundamental.score})`,
    `Funding ${fmtPct(signal.fundamental.fundingRate)}` +
      (signal.fundamental.openInterestChangePct !== null
        ? ` · OI Δ ${signal.fundamental.openInterestChangePct.toFixed(2)}%`
        : "") +
      (signal.fundamental.longShortRatio !== null
        ? ` · L/S ${signal.fundamental.longShortRatio.toFixed(2)}`
        : ""),
    fund,
    "",
    `<i>Alert only — not financial advice. Manage your own risk.</i>`,
  ].join("\n");
}

export function formatStatus(stats: ScannerStats, paused: boolean): string {
  const last = stats.lastScanAt
    ? new Date(stats.lastScanAt).toISOString()
    : "never";
  const lines = [
    `<b>AI Futures Assistant</b>`,
    `Status: ${paused ? "⏸ paused" : stats.running ? "🔎 scanning" : "✅ idle"}`,
    `Last scan: <code>${last}</code>`,
    `Duration: ${(stats.lastScanDurationMs / 1000).toFixed(1)}s`,
    `Pairs last pass: ${stats.pairsScanned}`,
    `Signals found: ${stats.signalsFound}`,
    `Alerts sent: ${stats.alertsSent}`,
    `Errors: ${stats.errors}`,
  ];
  if (stats.lastError) {
    lines.push(`Last error: <code>${esc(stats.lastError.slice(0, 350))}</code>`);
  }
  if (stats.pairsScanned === 0) {
    lines.push(
      "",
      "<i>0 pairs usually means the exchange is blocked from this network, or MIN_QUOTE_VOLUME_USDT is too high. Try EXCHANGE=mexc in .env if using Binance.</i>"
    );
  }
  return lines.join("\n");
}

export function helpText(): string {
  return [
    "<b>Commands</b>",
    "/start — register this chat for alerts",
    "/status — scanner stats",
    "/pause — pause scanning",
    "/resume — resume scanning",
    "/help — this message",
    "",
    "The bot scans MEXC or Binance USDT-M Futures for EMA crossovers, then requires technical + fundamental confirmations before sending BUY/SELL with TP & SL.",
  ].join("\n");
}
