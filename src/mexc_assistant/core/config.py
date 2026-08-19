"""Configuration loading from YAML + environment overrides."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppConfig(BaseModel):
    name: str = "mexc-ai-trading-assistant"
    scan_interval_seconds: int = 30
    health_port: int = 8080
    dry_run: bool = False
    timezone: str = "UTC"


class ExchangeConfig(BaseModel):
    name: str = "mexc"
    rest_base_url: str = "https://contract.mexc.com"
    ws_url: str = "wss://contract.mexc.com/edge"
    request_timeout_seconds: int = 15
    max_retries: int = 5
    retry_backoff_seconds: float = 1.5


class EMAConfig(BaseModel):
    periods: list[int] = Field(default_factory=lambda: [20, 50, 100, 200])
    min_slope_pct: float = 0.00005
    max_intertwine_pct: float = 0.0015


class StructureConfig(BaseModel):
    swing_lookback: int = 5
    equal_level_tolerance_pct: float = 0.0008


class SMCConfig(BaseModel):
    fvg_min_gap_pct: float = 0.0005
    order_block_lookback: int = 30
    zone_touch_tolerance_pct: float = 0.0015


class ICT2022Config(BaseModel):
    """ICT 2022 Model: HTF SSL/BSL sweep → LTF MSS → FVG entry."""

    enabled: bool = True
    require_for_alert: bool = True
    htf_interval: str = "Min15"
    ltf_interval: str = "Min5"
    htf_sweep_lookback: int = 40
    stop_buffer_pct: float = 0.0003
    entry_proximity_pct: float = 0.004
    min_model_rr: float = 2.0
    fallback_target_extension: float = 1.5


class OrderFlowConfig(BaseModel):
    trade_window: int = 200
    imbalance_threshold: float = 1.35
    absorption_volume_mult: float = 1.8


class OpenInterestConfig(BaseModel):
    rising_threshold_pct: float = 0.002
    sharp_decline_pct: float = -0.01


class FundingConfig(BaseModel):
    extreme_positive: float = 0.0005
    extreme_negative: float = -0.0005


class VolumeConfig(BaseModel):
    avg_lookback: int = 20
    breakout_multiplier: float = 1.4
    spike_multiplier: float = 1.8


class VolatilityConfig(BaseModel):
    atr_period: int = 14
    min_atr_pct: float = 0.0015
    stop_atr_multiplier: float = 1.5


class RiskConfig(BaseModel):
    account_equity: float = 10000
    risk_per_trade_pct: float = 0.01
    min_rr: float = 2.5
    preferred_rr: float = 3.0
    max_simultaneous_positions: int = 3
    daily_loss_limit_pct: float = 0.03
    weekly_loss_limit_pct: float = 0.08
    trailing_after_tp1: bool = True


class ConfidenceConfig(BaseModel):
    min_score: float = 66
    preferred_score: float = 90
    positive_threshold: float = 65
    negative_threshold: float = 40
    min_positive_categories: int = 6
    weights: dict[str, float] = Field(
        default_factory=lambda: {
            "ema_alignment": 10,
            "higher_timeframe": 9,
            "market_structure": 8,
            "smart_money": 7,
            "ict_2022": 12,
            "liquidity_sweep": 8,
            "order_flow": 9,
            "open_interest": 7,
            "funding_rate": 5,
            "liquidation_heatmap": 8,
            "volume_confirmation": 7,
            "volatility_filter": 5,
            "risk_reward": 5,
        }
    )


class CrossExchangeConfig(BaseModel):
    enabled: bool = True
    max_premium_pct: float = 0.0025
    max_funding_delta: float = 0.0004
    volume_anomaly_ratio: float = 3.0
    reject_on_conflict: bool = True
    soft_penalty: float = 8.0


class DataSourcesConfig(BaseModel):
    okx_base_url: str = "https://www.okx.com"
    cmc_pro_base_url: str = "https://pro-api.coinmarketcap.com"
    cmc_public_base_url: str = "https://api.coinmarketcap.com"
    news_enabled: bool = True
    news_lookback_hours: int = 12
    news_suppress_minutes: int = 45
    high_impact_penalty: float = 12.0


class AlertsConfig(BaseModel):
    dedupe_window_minutes: int = 90
    require_confirmation_candle: bool = True
    telegram_parse_mode: str = "HTML"


class LoggingConfig(BaseModel):
    level: str = "INFO"
    json_logs: bool = True
    decision_log_path: str = "logs/decisions.jsonl"
    app_log_path: str = "logs/app.log"


class PluginsConfig(BaseModel):
    enabled: list[str] = Field(default_factory=list)


class TimeframesConfig(BaseModel):
    higher: list[str] = Field(default_factory=lambda: ["Day1", "Hour4", "Min60"])
    execution: list[str] = Field(default_factory=lambda: ["Min15", "Min5"])


class Settings(BaseModel):
    app: AppConfig = Field(default_factory=AppConfig)
    exchange: ExchangeConfig = Field(default_factory=ExchangeConfig)
    symbols: list[str] = Field(
        default_factory=lambda: [
            "BTC_USDT",
            "ETH_USDT",
            "SOL_USDT",
            "XRP_USDT",
            "BNB_USDT",
            "DOGE_USDT",
        ]
    )
    timeframes: TimeframesConfig = Field(default_factory=TimeframesConfig)
    ema: EMAConfig = Field(default_factory=EMAConfig)
    structure: StructureConfig = Field(default_factory=StructureConfig)
    smc: SMCConfig = Field(default_factory=SMCConfig)
    ict_2022: ICT2022Config = Field(default_factory=ICT2022Config)
    order_flow: OrderFlowConfig = Field(default_factory=OrderFlowConfig)
    open_interest: OpenInterestConfig = Field(default_factory=OpenInterestConfig)
    funding: FundingConfig = Field(default_factory=FundingConfig)
    volume: VolumeConfig = Field(default_factory=VolumeConfig)
    volatility: VolatilityConfig = Field(default_factory=VolatilityConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    confidence: ConfidenceConfig = Field(default_factory=ConfidenceConfig)
    cross_exchange: CrossExchangeConfig = Field(default_factory=CrossExchangeConfig)
    data_sources: DataSourcesConfig = Field(default_factory=DataSourcesConfig)
    alerts: AlertsConfig = Field(default_factory=AlertsConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    plugins: PluginsConfig = Field(default_factory=PluginsConfig)


class EnvSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    mexc_api_key: str = ""
    mexc_api_secret: str = ""
    cmc_api_key: str = ""
    config_path: str = "config/settings.yaml"
    log_level: str = ""
    account_equity: float | None = None
    dry_run: bool | None = None


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_settings(config_path: str | Path | None = None) -> Settings:
    env = EnvSettings()
    path = Path(config_path or env.config_path or os.getenv("CONFIG_PATH", "config/settings.yaml"))
    raw: dict[str, Any] = {}
    if path.exists():
        with path.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh) or {}

    settings = Settings.model_validate(raw)

    if env.account_equity is not None:
        settings.risk.account_equity = env.account_equity
    if env.dry_run is not None:
        settings.app.dry_run = env.dry_run
    if env.log_level:
        settings.logging.level = env.log_level

    # Attach secrets for runtime consumers
    object.__setattr__(settings, "_env", env)
    return settings


def get_env(settings: Settings) -> EnvSettings:
    env = getattr(settings, "_env", None)
    if env is None:
        env = EnvSettings()
        object.__setattr__(settings, "_env", env)
    return env


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
