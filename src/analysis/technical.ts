import { config } from "../config";
import type { Candle, Side, TechnicalSnapshot } from "../types";
import {
  atr,
  detectEmaCrossover,
  ema,
  macd,
  rsi,
  sma,
} from "./indicators";

/**
 * Analyze closed candles only (exclude the still-forming last candle).
 */
export function analyzeTechnical(candles: Candle[]): TechnicalSnapshot | null {
  if (candles.length < config.emaSlow + 5) return null;

  // Drop forming candle
  const closed = candles.slice(0, -1);
  const closes = closed.map((c) => c.close);
  const volumes = closed.map((c) => c.volume);

  const fastSeries = ema(closes, config.emaFast);
  const slowSeries = ema(closes, config.emaSlow);
  const closedIndex = closes.length - 1;
  const cross = detectEmaCrossover(fastSeries, slowSeries, closedIndex);
  if (!cross) return null;

  const emaFast = fastSeries[closedIndex];
  const emaSlow = slowSeries[closedIndex];
  if (emaFast === undefined || emaSlow === undefined) return null;

  const rsiSeries = rsi(closes, config.rsiPeriod);
  const rsiValue = rsiSeries[closedIndex];
  if (rsiValue === undefined) return null;

  const { histogram } = macd(closes);
  const histNow = histogram[closedIndex];
  const histPrev = histogram[closedIndex - 1];
  const macdBullish =
    histNow !== undefined &&
    histPrev !== undefined &&
    ((cross === "BUY" && histNow > 0 && histNow >= histPrev) ||
      (cross === "SELL" && histNow < 0 && histNow <= histPrev));

  const volMa = sma(volumes, config.volumeMaPeriod);
  const volAvg = volMa[closedIndex];
  const volumeSpike =
    volAvg !== undefined &&
    volumes[closedIndex] >= volAvg * config.volumeSpikeMult;

  const atrSeries = atr(closed, config.atrPeriod);
  const atrValue = atrSeries[closedIndex];
  if (atrValue === undefined || atrValue <= 0) return null;

  const reasons: string[] = [
    `EMA${config.emaFast}/${config.emaSlow} ${cross === "BUY" ? "bullish" : "bearish"} crossover`,
  ];
  let score = 1; // crossover itself

  if (config.requireRsi) {
    const rsiOk =
      cross === "BUY"
        ? rsiValue >= config.rsiLongMin && rsiValue <= config.rsiLongMax
        : rsiValue >= config.rsiShortMin && rsiValue <= config.rsiShortMax;
    if (rsiOk) {
      score += 1;
      reasons.push(
        `RSI(${config.rsiPeriod})=${rsiValue.toFixed(1)} in ${cross} zone`
      );
    } else {
      reasons.push(
        `RSI(${config.rsiPeriod})=${rsiValue.toFixed(1)} weak for ${cross}`
      );
    }
  }

  if (config.requireMacd) {
    if (macdBullish) {
      score += 1;
      reasons.push("MACD histogram confirms momentum");
    } else {
      reasons.push("MACD histogram does not confirm");
    }
  }

  if (config.requireVolume) {
    if (volumeSpike) {
      score += 1;
      reasons.push(
        `Volume spike ≥ ${config.volumeSpikeMult}× ${config.volumeMaPeriod}-bar avg`
      );
    } else {
      reasons.push("Volume below spike threshold");
    }
  }

  return {
    emaFast,
    emaSlow,
    emaCross: cross as Side,
    rsi: rsiValue,
    macdHistogram: histNow ?? 0,
    macdBullish,
    volumeSpike,
    atr: atrValue,
    score,
    reasons,
  };
}
