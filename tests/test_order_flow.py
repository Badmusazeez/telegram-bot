from mexc_assistant.analysis.order_flow import analyze_order_flow
from mexc_assistant.core.config import OrderFlowConfig
from mexc_assistant.core.models import Candle, TradeTick


def test_order_flow_aggressive_buyers():
    trades = [
        TradeTick(price=100, quantity=10, side=1, timestamp=i) for i in range(50)
    ] + [
        TradeTick(price=100, quantity=2, side=2, timestamp=100 + i) for i in range(10)
    ]
    candles = [Candle(i, 100, 101, 99, 100.5, 100) for i in range(30)]
    state = analyze_order_flow(trades, candles, OrderFlowConfig())
    assert state.aggressive_buyers
    assert state.supports_long
    assert state.delta > 0
