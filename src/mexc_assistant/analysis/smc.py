"""Smart Money Concepts: order blocks, FVGs, breakers, premium/discount."""

from __future__ import annotations

from mexc_assistant.core.config import SMCConfig
from mexc_assistant.core.models import Candle, Side, SMCZone


def _impulse_strength(c: Candle) -> float:
    body = abs(c.close - c.open)
    rng = max(c.high - c.low, 1e-12)
    return body / rng


def detect_order_blocks(candles: list[Candle], config: SMCConfig) -> list[SMCZone]:
    zones: list[SMCZone] = []
    lookback = min(config.order_block_lookback, len(candles) - 3)
    start = max(1, len(candles) - lookback - 1)

    for i in range(start, len(candles) - 1):
        c = candles[i]
        nxt = candles[i + 1]
        # Bullish OB: last down candle before strong up impulse
        if c.close < c.open and nxt.close > nxt.open and _impulse_strength(nxt) > 0.55:
            if nxt.close > c.high:
                zones.append(
                    SMCZone(
                        kind="order_block",
                        side=Side.BUY,
                        top=c.high,
                        bottom=c.low,
                        strength=_impulse_strength(nxt),
                    )
                )
        # Bearish OB: last up candle before strong down impulse
        if c.close > c.open and nxt.close < nxt.open and _impulse_strength(nxt) > 0.55:
            if nxt.close < c.low:
                zones.append(
                    SMCZone(
                        kind="order_block",
                        side=Side.SELL,
                        top=c.high,
                        bottom=c.low,
                        strength=_impulse_strength(nxt),
                    )
                )
    return zones[-8:]


def detect_fvgs(candles: list[Candle], config: SMCConfig) -> list[SMCZone]:
    zones: list[SMCZone] = []
    for i in range(2, len(candles)):
        c0, c1, c2 = candles[i - 2], candles[i - 1], candles[i]
        # Bullish FVG: gap between c0.high and c2.low
        if c2.low > c0.high:
            gap = (c2.low - c0.high) / max(c1.close, 1e-12)
            if gap >= config.fvg_min_gap_pct:
                zones.append(
                    SMCZone(
                        kind="fvg",
                        side=Side.BUY,
                        top=c2.low,
                        bottom=c0.high,
                        strength=gap,
                    )
                )
        # Bearish FVG
        if c2.high < c0.low:
            gap = (c0.low - c2.high) / max(c1.close, 1e-12)
            if gap >= config.fvg_min_gap_pct:
                zones.append(
                    SMCZone(
                        kind="fvg",
                        side=Side.SELL,
                        top=c0.low,
                        bottom=c2.high,
                        strength=gap,
                    )
                )
    return zones[-8:]


def detect_breakers(zones: list[SMCZone], price: float) -> list[SMCZone]:
    """Mark mitigated OBs that flipped role as breakers."""
    breakers: list[SMCZone] = []
    for z in zones:
        if z.kind != "order_block":
            continue
        if z.side == Side.BUY and price < z.bottom:
            breakers.append(
                SMCZone(
                    kind="breaker",
                    side=Side.SELL,
                    top=z.top,
                    bottom=z.bottom,
                    mitigated=True,
                    strength=z.strength,
                )
            )
        elif z.side == Side.SELL and price > z.top:
            breakers.append(
                SMCZone(
                    kind="breaker",
                    side=Side.BUY,
                    top=z.top,
                    bottom=z.bottom,
                    mitigated=True,
                    strength=z.strength,
                )
            )
    return breakers


def premium_discount(candles: list[Candle]) -> tuple[float, float, str]:
    """Return (equilibrium, range_high/low midpoint info) and zone label."""
    window = candles[-50:] if len(candles) >= 50 else candles
    hi = max(c.high for c in window)
    lo = min(c.low for c in window)
    eq = (hi + lo) / 2.0
    price = window[-1].close
    if price >= eq:
        return eq, hi, "premium"
    return eq, lo, "discount"


def price_in_zone(price: float, zone: SMCZone, tol_pct: float) -> bool:
    pad = price * tol_pct
    return (zone.bottom - pad) <= price <= (zone.top + pad)


def analyze_smc(candles: list[Candle], config: SMCConfig) -> list[SMCZone]:
    obs = detect_order_blocks(candles, config)
    fvgs = detect_fvgs(candles, config)
    price = candles[-1].close
    breakers = detect_breakers(obs, price)
    # Mitigation blocks: OBs revisited and partially filled
    mitigated: list[SMCZone] = []
    for z in obs:
        if price_in_zone(price, z, config.zone_touch_tolerance_pct):
            z.mitigated = True
            mitigated.append(
                SMCZone(
                    kind="mitigation_block",
                    side=z.side,
                    top=z.top,
                    bottom=z.bottom,
                    mitigated=True,
                    strength=z.strength,
                )
            )
    return obs + fvgs + breakers + mitigated
