"""Shared domain models."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class Trend(str, Enum):
    BULLISH = "Bullish"
    BEARISH = "Bearish"
    NEUTRAL = "Neutral"


class RiskLevel(str, Enum):
    LOW = "Low"
    MODERATE = "Moderate"
    HIGH = "High"


class ConfidenceLevel(str, Enum):
    BELOW_THRESHOLD = "Below Threshold"
    STANDARD = "Standard Setup"
    HIGH_QUALITY = "High-Quality Setup"
    ELITE = "Elite Institutional Setup"


class StructureEvent(str, Enum):
    HH = "Higher High"
    HL = "Higher Low"
    LH = "Lower High"
    LL = "Lower Low"
    BOS = "Break of Structure"
    CHOCH = "Change of Character"


def confidence_level(score: float) -> ConfidenceLevel:
    if score < 66:
        return ConfidenceLevel.BELOW_THRESHOLD
    if score <= 70:
        return ConfidenceLevel.STANDARD
    if score <= 84:
        return ConfidenceLevel.HIGH_QUALITY
    return ConfidenceLevel.ELITE


@dataclass(slots=True)
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    amount: float = 0.0

    @property
    def bullish(self) -> bool:
        return self.close >= self.open


@dataclass(slots=True)
class TradeTick:
    price: float
    quantity: float
    side: int  # 1 buy, 2 sell (MEXC)
    timestamp: int


@dataclass(slots=True)
class TickerSnapshot:
    symbol: str
    last_price: float
    bid: float
    ask: float
    volume24: float
    hold_vol: float  # open interest
    funding_rate: float
    fair_price: float
    index_price: float
    timestamp: int


@dataclass(slots=True)
class EMAState:
    ema20: float
    ema50: float
    ema100: float
    ema200: float
    aligned_long: bool
    aligned_short: bool
    flat_or_intertwined: bool
    price_above_ema20: bool
    price_below_ema20: bool


@dataclass(slots=True)
class StructureState:
    trend: Trend
    last_event: StructureEvent | None
    swing_high: float
    swing_low: float
    bos: bool
    choch: bool
    events: list[StructureEvent] = field(default_factory=list)


@dataclass(slots=True)
class SMCZone:
    kind: str
    side: Side
    top: float
    bottom: float
    mitigated: bool = False
    strength: float = 1.0


@dataclass(slots=True)
class LiquidityState:
    equal_highs: list[float] = field(default_factory=list)
    equal_lows: list[float] = field(default_factory=list)
    previous_day_high: float = 0.0
    previous_day_low: float = 0.0
    session_high: float = 0.0
    session_low: float = 0.0
    swept_high: bool = False
    swept_low: bool = False
    magnets: list[float] = field(default_factory=list)


@dataclass(slots=True)
class OrderFlowState:
    buy_volume: float
    sell_volume: float
    delta: float
    imbalance: float
    aggressive_buyers: bool
    aggressive_sellers: bool
    absorption: bool
    supports_long: bool
    supports_short: bool


@dataclass(slots=True)
class OpenInterestState:
    current: float
    previous: float
    change_pct: float
    rising: bool
    sharp_decline: bool
    confirms_long: bool
    confirms_short: bool


@dataclass(slots=True)
class FundingState:
    rate: float
    extreme_positive: bool
    extreme_negative: bool
    crowded_longs: bool
    crowded_shorts: bool


@dataclass(slots=True)
class VolumeState:
    current: float
    average: float
    above_average: bool
    breakout: bool
    spike: bool


@dataclass(slots=True)
class VolatilityState:
    atr: float
    atr_pct: float
    sufficient: bool


@dataclass(slots=True)
class LiquidationHeatmapState:
    long_pools: list[float] = field(default_factory=list)
    short_pools: list[float] = field(default_factory=list)
    recent_long_liqs: float = 0.0
    recent_short_liqs: float = 0.0
    sweep_aligned: bool = False
    score_hint: float = 50.0


@dataclass(slots=True)
class CrossExchangeState:
    okx_price: float = 0.0
    mexc_price: float = 0.0
    premium_pct: float = 0.0
    okx_funding: float = 0.0
    mexc_funding: float = 0.0
    funding_delta: float = 0.0
    okx_oi: float = 0.0
    mexc_oi: float = 0.0
    oi_agree: bool = True
    trend_agree: bool = True
    volume_anomaly: bool = False
    conflicting: bool = False
    penalty: float = 0.0
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MarketMetaState:
    market_cap: float = 0.0
    rank: int = 0
    volume_24h: float = 0.0
    dominance: float = 0.0
    circulating_supply: float = 0.0
    available: bool = False


@dataclass(slots=True)
class NewsIntelligenceState:
    headlines: list[str] = field(default_factory=list)
    high_impact: bool = False
    volatility_risk: bool = False
    suppress_alerts: bool = False
    confidence_penalty: float = 0.0
    categories: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RiskPlan:
    entry: float
    stop_loss: float
    tp1: float
    tp2: float
    tp3: float
    final_target: float
    risk_reward: float
    position_size: float
    risk_amount: float
    trailing_after_tp1: bool


@dataclass(slots=True)
class FactorContribution:
    key: str
    label: str
    score: float
    weight: float
    weighted: float
    polarity: str  # positive | neutral | negative
    explanation: str


@dataclass(slots=True)
class ConfidenceBreakdown:
    scores: dict[str, float]
    total: float
    weights: dict[str, float]
    level: ConfidenceLevel = ConfidenceLevel.BELOW_THRESHOLD
    factors: list[FactorContribution] = field(default_factory=list)
    positive: list[str] = field(default_factory=list)
    negative: list[str] = field(default_factory=list)
    summary: str = ""


@dataclass(slots=True)
class Signal:
    symbol: str
    side: Side
    trend: Trend
    confidence: float
    confidence_breakdown: ConfidenceBreakdown
    confidence_level: ConfidenceLevel
    entry: float
    stop_loss: float
    tp1: float
    tp2: float
    tp3: float
    final_target: float
    risk_reward: float
    risk_level: RiskLevel
    reason: str
    commentary: str
    invalidation: str
    status: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AnalysisBundle:
    symbol: str
    ticker: TickerSnapshot
    higher_tf_trend: Trend
    execution_tf: str
    ema: EMAState
    structure: StructureState
    smc_zones: list[SMCZone]
    liquidity: LiquidityState
    order_flow: OrderFlowState
    open_interest: OpenInterestState
    funding: FundingState
    volume: VolumeState
    volatility: VolatilityState
    price: float
    candles_exec: list[Candle]
    liquidation: LiquidationHeatmapState = field(default_factory=LiquidationHeatmapState)
    cross_exchange: CrossExchangeState = field(default_factory=CrossExchangeState)
    market_meta: MarketMetaState = field(default_factory=MarketMetaState)
    news: NewsIntelligenceState = field(default_factory=NewsIntelligenceState)
    rejects: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DecisionLog:
    symbol: str
    accepted: bool
    side: str | None
    confidence: float | None
    reasons: list[str]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    details: dict[str, Any] = field(default_factory=dict)
