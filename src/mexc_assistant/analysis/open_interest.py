"""Open interest confirmation using MEXC holdVol."""

from __future__ import annotations

from mexc_assistant.core.config import OpenInterestConfig
from mexc_assistant.core.models import OpenInterestState


class OpenInterestTracker:
    def __init__(self) -> None:
        self._prev: dict[str, float] = {}

    def update(self, symbol: str, current: float, price_up: bool, config: OpenInterestConfig) -> OpenInterestState:
        previous = self._prev.get(symbol, current)
        change_pct = (current - previous) / max(previous, 1e-12)
        rising = change_pct >= config.rising_threshold_pct
        sharp_decline = change_pct <= config.sharp_decline_pct
        confirms_long = rising and price_up and not sharp_decline
        confirms_short = rising and (not price_up) and not sharp_decline
        self._prev[symbol] = current
        return OpenInterestState(
            current=current,
            previous=previous,
            change_pct=change_pct,
            rising=rising,
            sharp_decline=sharp_decline,
            confirms_long=confirms_long,
            confirms_short=confirms_short,
        )
