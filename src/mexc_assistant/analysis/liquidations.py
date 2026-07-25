"""Liquidation heatmap approximation from depth + OKX liquidation prints."""

from __future__ import annotations

from typing import Any

from mexc_assistant.core.models import LiquidationHeatmapState, LiquidityState, Side


def estimate_liquidation_pools(
    depth: dict[str, Any],
    liquidity: LiquidityState,
    mid: float,
) -> dict[str, list[float]]:
    asks = depth.get("asks") or depth.get("ask") or []
    bids = depth.get("bids") or depth.get("bid") or []

    def _levels(rows: list[Any], n: int = 15) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for row in rows[:n]:
            if isinstance(row, (list, tuple)) and len(row) >= 2:
                out.append((float(row[0]), float(row[1])))
            elif isinstance(row, dict):
                out.append(
                    (
                        float(row.get("price") or row.get("p")),
                        float(row.get("vol") or row.get("v") or 0),
                    )
                )
        return out

    ask_lvls = _levels(asks)
    bid_lvls = _levels(bids)
    avg_ask = sum(v for _, v in ask_lvls) / max(len(ask_lvls), 1)
    avg_bid = sum(v for _, v in bid_lvls) / max(len(bid_lvls), 1)

    short_pools = [p for p, v in ask_lvls if v >= avg_ask * 1.8 and p > mid]
    long_pools = [p for p, v in bid_lvls if v >= avg_bid * 1.8 and p < mid]
    short_pools.extend([x for x in liquidity.magnets if x > mid])
    long_pools.extend([x for x in liquidity.magnets if x < mid])

    return {
        "long_liquidation_pools": sorted(set(round(x, 8) for x in long_pools))[-6:],
        "short_liquidation_pools": sorted(set(round(x, 8) for x in short_pools))[:6],
    }


def build_liquidation_state(
    depth: dict[str, Any],
    liquidity: LiquidityState,
    mid: float,
    okx_liqs: list[dict[str, Any]] | None,
    side: Side | None = None,
) -> LiquidationHeatmapState:
    pools = estimate_liquidation_pools(depth, liquidity, mid)
    long_pools = pools["long_liquidation_pools"]
    short_pools = pools["short_liquidation_pools"]

    recent_long = 0.0
    recent_short = 0.0
    for item in okx_liqs or []:
        pos_side = str(item.get("posSide") or "").lower()
        size = float(item.get("sz") or 0.0)
        # OKX: long liquidations have posSide=long (forced sell); short liqs posSide=short
        if pos_side == "long":
            recent_long += size
        elif pos_side == "short":
            recent_short += size

    sweep_aligned = False
    score = 50.0
    if side == Side.BUY:
        sweep_aligned = liquidity.swept_low
        if sweep_aligned and recent_long >= recent_short:
            score = 95.0
        elif sweep_aligned:
            score = 80.0
        elif recent_long > recent_short * 1.5:
            score = 70.0
        else:
            score = 35.0
    elif side == Side.SELL:
        sweep_aligned = liquidity.swept_high
        if sweep_aligned and recent_short >= recent_long:
            score = 95.0
        elif sweep_aligned:
            score = 80.0
        elif recent_short > recent_long * 1.5:
            score = 70.0
        else:
            score = 35.0
    else:
        # Neutral pre-side score for pipeline
        if liquidity.swept_low or liquidity.swept_high:
            score = 70.0
        if recent_long + recent_short > 0:
            score = max(score, 60.0)

    return LiquidationHeatmapState(
        long_pools=long_pools,
        short_pools=short_pools,
        recent_long_liqs=recent_long,
        recent_short_liqs=recent_short,
        sweep_aligned=sweep_aligned,
        score_hint=score,
    )


def prefers_entry_after_sweep(side: Side, liquidity: LiquidityState, stabilized: bool) -> bool:
    if side == Side.BUY:
        return liquidity.swept_low and stabilized
    return liquidity.swept_high and stabilized
