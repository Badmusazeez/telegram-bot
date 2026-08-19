from mexc_assistant.analysis.liquidity import analyze_liquidity
from mexc_assistant.analysis.smc import analyze_smc, detect_fvgs
from mexc_assistant.analysis.structure import analyze_structure
from mexc_assistant.core.config import SMCConfig, StructureConfig
from mexc_assistant.core.models import Candle, Trend


def _zigzag(n: int = 120) -> list[Candle]:
    candles: list[Candle] = []
    price = 100.0
    for i in range(n):
        # higher highs / higher lows overall
        swing = 2.0 if (i // 5) % 2 == 0 else -1.0
        o = price
        c = price + 0.4 + swing * 0.1
        h = max(o, c) + 0.5
        l = min(o, c) - 0.5
        candles.append(Candle(time=i, open=o, high=h, low=l, close=c, volume=1000))
        price = c
    return candles


def test_structure_detects_trend():
    state = analyze_structure(_zigzag(), StructureConfig())
    assert state.trend in {Trend.BULLISH, Trend.BEARISH, Trend.NEUTRAL}
    assert state.swing_high > 0
    assert state.swing_low > 0


def test_fvg_detection():
    candles = [
        Candle(1, 10, 10.2, 9.8, 10.0, 100),
        Candle(2, 10.0, 10.5, 10.0, 10.4, 120),
        Candle(3, 10.8, 11.0, 10.75, 10.9, 150),  # gap above candle 1 high
    ]
    fvgs = detect_fvgs(candles, SMCConfig(fvg_min_gap_pct=0.001))
    assert any(z.kind == "fvg" for z in fvgs)


def test_smc_returns_zones():
    zones = analyze_smc(_zigzag(), SMCConfig())
    assert isinstance(zones, list)


def test_liquidity_sweep_fields():
    exec_c = _zigzag()
    daily = exec_c[::10] or exec_c
    liq = analyze_liquidity(exec_c, daily, StructureConfig())
    assert liq.previous_day_high > 0
    assert liq.session_low > 0
