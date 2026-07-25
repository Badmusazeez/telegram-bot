"""Multi-timeframe analysis pipeline for a single symbol."""

from __future__ import annotations

from mexc_assistant.analysis.cross_exchange import validate_cross_exchange
from mexc_assistant.analysis.ema import analyze_ema
from mexc_assistant.analysis.funding import analyze_funding
from mexc_assistant.analysis.liquidations import build_liquidation_state
from mexc_assistant.analysis.liquidity import analyze_liquidity
from mexc_assistant.analysis.news_intelligence import NewsIntelligence
from mexc_assistant.analysis.open_interest import OpenInterestTracker
from mexc_assistant.analysis.order_flow import analyze_order_flow
from mexc_assistant.analysis.smc import analyze_smc, premium_discount, price_in_zone
from mexc_assistant.analysis.structure import analyze_structure
from mexc_assistant.analysis.volatility import analyze_volatility
from mexc_assistant.analysis.volume import analyze_volume
from mexc_assistant.core.config import Settings
from mexc_assistant.core.models import (
    AnalysisBundle,
    Side,
    TradeTick,
    Trend,
)
from mexc_assistant.exchange.cmc_client import CoinMarketCapClient
from mexc_assistant.exchange.mexc_rest import MexcRestClient
from mexc_assistant.exchange.okx_rest import OkxRestClient


class AnalysisPipeline:
    def __init__(
        self,
        settings: Settings,
        rest: MexcRestClient,
        okx: OkxRestClient | None = None,
        cmc: CoinMarketCapClient | None = None,
        news: NewsIntelligence | None = None,
    ) -> None:
        self.settings = settings
        self.rest = rest
        self.okx = okx
        self.cmc = cmc
        self.news = news
        self.oi_tracker = OpenInterestTracker()
        self._price_cache: dict[str, float] = {}

    async def analyze(
        self,
        symbol: str,
        trades: list[TradeTick] | None = None,
    ) -> AnalysisBundle:
        s = self.settings
        rejects: list[str] = []

        daily = await self.rest.get_klines(symbol, "Day1", limit=120)
        h4 = await self.rest.get_klines(symbol, "Hour4", limit=200)
        h1 = await self.rest.get_klines(symbol, "Min60", limit=250)
        m15 = await self.rest.get_klines(symbol, "Min15", limit=300)
        m5 = await self.rest.get_klines(symbol, "Min5", limit=300)
        ticker = await self.rest.get_ticker(symbol)
        funding_rate = ticker.funding_rate
        depth: dict = {}
        try:
            depth = await self.rest.get_depth(symbol, limit=20)
        except Exception:  # noqa: BLE001
            depth = {}

        if trades is None:
            trades = await self.rest.get_recent_deals(symbol, limit=s.order_flow.trade_window)

        ht_structs = [
            analyze_structure(daily, s.structure),
            analyze_structure(h4, s.structure),
            analyze_structure(h1, s.structure),
        ]
        bullish_votes = sum(1 for st in ht_structs if st.trend == Trend.BULLISH)
        bearish_votes = sum(1 for st in ht_structs if st.trend == Trend.BEARISH)
        if bullish_votes >= 2:
            higher_trend = Trend.BULLISH
        elif bearish_votes >= 2:
            higher_trend = Trend.BEARISH
        else:
            higher_trend = Trend.NEUTRAL
            rejects.append("Higher-timeframe bias is mixed/neutral")

        ema_h1 = analyze_ema(h1, s.ema)
        ema_m15 = analyze_ema(m15, s.ema)
        if ema_h1.flat_or_intertwined:
            rejects.append("HTF EMAs flat or intertwined")

        exec_tf = "Min15"
        exec_candles = m15
        structure = analyze_structure(m15, s.structure)
        structure_m5 = analyze_structure(m5, s.structure)
        if structure.trend == Trend.NEUTRAL and structure_m5.trend != Trend.NEUTRAL:
            structure = structure_m5
            exec_tf = "Min5"
            exec_candles = m5

        smc_zones = analyze_smc(exec_candles, s.smc)
        liquidity = analyze_liquidity(exec_candles, daily, s.structure)
        order_flow = analyze_order_flow(trades, exec_candles, s.order_flow)
        volume = analyze_volume(exec_candles, s.volume)
        volatility = analyze_volatility(exec_candles, s.volatility)

        prev_price = self._price_cache.get(symbol, ticker.last_price)
        price_up = ticker.last_price >= prev_price
        self._price_cache[symbol] = ticker.last_price
        oi = self.oi_tracker.update(symbol, ticker.hold_vol, price_up, s.open_interest)
        funding = analyze_funding(funding_rate, s.funding)

        okx_liqs: list[dict] = []
        if self.okx is not None:
            try:
                okx_liqs = await self.okx.get_liquidations(symbol, limit=20)
            except Exception:  # noqa: BLE001
                okx_liqs = []

        liquidation = build_liquidation_state(
            depth=depth,
            liquidity=liquidity,
            mid=ticker.last_price,
            okx_liqs=okx_liqs,
            side=None,
        )

        cross = (
            await validate_cross_exchange(
                symbol=symbol,
                mexc_ticker=ticker,
                mexc_oi=oi,
                mexc_trend=higher_trend,
                okx=self.okx,
                config=s.cross_exchange,
            )
            if self.okx is not None
            else None
        )
        if cross is None:
            from mexc_assistant.core.models import CrossExchangeState

            cross = CrossExchangeState(notes=["OKX client not configured"])
        if cross.conflicting and s.cross_exchange.reject_on_conflict:
            rejects.append("Cross-exchange conflict: " + "; ".join(cross.notes[:2]))

        market_meta = (
            await self.cmc.get_market_meta(symbol)
            if self.cmc is not None
            else None
        )
        if market_meta is None:
            from mexc_assistant.core.models import MarketMetaState

            market_meta = MarketMetaState()

        news_state = (
            await self.news.assess(symbol)
            if self.news is not None
            else None
        )
        if news_state is None:
            from mexc_assistant.core.models import NewsIntelligenceState

            news_state = NewsIntelligenceState()
        if news_state.suppress_alerts:
            rejects.append("News volatility suppression active")
        elif news_state.high_impact:
            rejects.append("High-impact news elevates risk")

        _, _, zone_label = premium_discount(exec_candles)
        if higher_trend == Trend.BULLISH and zone_label == "premium":
            rejects.append("Bullish bias but price in premium zone")
        if higher_trend == Trend.BEARISH and zone_label == "discount":
            rejects.append("Bearish bias but price in discount zone")

        in_bullish_zone = any(
            z.side == Side.BUY and price_in_zone(ticker.last_price, z, s.smc.zone_touch_tolerance_pct)
            for z in smc_zones
            if z.kind in {"order_block", "fvg", "mitigation_block", "breaker"}
        )
        in_bearish_zone = any(
            z.side == Side.SELL and price_in_zone(ticker.last_price, z, s.smc.zone_touch_tolerance_pct)
            for z in smc_zones
            if z.kind in {"order_block", "fvg", "mitigation_block", "breaker"}
        )
        if not in_bullish_zone and not in_bearish_zone:
            rejects.append("Price not revisiting a valid institutional zone")

        if not volatility.sufficient:
            rejects.append("ATR volatility too low")
        if not volume.above_average:
            rejects.append("Volume below average")
        if oi.sharp_decline:
            rejects.append("Open interest declining sharply")

        ema = ema_h1
        if ema_h1.aligned_long and not ema_m15.price_above_ema20:
            rejects.append("Price not holding above EMA20 on execution TF")
        if ema_h1.aligned_short and not ema_m15.price_below_ema20:
            rejects.append("Price not holding below EMA20 on execution TF")

        return AnalysisBundle(
            symbol=symbol,
            ticker=ticker,
            higher_tf_trend=higher_trend,
            execution_tf=exec_tf,
            ema=ema,
            structure=structure,
            smc_zones=smc_zones,
            liquidity=liquidity,
            order_flow=order_flow,
            open_interest=oi,
            funding=funding,
            volume=volume,
            volatility=volatility,
            price=ticker.last_price,
            candles_exec=exec_candles,
            liquidation=liquidation,
            cross_exchange=cross,
            market_meta=market_meta,
            news=news_state,
            rejects=rejects,
        )
