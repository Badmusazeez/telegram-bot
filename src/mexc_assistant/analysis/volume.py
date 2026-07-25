"""Volume confirmation filters."""

from __future__ import annotations

from mexc_assistant.core.config import VolumeConfig
from mexc_assistant.core.models import Candle, VolumeState


def analyze_volume(candles: list[Candle], config: VolumeConfig) -> VolumeState:
    if not candles:
        return VolumeState(0.0, 0.0, False, False, False)
    lookback = candles[-(config.avg_lookback + 1) : -1] or candles[:-1] or candles
    average = sum(c.volume for c in lookback) / max(len(lookback), 1)
    current = candles[-1].volume
    above = current >= average
    breakout = current >= average * config.breakout_multiplier
    spike = current >= average * config.spike_multiplier
    return VolumeState(
        current=current,
        average=average,
        above_average=above,
        breakout=breakout,
        spike=spike,
    )
