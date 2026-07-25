"""Confidence scoring (0–100) with configurable weights."""

from __future__ import annotations

from mexc_assistant.core.config import ConfidenceConfig
from mexc_assistant.core.models import AnalysisBundle, ConfidenceBreakdown, RiskPlan, Side, Trend


def score_signal(
    side: Side,
    bundle: AnalysisBundle,
    plan: RiskPlan,
    config: ConfidenceConfig,
) -> ConfidenceBreakdown:
    w = config.weights
    scores: dict[str, float] = {}

    # EMA alignment (0-100 component before weight)
    if side == Side.BUY:
        scores["ema_alignment"] = 100.0 if bundle.ema.aligned_long else (
            40.0 if bundle.ema.price_above_ema20 and not bundle.ema.flat_or_intertwined else 0.0
        )
    else:
        scores["ema_alignment"] = 100.0 if bundle.ema.aligned_short else (
            40.0 if bundle.ema.price_below_ema20 and not bundle.ema.flat_or_intertwined else 0.0
        )

    # Market structure
    aligned_structure = (
        (side == Side.BUY and bundle.structure.trend == Trend.BULLISH)
        or (side == Side.SELL and bundle.structure.trend == Trend.BEARISH)
    )
    structure_score = 70.0 if aligned_structure else 20.0
    if bundle.structure.bos and aligned_structure:
        structure_score = 100.0
    if bundle.structure.choch and not aligned_structure:
        structure_score = 10.0
    scores["market_structure"] = structure_score

    # Order block / FVG revisit
    zone_hit = any(
        z.side == side and z.kind in {"order_block", "fvg", "mitigation_block", "breaker"}
        for z in bundle.smc_zones
        if abs(((z.top + z.bottom) / 2) - bundle.price) / max(bundle.price, 1e-12) <= 0.01
    )
    scores["order_block_fvg"] = 100.0 if zone_hit else 25.0

    # Liquidity sweep
    if side == Side.BUY:
        scores["liquidity_sweep"] = 100.0 if bundle.liquidity.swept_low else 30.0
    else:
        scores["liquidity_sweep"] = 100.0 if bundle.liquidity.swept_high else 30.0

    # Order flow
    if side == Side.BUY:
        scores["order_flow"] = 100.0 if bundle.order_flow.supports_long else (
            0.0 if bundle.order_flow.supports_short else 40.0
        )
    else:
        scores["order_flow"] = 100.0 if bundle.order_flow.supports_short else (
            0.0 if bundle.order_flow.supports_long else 40.0
        )

    # Open interest
    if side == Side.BUY:
        scores["open_interest"] = 100.0 if bundle.open_interest.confirms_long else (
            20.0 if bundle.open_interest.sharp_decline else 50.0
        )
    else:
        scores["open_interest"] = 100.0 if bundle.open_interest.confirms_short else (
            20.0 if bundle.open_interest.sharp_decline else 50.0
        )

    # Funding modifier
    if side == Side.BUY:
        if bundle.funding.crowded_longs:
            scores["funding_rate"] = 15.0
        elif bundle.funding.crowded_shorts:
            scores["funding_rate"] = 90.0
        else:
            scores["funding_rate"] = 70.0
    else:
        if bundle.funding.crowded_shorts:
            scores["funding_rate"] = 15.0
        elif bundle.funding.crowded_longs:
            scores["funding_rate"] = 90.0
        else:
            scores["funding_rate"] = 70.0

    # Volume
    if bundle.volume.spike:
        scores["volume_confirmation"] = 100.0
    elif bundle.volume.breakout:
        scores["volume_confirmation"] = 85.0
    elif bundle.volume.above_average:
        scores["volume_confirmation"] = 65.0
    else:
        scores["volume_confirmation"] = 10.0

    # Volatility
    scores["volatility_filter"] = 100.0 if bundle.volatility.sufficient else 0.0

    # Risk reward
    if plan.risk_reward >= 3.0:
        scores["risk_reward"] = 100.0
    elif plan.risk_reward >= 2.5:
        scores["risk_reward"] = 75.0
    else:
        scores["risk_reward"] = 0.0

    # Higher timeframe
    if (side == Side.BUY and bundle.higher_tf_trend == Trend.BULLISH) or (
        side == Side.SELL and bundle.higher_tf_trend == Trend.BEARISH
    ):
        scores["higher_timeframe"] = 100.0
    elif bundle.higher_tf_trend == Trend.NEUTRAL:
        scores["higher_timeframe"] = 35.0
    else:
        scores["higher_timeframe"] = 0.0

    total_weight = sum(w.values()) or 1.0
    total = sum(scores.get(k, 0.0) * (w.get(k, 0.0) / total_weight) for k in w)
    # Note: weights already sum conceptually to ~110 in YAML; normalize by total_weight
    return ConfidenceBreakdown(scores=scores, total=round(total, 2), weights=dict(w))
