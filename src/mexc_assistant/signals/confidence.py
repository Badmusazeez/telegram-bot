"""Weighted confluence confidence scoring with factor explanations."""

from __future__ import annotations

from mexc_assistant.core.config import ConfidenceConfig
from mexc_assistant.core.models import (
    AnalysisBundle,
    ConfidenceBreakdown,
    FactorContribution,
    RiskPlan,
    Side,
    Trend,
    confidence_level,
)

FACTOR_LABELS = {
    "ema_alignment": "EMA Alignment",
    "higher_timeframe": "Higher-Timeframe Trend",
    "market_structure": "Market Structure (BOS/CHoCH)",
    "smart_money": "Smart Money Concepts",
    "ict_2022": "ICT 2022 Model",
    "liquidity_sweep": "Liquidity Sweep",
    "order_flow": "Order Flow Confirmation",
    "open_interest": "Open Interest Confirmation",
    "funding_rate": "Funding Rate Analysis",
    "liquidation_heatmap": "Liquidation Heatmap Analysis",
    "volume_confirmation": "Volume Confirmation",
    "volatility_filter": "ATR / Volatility Filter",
    "risk_reward": "Risk-to-Reward",
}


def _polarity(score: float, config: ConfidenceConfig) -> str:
    if score >= config.positive_threshold:
        return "positive"
    if score <= config.negative_threshold:
        return "negative"
    return "neutral"


def score_signal(
    side: Side,
    bundle: AnalysisBundle,
    plan: RiskPlan,
    config: ConfidenceConfig,
) -> ConfidenceBreakdown:
    w = config.weights
    scores: dict[str, float] = {}
    explanations: dict[str, str] = {}

    # EMA
    if side == Side.BUY:
        if bundle.ema.aligned_long:
            scores["ema_alignment"] = 100.0
            explanations["ema_alignment"] = "EMA20>50>100>200 with price above EMA20"
        elif bundle.ema.price_above_ema20 and not bundle.ema.flat_or_intertwined:
            scores["ema_alignment"] = 45.0
            explanations["ema_alignment"] = "Price above EMA20 but stack not fully aligned"
        else:
            scores["ema_alignment"] = 0.0
            explanations["ema_alignment"] = "EMA stack flat, intertwined, or bearish"
    else:
        if bundle.ema.aligned_short:
            scores["ema_alignment"] = 100.0
            explanations["ema_alignment"] = "EMA20<50<100<200 with price below EMA20"
        elif bundle.ema.price_below_ema20 and not bundle.ema.flat_or_intertwined:
            scores["ema_alignment"] = 45.0
            explanations["ema_alignment"] = "Price below EMA20 but stack not fully aligned"
        else:
            scores["ema_alignment"] = 0.0
            explanations["ema_alignment"] = "EMA stack flat, intertwined, or bullish"

    # Higher timeframe
    if (side == Side.BUY and bundle.higher_tf_trend == Trend.BULLISH) or (
        side == Side.SELL and bundle.higher_tf_trend == Trend.BEARISH
    ):
        scores["higher_timeframe"] = 100.0
        explanations["higher_timeframe"] = f"HTF bias confirms {bundle.higher_tf_trend.value.lower()} direction"
    elif bundle.higher_tf_trend == Trend.NEUTRAL:
        scores["higher_timeframe"] = 30.0
        explanations["higher_timeframe"] = "HTF bias mixed/neutral"
    else:
        scores["higher_timeframe"] = 0.0
        explanations["higher_timeframe"] = "HTF bias opposes trade direction"

    # Market structure
    aligned_structure = (
        (side == Side.BUY and bundle.structure.trend == Trend.BULLISH)
        or (side == Side.SELL and bundle.structure.trend == Trend.BEARISH)
    )
    if aligned_structure and bundle.structure.bos:
        scores["market_structure"] = 100.0
        explanations["market_structure"] = "Structure aligned with BOS confirmation"
    elif aligned_structure:
        scores["market_structure"] = 75.0
        explanations["market_structure"] = "Structure aligned (awaiting fresh BOS)"
    elif bundle.structure.choch:
        scores["market_structure"] = 15.0
        explanations["market_structure"] = "CHoCH against intended direction"
    else:
        scores["market_structure"] = 25.0
        explanations["market_structure"] = "Structure not confirming direction"

    # Smart money
    zone_hit = any(
        z.side == side and z.kind in {"order_block", "fvg", "mitigation_block", "breaker"}
        for z in bundle.smc_zones
        if abs(((z.top + z.bottom) / 2) - bundle.price) / max(bundle.price, 1e-12) <= 0.01
    )
    if zone_hit:
        scores["smart_money"] = 100.0
        explanations["smart_money"] = "Price revisiting valid OB/FVG/breaker zone"
    elif any(z.side == side for z in bundle.smc_zones):
        scores["smart_money"] = 55.0
        explanations["smart_money"] = "Directional SMC zones exist but not actively tested"
    else:
        scores["smart_money"] = 20.0
        explanations["smart_money"] = "No supportive SMC zone nearby"

    # ICT 2022 Model (HTF sweep → LTF MSS → FVG)
    ict = bundle.ict_2022
    if ict.valid and ict.side == side:
        scores["ict_2022"] = max(70.0, float(ict.quality))
        zone_tag = (
            "discount FVG"
            if side == Side.BUY and ict.in_discount
            else (
                "premium FVG"
                if side == Side.SELL and ict.in_premium
                else "displacement FVG"
            )
        )
        explanations["ict_2022"] = (
            f"Complete ICT 2022: HTF {'SSL' if side == Side.BUY else 'BSL'} sweep + "
            f"LTF MSS + {zone_tag} (q={ict.quality:.0f})"
        )
    elif ict.htf_sweep and ict.side == side:
        scores["ict_2022"] = 35.0
        explanations["ict_2022"] = "HTF liquidity swept but LTF MSS/FVG incomplete"
    else:
        scores["ict_2022"] = 15.0
        explanations["ict_2022"] = "ICT 2022 sequence not present for this side"

    # Liquidity sweep
    if side == Side.BUY:
        scores["liquidity_sweep"] = 100.0 if bundle.liquidity.swept_low else 30.0
        explanations["liquidity_sweep"] = (
            "Sell-side liquidity swept with rejection"
            if bundle.liquidity.swept_low
            else "No confirmed bullish liquidity sweep"
        )
    else:
        scores["liquidity_sweep"] = 100.0 if bundle.liquidity.swept_high else 30.0
        explanations["liquidity_sweep"] = (
            "Buy-side liquidity swept with rejection"
            if bundle.liquidity.swept_high
            else "No confirmed bearish liquidity sweep"
        )

    # Order flow
    if side == Side.BUY:
        if bundle.order_flow.supports_long:
            scores["order_flow"] = 100.0
            explanations["order_flow"] = "Aggressive buyers / positive delta support long"
        elif bundle.order_flow.supports_short:
            scores["order_flow"] = 0.0
            explanations["order_flow"] = "Order flow contradicts long (sellers dominate)"
        else:
            scores["order_flow"] = 40.0
            explanations["order_flow"] = "Order flow balanced / inconclusive"
    else:
        if bundle.order_flow.supports_short:
            scores["order_flow"] = 100.0
            explanations["order_flow"] = "Aggressive sellers / negative delta support short"
        elif bundle.order_flow.supports_long:
            scores["order_flow"] = 0.0
            explanations["order_flow"] = "Order flow contradicts short (buyers dominate)"
        else:
            scores["order_flow"] = 40.0
            explanations["order_flow"] = "Order flow balanced / inconclusive"

    # Open interest
    if side == Side.BUY:
        if bundle.open_interest.confirms_long:
            scores["open_interest"] = 100.0
            explanations["open_interest"] = "OI rising with price (fresh long positioning)"
        elif bundle.open_interest.sharp_decline:
            scores["open_interest"] = 15.0
            explanations["open_interest"] = "OI declining sharply into breakout"
        else:
            scores["open_interest"] = 50.0
            explanations["open_interest"] = "OI mixed versus price"
    else:
        if bundle.open_interest.confirms_short:
            scores["open_interest"] = 100.0
            explanations["open_interest"] = "OI rising with falling price (short conviction)"
        elif bundle.open_interest.sharp_decline:
            scores["open_interest"] = 15.0
            explanations["open_interest"] = "OI declining sharply into breakdown"
        else:
            scores["open_interest"] = 50.0
            explanations["open_interest"] = "OI mixed versus price"

    # Funding
    if side == Side.BUY:
        if bundle.funding.crowded_longs:
            scores["funding_rate"] = 15.0
            explanations["funding_rate"] = "Extreme positive funding — crowded longs"
        elif bundle.funding.crowded_shorts:
            scores["funding_rate"] = 90.0
            explanations["funding_rate"] = "Negative funding — shorts crowded, squeeze risk helps longs"
        else:
            scores["funding_rate"] = 70.0
            explanations["funding_rate"] = "Funding neutral"
    else:
        if bundle.funding.crowded_shorts:
            scores["funding_rate"] = 15.0
            explanations["funding_rate"] = "Extreme negative funding — crowded shorts"
        elif bundle.funding.crowded_longs:
            scores["funding_rate"] = 90.0
            explanations["funding_rate"] = "Positive funding — longs crowded, supports shorts"
        else:
            scores["funding_rate"] = 70.0
            explanations["funding_rate"] = "Funding neutral"

    # Liquidation heatmap
    liq_score = bundle.liquidation.score_hint
    if side == Side.BUY:
        if bundle.liquidation.sweep_aligned and bundle.liquidity.swept_low:
            liq_score = max(liq_score, 90.0)
            explanations["liquidation_heatmap"] = "Long liquidation sweep absorbed; magnets below cleared"
        elif bundle.liquidation.recent_long_liqs > bundle.liquidation.recent_short_liqs:
            explanations["liquidation_heatmap"] = "Recent long liquidations flushed; stabilization preferred"
        else:
            explanations["liquidation_heatmap"] = "Liquidation magnets not clearly supportive yet"
    else:
        if bundle.liquidation.sweep_aligned and bundle.liquidity.swept_high:
            liq_score = max(liq_score, 90.0)
            explanations["liquidation_heatmap"] = "Short liquidation sweep absorbed; magnets above cleared"
        elif bundle.liquidation.recent_short_liqs > bundle.liquidation.recent_long_liqs:
            explanations["liquidation_heatmap"] = "Recent short liquidations flushed; stabilization preferred"
        else:
            explanations["liquidation_heatmap"] = "Liquidation magnets not clearly supportive yet"
    scores["liquidation_heatmap"] = float(liq_score)

    # Volume
    if bundle.volume.spike:
        scores["volume_confirmation"] = 100.0
        explanations["volume_confirmation"] = "Volume spike confirms participation"
    elif bundle.volume.breakout:
        scores["volume_confirmation"] = 85.0
        explanations["volume_confirmation"] = "Breakout volume above average"
    elif bundle.volume.above_average:
        scores["volume_confirmation"] = 65.0
        explanations["volume_confirmation"] = "Volume above average"
    else:
        scores["volume_confirmation"] = 10.0
        explanations["volume_confirmation"] = "Low-volume move rejected by filter"

    # Volatility
    if bundle.volatility.sufficient:
        scores["volatility_filter"] = 100.0
        explanations["volatility_filter"] = f"ATR sufficient ({bundle.volatility.atr_pct:.3%})"
    else:
        scores["volatility_filter"] = 0.0
        explanations["volatility_filter"] = "ATR too low — conditions not tradeable"

    # Risk reward
    if plan.risk_reward >= 3.0:
        scores["risk_reward"] = 100.0
        explanations["risk_reward"] = f"RR {plan.risk_reward:.1f}:1 meets preferred 3:1"
    elif plan.risk_reward >= 2.5:
        scores["risk_reward"] = 80.0
        explanations["risk_reward"] = f"RR {plan.risk_reward:.1f}:1 meets minimum 2.5:1"
    else:
        scores["risk_reward"] = 0.0
        explanations["risk_reward"] = f"RR {plan.risk_reward:.1f}:1 below minimum"

    total_weight = sum(w.values()) or 1.0
    factors: list[FactorContribution] = []
    weighted_total = 0.0
    for key, weight in w.items():
        score = scores.get(key, 0.0)
        # Support legacy key rename
        if key == "smart_money" and key not in scores and "order_block_fvg" in scores:
            score = scores["order_block_fvg"]
        weighted = score * (weight / total_weight)
        weighted_total += weighted
        pol = _polarity(score, config)
        factors.append(
            FactorContribution(
                key=key,
                label=FACTOR_LABELS.get(key, key),
                score=score,
                weight=weight,
                weighted=round(weighted, 2),
                polarity=pol,
                explanation=explanations.get(key, ""),
            )
        )

    # External modifiers: cross-exchange + news (not in base weights; applied after)
    modifier = 0.0
    modifier_notes: list[str] = []
    if bundle.cross_exchange.penalty:
        modifier -= bundle.cross_exchange.penalty
        modifier_notes.append(
            f"Cross-exchange penalty -{bundle.cross_exchange.penalty:.1f}: "
            + "; ".join(bundle.cross_exchange.notes[:2])
        )
    if bundle.news.confidence_penalty:
        modifier -= bundle.news.confidence_penalty
        modifier_notes.append(
            f"News penalty -{bundle.news.confidence_penalty:.1f}: "
            + "; ".join(bundle.news.notes[:2])
        )

    total = max(0.0, min(100.0, round(weighted_total + modifier, 2)))
    level = confidence_level(total)

    positive = [
        f"{f.label}: {f.explanation} ({f.score:.0f}/100, weight {f.weight:.0f}%)"
        for f in factors
        if f.polarity == "positive"
    ]
    negative = [
        f"{f.label}: {f.explanation} ({f.score:.0f}/100, weight {f.weight:.0f}%)"
        for f in factors
        if f.polarity == "negative"
    ]
    negative.extend(modifier_notes)

    summary_parts = [
        f"Confidence {total:.0f}% — {level.value}.",
        f"{len(positive)} positive / {len(negative)} negative factors.",
    ]
    if positive:
        summary_parts.append("Supported by: " + "; ".join(p.split(":")[0] for p in positive[:5]) + ".")
    if negative:
        summary_parts.append("Dragged by: " + "; ".join(n.split(":")[0] for n in negative[:5]) + ".")

    return ConfidenceBreakdown(
        scores=scores,
        total=total,
        weights=dict(w),
        level=level,
        factors=factors,
        positive=positive,
        negative=negative,
        summary=" ".join(summary_parts),
    )


def count_positive_categories(breakdown: ConfidenceBreakdown, config: ConfidenceConfig) -> int:
    return sum(1 for f in breakdown.factors if f.score >= config.positive_threshold)
