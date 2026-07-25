from mexc_assistant.analysis.ema import analyze_ema, ema_series
from mexc_assistant.core.config import EMAConfig
from mexc_assistant.core.models import Candle
import numpy as np


def _candles_trend(n: int = 250, start: float = 100.0, step: float = 0.3) -> list[Candle]:
    out: list[Candle] = []
    price = start
    for i in range(n):
        o = price
        c = price + step
        h = max(o, c) + 0.2
        l = min(o, c) - 0.2
        out.append(Candle(time=i, open=o, high=h, low=l, close=c, volume=1000 + i))
        price = c
    return out


def test_ema_series_increases_on_uptrend():
    values = np.arange(1, 100, dtype=float)
    series = ema_series(values, 20)
    assert series[-1] > series[0]


def test_ema_aligned_long():
    state = analyze_ema(_candles_trend(), EMAConfig())
    assert state.aligned_long
    assert not state.aligned_short
    assert state.price_above_ema20


def test_ema_aligned_short():
    state = analyze_ema(_candles_trend(step=-0.3), EMAConfig())
    assert state.aligned_short
    assert not state.aligned_long
