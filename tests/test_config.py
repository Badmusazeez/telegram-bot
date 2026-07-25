from mexc_assistant.core.config import load_settings


def test_load_default_settings():
    settings = load_settings("config/settings.yaml")
    assert "BTC_USDT" in settings.symbols
    assert settings.confidence.min_score == 66
    assert settings.risk.min_rr == 2.5
    assert abs(sum(settings.confidence.weights.values()) - 100) < 1e-6
    assert settings.cross_exchange.enabled is True
    assert settings.data_sources.news_enabled is True
    assert "liquidation_heatmap" in settings.confidence.weights
    assert "smart_money" in settings.confidence.weights


def test_confidence_weight_keys():
    settings = load_settings("config/settings.yaml")
    expected = {
        "ema_alignment",
        "higher_timeframe",
        "market_structure",
        "smart_money",
        "liquidity_sweep",
        "order_flow",
        "open_interest",
        "funding_rate",
        "liquidation_heatmap",
        "volume_confirmation",
        "volatility_filter",
        "risk_reward",
    }
    assert set(settings.confidence.weights) == expected
