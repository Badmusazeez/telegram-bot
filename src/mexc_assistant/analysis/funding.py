"""Funding-rate crowding modifier."""

from __future__ import annotations

from mexc_assistant.core.config import FundingConfig
from mexc_assistant.core.models import FundingState


def analyze_funding(rate: float, config: FundingConfig) -> FundingState:
    extreme_positive = rate >= config.extreme_positive
    extreme_negative = rate <= config.extreme_negative
    return FundingState(
        rate=rate,
        extreme_positive=extreme_positive,
        extreme_negative=extreme_negative,
        crowded_longs=extreme_positive,
        crowded_shorts=extreme_negative,
    )
