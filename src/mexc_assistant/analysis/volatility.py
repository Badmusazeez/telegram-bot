"""ATR-based volatility filter and stop sizing helper."""

from __future__ import annotations

import numpy as np

from mexc_assistant.core.config import VolatilityConfig
from mexc_assistant.core.models import Candle, VolatilityState


def atr(candles: list[Candle], period: int = 14) -> float:
    if len(candles) < period + 1:
        if not candles:
            return 0.0
        return float(np.mean([c.high - c.low for c in candles]))

    trs: list[float] = []
    for i in range(1, len(candles)):
        c, p = candles[i], candles[i - 1]
        tr = max(c.high - c.low, abs(c.high - p.close), abs(c.low - p.close))
        trs.append(tr)
    return float(np.mean(trs[-period:]))


def analyze_volatility(candles: list[Candle], config: VolatilityConfig) -> VolatilityState:
    value = atr(candles, config.atr_period)
    price = candles[-1].close if candles else 0.0
    atr_pct = value / max(price, 1e-12)
    return VolatilityState(atr=value, atr_pct=atr_pct, sufficient=atr_pct >= config.min_atr_pct)
