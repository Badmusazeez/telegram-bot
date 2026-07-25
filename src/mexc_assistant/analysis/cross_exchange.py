"""MEXC vs OKX cross-exchange validation."""

from __future__ import annotations

from mexc_assistant.core.config import CrossExchangeConfig
from mexc_assistant.core.models import CrossExchangeState, OpenInterestState, Trend, TickerSnapshot
from mexc_assistant.exchange.okx_rest import OkxRestClient


async def validate_cross_exchange(
    symbol: str,
    mexc_ticker: TickerSnapshot,
    mexc_oi: OpenInterestState,
    mexc_trend: Trend,
    okx: OkxRestClient,
    config: CrossExchangeConfig,
) -> CrossExchangeState:
    if not config.enabled:
        return CrossExchangeState(notes=["Cross-exchange validation disabled"])

    notes: list[str] = []
    try:
        okx_ticker = await okx.get_ticker(symbol)
        okx_funding = await okx.get_funding_rate(symbol)
        okx_oi = await okx.get_open_interest(symbol)
        okx_candles = await okx.get_klines(symbol, bar="1H", limit=40)
        okx_trend = okx.simple_trend(okx_candles)
    except Exception as exc:  # noqa: BLE001
        return CrossExchangeState(
            conflicting=False,
            penalty=config.soft_penalty / 2,
            notes=[f"OKX unavailable ({exc}); soft penalty applied"],
        )

    mexc_price = mexc_ticker.last_price
    okx_price = float(okx_ticker.get("last") or 0.0)
    premium = (mexc_price - okx_price) / max(okx_price, 1e-12)
    funding_delta = abs(mexc_ticker.funding_rate - okx_funding)

    prev_okx = okx.previous_oi(symbol) or okx_oi
    okx_oi_change = (okx_oi - prev_okx) / max(prev_okx, 1e-12)
    oi_agree = (
        (mexc_oi.rising and okx_oi_change >= 0)
        or ((not mexc_oi.rising) and okx_oi_change <= 0)
        or abs(okx_oi_change) < 0.001
    )

    trend_agree = (
        mexc_trend == okx_trend
        or mexc_trend == Trend.NEUTRAL
        or okx_trend == Trend.NEUTRAL
    )

    okx_vol = float(okx_ticker.get("volCcy24h") or okx_ticker.get("vol24h") or 0.0)
    mexc_vol = mexc_ticker.volume24
    volume_anomaly = False
    if okx_vol > 0 and mexc_vol > 0:
        ratio = max(mexc_vol, okx_vol) / max(min(mexc_vol, okx_vol), 1e-12)
        # Normalize loosely: MEXC volume units differ; only flag extreme mismatches via price+funding together
        volume_anomaly = ratio > config.volume_anomaly_ratio * 50 and abs(premium) > config.max_premium_pct

    conflicting = False
    penalty = 0.0

    if abs(premium) > config.max_premium_pct:
        notes.append(f"Price premium/discount MEXC vs OKX {premium:+.3%}")
        penalty += config.soft_penalty
        if abs(premium) > config.max_premium_pct * 2:
            conflicting = True

    if funding_delta > config.max_funding_delta:
        notes.append(f"Funding divergence {funding_delta:.4%} (MEXC {mexc_ticker.funding_rate:.4%} vs OKX {okx_funding:.4%})")
        penalty += config.soft_penalty / 2

    if not oi_agree:
        notes.append("Open interest direction disagrees across MEXC/OKX")
        penalty += config.soft_penalty / 2

    if not trend_agree:
        notes.append(f"Trend conflict: MEXC {mexc_trend.value} vs OKX {okx_trend.value}")
        conflicting = True
        penalty += config.soft_penalty

    if volume_anomaly:
        notes.append("Abnormal volume/price dislocation across venues")
        conflicting = True

    if not notes:
        notes.append("MEXC/OKX conditions aligned")

    return CrossExchangeState(
        okx_price=okx_price,
        mexc_price=mexc_price,
        premium_pct=premium,
        okx_funding=okx_funding,
        mexc_funding=mexc_ticker.funding_rate,
        funding_delta=funding_delta,
        okx_oi=okx_oi,
        mexc_oi=mexc_oi.current,
        oi_agree=oi_agree,
        trend_agree=trend_agree,
        volume_anomaly=volume_anomaly,
        conflicting=conflicting,
        penalty=min(penalty, 25.0),
        notes=notes,
    )
