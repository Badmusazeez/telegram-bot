from mexc_assistant.core.config import load_settings
from mexc_assistant.core.models import (
    AnalysisBundle,
    ConfidenceBreakdown,
    ConfidenceLevel,
    EMAState,
    FundingState,
    LiquidationHeatmapState,
    LiquidityState,
    OpenInterestState,
    OrderFlowState,
    RiskLevel,
    Side,
    Signal,
    StructureState,
    TickerSnapshot,
    Trend,
    VolatilityState,
    VolumeState,
    Candle,
    confidence_level,
)
from mexc_assistant.risk.manager import RiskManager
from mexc_assistant.signals.confidence import count_positive_categories, score_signal
from mexc_assistant.signals.engine import SignalEngine
from mexc_assistant.alerts.formatter import format_signal_message
from mexc_assistant.core.models import SMCZone


def _bundle(side_bias: str = "long", with_zone: bool = False) -> AnalysisBundle:
    bullish = side_bias == "long"
    price = 100.0
    candles = [Candle(i, price - 1, price + 1, price - 2, price, 2000) for i in range(40)]
    if bullish:
        candles[-1] = Candle(40, 100, 101, 96, 100.2, 5000)
    else:
        candles[-1] = Candle(40, 100, 104, 99, 99.8, 5000)

    zones = []
    if with_zone:
        zones = [
            SMCZone(
                kind="order_block",
                side=Side.BUY if bullish else Side.SELL,
                top=price + 0.5,
                bottom=price - 0.5,
                strength=1.0,
            )
        ]

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
        smc_zones=zones,
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
        liquidation=LiquidationHeatmapState(
            long_pools=[96, 97],
            short_pools=[103, 104],
            recent_long_liqs=10 if bullish else 2,
            recent_short_liqs=2 if bullish else 10,
            sweep_aligned=True,
            score_hint=90.0,
        ),
        rejects=[],
    )


def test_confidence_levels():
    assert confidence_level(65) == ConfidenceLevel.BELOW_THRESHOLD
    assert confidence_level(66) == ConfidenceLevel.STANDARD
    assert confidence_level(70) == ConfidenceLevel.STANDARD
    assert confidence_level(71) == ConfidenceLevel.HIGH_QUALITY
    assert confidence_level(84) == ConfidenceLevel.HIGH_QUALITY
    assert confidence_level(85) == ConfidenceLevel.ELITE


def test_risk_plan_rr_minimum():
    settings = load_settings("config/settings.yaml")
    rm = RiskManager(settings)
    plan = rm.build_plan(Side.BUY, _bundle("long", with_zone=True))
    assert plan is not None
    assert plan.risk_reward >= settings.risk.min_rr
    assert plan.stop_loss < plan.entry
    assert plan.tp3 > plan.entry


def test_confidence_scoring_explanations():
    settings = load_settings("config/settings.yaml")
    rm = RiskManager(settings)
    bundle = _bundle("long", with_zone=True)
    plan = rm.build_plan(Side.BUY, bundle)
    assert plan is not None
    breakdown = score_signal(Side.BUY, bundle, plan, settings.confidence)
    assert 0 <= breakdown.total <= 100
    assert abs(sum(settings.confidence.weights.values()) - 100) < 1e-6
    assert "smart_money" in breakdown.scores
    assert "liquidation_heatmap" in breakdown.scores
    assert breakdown.factors
    assert breakdown.positive
    assert breakdown.summary
    assert count_positive_categories(breakdown, settings.confidence) >= 6


def test_signal_engine_idle_without_zone():
    settings = load_settings("config/settings.yaml")
    engine = SignalEngine(settings, RiskManager(settings))
    signal, decision = engine.evaluate(_bundle("long", with_zone=False))
    assert signal is None
    assert decision.accepted is False


def test_formatter_contains_confidence_factors():
    signal = Signal(
        symbol="BTC_USDT",
        side=Side.BUY,
        trend=Trend.BULLISH,
        confidence=91,
        confidence_breakdown=ConfidenceBreakdown(
            scores={"ema_alignment": 100},
            total=91,
            weights={"ema_alignment": 12},
            level=ConfidenceLevel.ELITE,
            positive=["EMA Alignment: stack aligned (100/100, weight 12%)"],
            negative=[],
            summary="Confidence 91% — Elite Institutional Setup.",
        ),
        confidence_level=ConfidenceLevel.ELITE,
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
    assert "Elite Institutional Setup" in text
    assert "Positive Factors" in text
    assert "Negative Factors" in text
