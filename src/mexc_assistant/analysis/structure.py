"""Market structure: HH/HL/LH/LL, BOS, CHoCH."""

from __future__ import annotations

from mexc_assistant.core.config import StructureConfig
from mexc_assistant.core.models import Candle, StructureEvent, StructureState, Trend


def _swing_points(
    candles: list[Candle], lookback: int
) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    highs: list[tuple[int, float]] = []
    lows: list[tuple[int, float]] = []
    for i in range(lookback, len(candles) - lookback):
        window = candles[i - lookback : i + lookback + 1]
        mid = candles[i]
        if mid.high >= max(c.high for c in window):
            highs.append((i, mid.high))
        if mid.low <= min(c.low for c in window):
            lows.append((i, mid.low))
    return highs, lows


def analyze_structure(candles: list[Candle], config: StructureConfig) -> StructureState:
    if len(candles) < config.swing_lookback * 4:
        price = candles[-1].close if candles else 0.0
        return StructureState(
            trend=Trend.NEUTRAL,
            last_event=None,
            swing_high=price,
            swing_low=price,
            bos=False,
            choch=False,
        )

    highs, lows = _swing_points(candles, config.swing_lookback)
    events: list[StructureEvent] = []
    trend = Trend.NEUTRAL
    bos = False
    choch = False

    for i in range(1, len(highs)):
        if highs[i][1] > highs[i - 1][1]:
            events.append(StructureEvent.HH)
        else:
            events.append(StructureEvent.LH)

    for i in range(1, len(lows)):
        if lows[i][1] > lows[i - 1][1]:
            events.append(StructureEvent.HL)
        else:
            events.append(StructureEvent.LL)

    # Bias from recent swing sequence
    recent_highs = highs[-3:]
    recent_lows = lows[-3:]
    bullish_seq = (
        len(recent_highs) >= 2
        and len(recent_lows) >= 2
        and recent_highs[-1][1] > recent_highs[-2][1]
        and recent_lows[-1][1] > recent_lows[-2][1]
    )
    bearish_seq = (
        len(recent_highs) >= 2
        and len(recent_lows) >= 2
        and recent_highs[-1][1] < recent_highs[-2][1]
        and recent_lows[-1][1] < recent_lows[-2][1]
    )
    if bullish_seq:
        trend = Trend.BULLISH
    elif bearish_seq:
        trend = Trend.BEARISH

    last_swing_high = highs[-1][1] if highs else candles[-1].high
    last_swing_low = lows[-1][1] if lows else candles[-1].low
    close = candles[-1].close
    prev_close = candles[-2].close

    # BOS / CHoCH using last confirmed swings
    if trend == Trend.BULLISH and close > last_swing_high >= prev_close:
        bos = True
        events.append(StructureEvent.BOS)
    elif trend == Trend.BEARISH and close < last_swing_low <= prev_close:
        bos = True
        events.append(StructureEvent.BOS)

    if trend == Trend.BULLISH and close < last_swing_low:
        choch = True
        trend = Trend.BEARISH
        events.append(StructureEvent.CHOCH)
    elif trend == Trend.BEARISH and close > last_swing_high:
        choch = True
        trend = Trend.BULLISH
        events.append(StructureEvent.CHOCH)

    return StructureState(
        trend=trend,
        last_event=events[-1] if events else None,
        swing_high=last_swing_high,
        swing_low=last_swing_low,
        bos=bos,
        choch=choch,
        events=events[-12:],
    )
