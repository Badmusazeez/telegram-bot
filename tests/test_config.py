from mexc_assistant.core.config import load_settings


def test_load_default_settings():
    settings = load_settings("config/settings.yaml")
    assert "BTC_USDT" in settings.symbols
    assert settings.confidence.min_score == 66
    assert settings.risk.min_rr == 2.5
    assert abs(sum(settings.confidence.weights.values()) - 110) < 1e-6
