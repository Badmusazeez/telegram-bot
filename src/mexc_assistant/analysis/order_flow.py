"""Aggressive order-flow / delta / imbalance / absorption."""

from __future__ import annotations

from mexc_assistant.core.config import OrderFlowConfig
from mexc_assistant.core.models import Candle, OrderFlowState, TradeTick


def analyze_order_flow(
    trades: list[TradeTick],
    candles: list[Candle],
    config: OrderFlowConfig,
) -> OrderFlowState:
    window = trades[-config.trade_window :]
    buy_vol = sum(t.quantity for t in window if t.side == 1)
    sell_vol = sum(t.quantity for t in window if t.side == 2)
    total = buy_vol + sell_vol
    delta = buy_vol - sell_vol

    if total <= 0 and candles:
        # Fallback from candle bodies when trade tape unavailable
        recent = candles[-20:]
        up = sum(c.volume for c in recent if c.close >= c.open)
        down = sum(c.volume for c in recent if c.close < c.open)
        buy_vol, sell_vol, total, delta = up, down, up + down, up - down

    imbalance = (buy_vol / sell_vol) if sell_vol > 0 else (999.0 if buy_vol > 0 else 1.0)
    inv_imbalance = (sell_vol / buy_vol) if buy_vol > 0 else (999.0 if sell_vol > 0 else 1.0)

    aggressive_buyers = imbalance >= config.imbalance_threshold
    aggressive_sellers = inv_imbalance >= config.imbalance_threshold

    avg_vol = (
        sum(c.volume for c in candles[-config.trade_window // 10 or 1 :])
        / max(len(candles[-20:]), 1)
        if candles
        else 0.0
    )
    last_vol = candles[-1].volume if candles else 0.0
    last = candles[-1] if candles else None
    absorption = False
    if last and avg_vol > 0:
        # High volume with small net displacement => absorption
        displacement = abs(last.close - last.open) / max(last.close, 1e-12)
        absorption = last_vol >= avg_vol * config.absorption_volume_mult and displacement < 0.0015

    supports_long = aggressive_buyers and not (aggressive_sellers and delta < 0)
    supports_short = aggressive_sellers and not (aggressive_buyers and delta > 0)

    # Absorption against direction weakens support
    if absorption and last:
        if last.close >= last.open:
            supports_short = False
        else:
            supports_long = False

    return OrderFlowState(
        buy_volume=buy_vol,
        sell_volume=sell_vol,
        delta=delta,
        imbalance=imbalance if buy_vol >= sell_vol else -inv_imbalance,
        aggressive_buyers=aggressive_buyers,
        aggressive_sellers=aggressive_sellers,
        absorption=absorption,
        supports_long=supports_long,
        supports_short=supports_short,
    )
