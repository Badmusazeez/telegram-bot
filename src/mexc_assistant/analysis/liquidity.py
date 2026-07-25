"""Liquidity pools, equal highs/lows, session levels, sweep detection."""

from __future__ import annotations

from mexc_assistant.core.config import StructureConfig
from mexc_assistant.core.models import Candle, LiquidityState


def _cluster_levels(levels: list[float], tol_pct: float) -> list[float]:
    if not levels:
        return []
    levels = sorted(levels)
    clusters: list[list[float]] = [[levels[0]]]
    for lvl in levels[1:]:
        if abs(lvl - clusters[-1][-1]) / max(lvl, 1e-12) <= tol_pct:
            clusters[-1].append(lvl)
        else:
            clusters.append([lvl])
    return [sum(c) / len(c) for c in clusters if len(c) >= 2]


def analyze_liquidity(
    exec_candles: list[Candle],
    daily_candles: list[Candle],
    config: StructureConfig,
) -> LiquidityState:
    if not exec_candles:
        return LiquidityState()

    highs = [c.high for c in exec_candles[-80:]]
    lows = [c.low for c in exec_candles[-80:]]
    equal_highs = _cluster_levels(highs, config.equal_level_tolerance_pct)
    equal_lows = _cluster_levels(lows, config.equal_level_tolerance_pct)

    if len(daily_candles) >= 2:
        prev = daily_candles[-2]
        pdh, pdl = prev.high, prev.low
    else:
        pdh = max(highs)
        pdl = min(lows)

    # Approximate "session" as last 96 x 15m (~1 day) or available window
    session = exec_candles[-96:] if len(exec_candles) >= 96 else exec_candles
    session_high = max(c.high for c in session)
    session_low = min(c.low for c in session)

    last = exec_candles[-1]
    prior = exec_candles[-2] if len(exec_candles) > 1 else last

    # Sweep: wick takes liquidity then closes back inside
    swept_high = last.high > max(equal_highs[-1:] + [session_high, pdh]) * (
        1 - 1e-12
    ) and last.close < prior.high
    # More robust sweep checks
    liq_high = max([session_high, pdh] + equal_highs[-2:])
    liq_low = min([session_low, pdl] + equal_lows[-2:])
    swept_high = last.high > liq_high and last.close < liq_high
    swept_low = last.low < liq_low and last.close > liq_low

    magnets = sorted(set(equal_highs[-3:] + equal_lows[-3:] + [pdh, pdl, session_high, session_low]))

    return LiquidityState(
        equal_highs=equal_highs[-5:],
        equal_lows=equal_lows[-5:],
        previous_day_high=pdh,
        previous_day_low=pdl,
        session_high=session_high,
        session_low=session_low,
        swept_high=swept_high,
        swept_low=swept_low,
        magnets=magnets,
    )
