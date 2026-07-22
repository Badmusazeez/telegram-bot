import type { ScanFunnel } from "../types";

export type FunnelStage =
  | "scanned"
  | "trend"
  | "momentum"
  | "volume"
  | "priceAction"
  | "smc"
  | "conflict"
  | "confidence"
  | "riskReward"
  | "verdict"
  | "passed";

export function emptyFunnel(): ScanFunnel {
  return {
    totalUniverse: 0,
    passedLiquidity: 0,
    scanned: 0,
    passedTrend: 0,
    passedMomentum: 0,
    passedVolume: 0,
    passedPriceAction: 0,
    passedSmc: 0,
    passedConfidence: 0,
    passedRiskReward: 0,
    finalSignals: 0,
    rejectCounts: {},
    topRejectStage: null,
    topRejectCount: 0,
    nearMisses: [],
  };
}

export function bumpReject(funnel: ScanFunnel, stage: FunnelStage): void {
  funnel.rejectCounts[stage] = (funnel.rejectCounts[stage] ?? 0) + 1;
}

export function finalizeFunnel(funnel: ScanFunnel): void {
  let top: string | null = null;
  let topCount = 0;
  for (const [stage, count] of Object.entries(funnel.rejectCounts)) {
    if ((count ?? 0) > topCount) {
      topCount = count ?? 0;
      top = stage;
    }
  }
  funnel.topRejectStage = top;
  funnel.topRejectCount = topCount;
}

export function formatFunnelLog(funnel: ScanFunnel): string {
  const lines = [
    `Total universe: ${funnel.totalUniverse}`,
    `Passed liquidity: ${funnel.passedLiquidity}`,
    `Scanned: ${funnel.scanned}`,
    `Passed trend: ${funnel.passedTrend}`,
    `Passed momentum: ${funnel.passedMomentum}`,
    `Passed volume (≥1.5×): ${funnel.passedVolume}`,
    `Passed price action: ${funnel.passedPriceAction}`,
    `Passed SMC: ${funnel.passedSmc}`,
    `Passed confidence ≥ min: ${funnel.passedConfidence}`,
    `Passed RR / structure stop: ${funnel.passedRiskReward}`,
    `Final signals: ${funnel.finalSignals}`,
  ];
  if (funnel.topRejectStage) {
    lines.push(
      `Top reject: ${funnel.topRejectStage} (${funnel.topRejectCount} pairs)`
    );
  }
  if (funnel.nearMisses.length) {
    lines.push("Closest rejects:");
    for (const m of funnel.nearMisses) lines.push(`  ${m}`);
  }
  return lines.join("\n");
}

export function formatFunnelTelegram(funnel: ScanFunnel): string {
  const lines = [
    `<b>Last scan funnel</b>`,
    `Total universe: ${funnel.totalUniverse}`,
    `Passed liquidity: ${funnel.passedLiquidity}`,
    `Scanned: ${funnel.scanned}`,
    `Passed trend: ${funnel.passedTrend}`,
    `Passed momentum: ${funnel.passedMomentum}`,
    `Passed volume (≥1.5×): ${funnel.passedVolume}`,
    `Passed price action: ${funnel.passedPriceAction}`,
    `Passed SMC: ${funnel.passedSmc}`,
    `Passed confidence ≥ min: ${funnel.passedConfidence}`,
    `Passed RR / structure stop: ${funnel.passedRiskReward}`,
    `Final signals: ${funnel.finalSignals}`,
  ];
  if (funnel.topRejectStage) {
    lines.push(
      `Top reject: <b>${funnel.topRejectStage}</b> (${funnel.topRejectCount})`
    );
  }
  if (funnel.nearMisses.length) {
    lines.push("", `<b>Closest rejects</b>`);
    for (const m of funnel.nearMisses.slice(0, 8)) {
      lines.push(`• ${m.replace(/&/g, "&amp;").replace(/</g, "&lt;")}`);
    }
  }
  return lines.join("\n");
}
