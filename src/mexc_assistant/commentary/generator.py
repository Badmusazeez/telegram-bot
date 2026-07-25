"""Concise institutional market commentary for Telegram alerts."""

from __future__ import annotations

from mexc_assistant.core.models import AnalysisBundle, ConfidenceBreakdown, RiskPlan, Side, Trend


def _funding_text(bundle: AnalysisBundle, side: Side) -> str:
    rate = bundle.funding.rate
    if bundle.funding.crowded_longs:
        base = f"Funding is elevated (+{rate:.4%}), indicating crowded longs"
        return base + (
            "; avoid chasing longs" if side == Side.BUY else "; supports fade of crowded longs"
        )
    if bundle.funding.crowded_shorts:
        base = f"Funding is deeply negative ({rate:.4%}), indicating crowded shorts"
        return base + (
            "; supports long mean-reversion risk" if side == Side.SELL else "; squeeze risk favors longs"
        )
    return f"Funding remains neutral ({rate:.4%})"


def _oi_text(bundle: AnalysisBundle, side: Side) -> str:
    chg = bundle.open_interest.change_pct
    if side == Side.BUY and bundle.open_interest.confirms_long:
        return f"Open interest rising ({chg:+.2%}) with price — fresh long positioning"
    if side == Side.SELL and bundle.open_interest.confirms_short:
        return f"Open interest rising ({chg:+.2%}) with declining price — short conviction building"
    if bundle.open_interest.sharp_decline:
        return f"Open interest falling sharply ({chg:+.2%}) — breakout lacks conviction"
    return f"Open interest change {chg:+.2%} is mixed"


def _flow_text(bundle: AnalysisBundle) -> str:
    if bundle.order_flow.aggressive_buyers:
        return "Order flow shows aggressive buyers dominating delta"
    if bundle.order_flow.aggressive_sellers:
        return "Order flow shows aggressive sellers dominating delta"
    if bundle.order_flow.absorption:
        return "Order flow shows absorption near the level"
    return "Order flow is balanced"


def generate_reason(side: Side, bundle: AnalysisBundle) -> str:
    trend = (
        "uptrend"
        if bundle.higher_tf_trend == Trend.BULLISH
        else ("downtrend" if bundle.higher_tf_trend == Trend.BEARISH else "range")
    )
    sweep = (
        "Liquidity below recent lows has been swept"
        if side == Side.BUY and bundle.liquidity.swept_low
        else (
            "Liquidity above recent highs has been swept"
            if side == Side.SELL and bundle.liquidity.swept_high
            else "Price is interacting with key liquidity"
        )
    )
    zone = "bullish Order Block / FVG" if side == Side.BUY else "bearish Order Block / FVG"
    xex = (
        " MEXC/OKX validation aligned."
        if not bundle.cross_exchange.conflicting
        else " Cross-exchange caution noted."
    )
    parts = [
        f"Higher-timeframe {trend} with {'bullish' if side == Side.BUY else 'bearish'} EMA alignment.",
        f"{sweep}.",
        f"Price returned to a {zone} with {_flow_text(bundle).lower()}.",
        f"{_oi_text(bundle, side)}, {_funding_text(bundle, side).lower()}, and volume "
        f"{'confirms' if bundle.volume.breakout or bundle.volume.spike else 'is only moderately supportive of'} "
        f"institutional participation.{xex}",
    ]
    return " ".join(parts)


def generate_commentary(
    side: Side,
    bundle: AnalysisBundle,
    plan: RiskPlan,
    breakdown: ConfidenceBreakdown | None = None,
) -> str:
    inst = (
        "Institutions appear to be accumulating into discount liquidity after the sweep."
        if side == Side.BUY
        else "Institutions appear to be distributing into premium liquidity after the sweep."
    )
    risks = []
    if bundle.funding.crowded_longs and side == Side.BUY:
        risks.append("crowded longs via funding")
    if bundle.funding.crowded_shorts and side == Side.SELL:
        risks.append("crowded shorts via funding")
    if not bundle.volume.spike:
        risks.append("volume not yet climactic")
    if bundle.open_interest.sharp_decline:
        risks.append("OI contraction")
    if bundle.cross_exchange.conflicting:
        risks.append("cross-exchange divergence")
    if bundle.news.volatility_risk:
        risks.append("news-driven volatility")
    risk_txt = ", ".join(risks) if risks else "mainly failed continuation / level invalidation"

    invalidation = (
        f"Close below {plan.stop_loss:,.4g} invalidates the bullish OB/structure thesis."
        if side == Side.BUY
        else f"Close above {plan.stop_loss:,.4g} invalidates the bearish OB/structure thesis."
    )

    conf_txt = ""
    if breakdown is not None:
        conf_txt = f" {breakdown.summary}"
        if breakdown.positive:
            conf_txt += " Positive: " + " | ".join(breakdown.positive[:3]) + "."
        if breakdown.negative:
            conf_txt += " Negative: " + " | ".join(breakdown.negative[:3]) + "."

    xex = "; ".join(bundle.cross_exchange.notes[:2])
    news = "; ".join(bundle.news.notes[:2]) if bundle.news.notes else "No material news impact"

    return (
        f"{inst} Trend: {bundle.higher_tf_trend.value}. "
        f"Structure: {bundle.structure.trend.value}"
        f"{' with BOS' if bundle.structure.bos else ''}"
        f"{' / CHoCH' if bundle.structure.choch else ''}. "
        f"Liquidity: PDH {bundle.liquidity.previous_day_high:,.4g} / PDL "
        f"{bundle.liquidity.previous_day_low:,.4g}. "
        f"{_flow_text(bundle)}. {_funding_text(bundle, side)}. {_oi_text(bundle, side)}. "
        f"Cross-exchange: {xex}. News: {news}. "
        f"Key risks: {risk_txt}.{conf_txt} {invalidation}"
    )


def risk_level(confidence: float, plan: RiskPlan) -> str:
    if confidence >= 85 and plan.risk_reward >= 3:
        return "Low"
    if confidence >= 71:
        return "Moderate"
    return "High"
