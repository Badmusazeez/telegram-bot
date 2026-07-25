"""Liquidation heatmap approximation from depth + liquidity magnets.

MEXC does not expose a public liquidation heatmap endpoint. We approximate
liquidation magnets using:
- clustered equal highs/lows
- previous day / session extremes
- thin book gaps / heavy resting liquidity from order book depth
"""

from __future__ import annotations

from typing import Any

from mexc_assistant.core.models import LiquidityState, Side


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
                out.append((float(row.get("price") or row.get("p")), float(row.get("vol") or row.get("v") or 0)))
        return out

    ask_lvls = _levels(asks)
    bid_lvls = _levels(bids)
    avg_ask = sum(v for _, v in ask_lvls) / max(len(ask_lvls), 1)
    avg_bid = sum(v for _, v in bid_lvls) / max(len(bid_lvls), 1)

    # Heavy resting liquidity above = short liquidation magnet / stop cluster
    short_pools = [p for p, v in ask_lvls if v >= avg_ask * 1.8 and p > mid]
    long_pools = [p for p, v in bid_lvls if v >= avg_bid * 1.8 and p < mid]

    # Merge classic liquidity magnets
    short_pools.extend([x for x in liquidity.magnets if x > mid])
    long_pools.extend([x for x in liquidity.magnets if x < mid])

    return {
        "long_liquidation_pools": sorted(set(round(x, 8) for x in long_pools))[-6:],
        "short_liquidation_pools": sorted(set(round(x, 8) for x in short_pools))[:6],
    }


def prefers_entry_after_sweep(side: Side, liquidity: LiquidityState, stabilized: bool) -> bool:
    if side == Side.BUY:
        return liquidity.swept_low and stabilized
    return liquidity.swept_high and stabilized
