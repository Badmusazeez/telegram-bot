"""EMA stack analysis (20/50/100/200)."""

from __future__ import annotations

import numpy as np

from mexc_assistant.core.config import EMAConfig
from mexc_assistant.core.models import Candle, EMAState


def ema_series(values: np.ndarray, period: int) -> np.ndarray:
    if len(values) == 0:
        return np.array([])
    alpha = 2.0 / (period + 1.0)
    out = np.empty_like(values, dtype=float)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1.0 - alpha) * out[i - 1]
    return out


def analyze_ema(candles: list[Candle], config: EMAConfig) -> EMAState:
    closes = np.array([c.close for c in candles], dtype=float)
    if len(closes) < max(config.periods) + 5:
        price = float(closes[-1]) if len(closes) else 0.0
        return EMAState(
            ema20=price,
            ema50=price,
            ema100=price,
            ema200=price,
            aligned_long=False,
            aligned_short=False,
            flat_or_intertwined=True,
            price_above_ema20=False,
            price_below_ema20=False,
        )

    e20 = ema_series(closes, 20)
    e50 = ema_series(closes, 50)
    e100 = ema_series(closes, 100)
    e200 = ema_series(closes, 200)

    ema20, ema50, ema100, ema200 = float(e20[-1]), float(e50[-1]), float(e100[-1]), float(e200[-1])
    price = float(closes[-1])

    aligned_long = ema20 > ema50 > ema100 > ema200 and price > ema20
    aligned_short = ema20 < ema50 < ema100 < ema200 and price < ema20

    # Slope of EMA20 over last 5 bars
    slope = (e20[-1] - e20[-6]) / max(abs(e20[-6]), 1e-12)
    flat = abs(slope) < config.min_slope_pct

    # Intertwined when EMAs are clustered relative to price
    stack = np.array([ema20, ema50, ema100, ema200])
    spread = (stack.max() - stack.min()) / max(price, 1e-12)
    intertwined = spread < config.max_intertwine_pct

    return EMAState(
        ema20=ema20,
        ema50=ema50,
        ema100=ema100,
        ema200=ema200,
        aligned_long=aligned_long and not flat and not intertwined,
        aligned_short=aligned_short and not flat and not intertwined,
        flat_or_intertwined=flat or intertwined,
        price_above_ema20=price > ema20,
        price_below_ema20=price < ema20,
    )
