from mexc_assistant.core.config import load_settings
from mexc_assistant.core.models import (
    AnalysisBundle,
    EMAState,
    FundingState,
    LiquidityState,
    OpenInterestState,
    OrderFlowState,
    Side,
    StructureState,
    TickerSnapshot,
    Trend,
    VolatilityState,
    VolumeState,
    Candle,
)
from mexc_assistant.risk.manager import RiskManager
from mexc_assistant.signals.confidence import score_signal
from mexc_assistant.signals.engine import SignalEngine
from mexc_assistant.alerts.formatter import format_signal_message


def _bundle(side_bias: str = "long") -> AnalysisBundle:
    bullish = side_bias == "long"
    price = 100.0
    candles = [
        Candle(i, price - 1, price + 1, price - 2, price, 2000)
        for i in range(40)
    ]
    # create a sweep wick on last candle
    if bullish:
        candles[-1] = Candle(40, 100, 101, 96, 100.2, 5000)
    else:
        candles[-1] = Candle(40, 100, 104, 99, 99.8, 5000)

    return AnalysisBundle(
        symbol="BTC_USDT",
        ticker=TickerSnapshot(
            symbol="BTC_USDT",
            last_price=price,
            bid=price - 0.1,
            ask=price + 0.1,
            volume24=1e6,
            hold_vol=1e7,
            funding_rate=0.00001,
            fair_price=price,
            index_price=price,
            timestamp=1,
        ),
        higher_tf_trend=Trend.BULLISH if bullish else Trend.BEARISH,
        execution_tf="Min15",
        ema=EMAState(
            ema20=99 if bullish else 101,
            ema50=98 if bullish else 102,
            ema100=97 if bullish else 103,
            ema200=96 if bullish else 104,
            aligned_long=bullish,
            aligned_short=not bullish,
            flat_or_intertwined=False,
            price_above_ema20=bullish,
            price_below_ema20=not bullish,
        ),
        structure=StructureState(
            trend=Trend.BULLISH if bullish else Trend.BEARISH,
            last_event=None,
            swing_high=102,
            swing_low=97,
            bos=True,
            choch=False,
        ),
        smc_zones=[],
        liquidity=LiquidityState(
            previous_day_high=103,
            previous_day_low=96,
            session_high=102,
            session_low=97,
            swept_low=bullish,
            swept_high=not bullish,
        ),
        order_flow=OrderFlowState(
            buy_volume=200 if bullish else 80,
            sell_volume=80 if bullish else 200,
            delta=120 if bullish else -120,
            imbalance=2.0 if bullish else -2.0,
            aggressive_buyers=bullish,
            aggressive_sellers=not bullish,
            absorption=False,
            supports_long=bullish,
            supports_short=not bullish,
        ),
        open_interest=OpenInterestState(
            current=1e7,
            previous=9.9e6,
            change_pct=0.01,
            rising=True,
            sharp_decline=False,
            confirms_long=bullish,
            confirms_short=not bullish,
        ),
        funding=FundingState(
            rate=0.00001,
            extreme_positive=False,
            extreme_negative=False,
            crowded_longs=False,
            crowded_shorts=False,
        ),
        volume=VolumeState(5000, 2000, True, True, True),
        volatility=VolatilityState(atr=1.5, atr_pct=0.015, sufficient=True),
        price=price,
        candles_exec=candles,
        rejects=[],
    )


def test_risk_plan_rr_minimum():
    settings = load_settings("config/settings.yaml")
    rm = RiskManager(settings)
    plan = rm.build_plan(Side.BUY, _bundle("long"))
    assert plan is not None
    assert plan.risk_reward >= settings.risk.min_rr
    assert plan.stop_loss < plan.entry
    assert plan.tp3 > plan.entry


def test_confidence_scoring_range():
    settings = load_settings("config/settings.yaml")
    rm = RiskManager(settings)
    bundle = _bundle("long")
    plan = rm.build_plan(Side.BUY, bundle)
    assert plan is not None
    breakdown = score_signal(Side.BUY, bundle, plan, settings.confidence)
    assert 0 <= breakdown.total <= 100


def test_signal_engine_idle_without_zone():
    settings = load_settings("config/settings.yaml")
    engine = SignalEngine(settings, RiskManager(settings))
    signal, decision = engine.evaluate(_bundle("long"))
    # Without SMC zones, side resolution fails or hard rejects
    assert signal is None
    assert decision.accepted is False


def test_formatter_contains_fields():
    settings = load_settings("config/settings.yaml")
    from mexc_assistant.core.models import ConfidenceBreakdown, RiskLevel, Signal

    signal = Signal(
        symbol="BTC_USDT",
        side=Side.BUY,
        trend=Trend.BULLISH,
        confidence=91,
        confidence_breakdown=ConfidenceBreakdown({}, 91, {}),
        entry=118250,
        stop_loss=117680,
        tp1=119300,
        tp2=120150,
        tp3=121500,
        final_target=122000,
        risk_reward=3.4,
        risk_level=RiskLevel.LOW,
        reason="test",
        commentary="test commentary",
        invalidation="sl",
        status="Await confirmation candle close.",
    )
    text = format_signal_message(signal)
    assert "BUY BTCUSDT" in text
    assert "Confidence" in text
    assert "Take Profit 1" in text
