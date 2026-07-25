import pytest

from mexc_assistant.analysis.cross_exchange import validate_cross_exchange
from mexc_assistant.analysis.news_intelligence import NewsIntelligence
from mexc_assistant.core.config import CrossExchangeConfig, DataSourcesConfig
from mexc_assistant.core.models import OpenInterestState, TickerSnapshot, Trend
from mexc_assistant.exchange.cmc_client import CoinMarketCapClient, symbol_to_base
from mexc_assistant.exchange.okx_rest import to_okx_inst_id


def test_symbol_maps():
    assert to_okx_inst_id("BTC_USDT") == "BTC-USDT-SWAP"
    assert symbol_to_base("ETH_USDT") == "ETH"


@pytest.mark.asyncio
async def test_cross_exchange_live_okx():
    from mexc_assistant.exchange.okx_rest import OkxRestClient

    okx = OkxRestClient(DataSourcesConfig())
    try:
        ticker = TickerSnapshot(
            symbol="BTC_USDT",
            last_price=64000,
            bid=63999,
            ask=64001,
            volume24=1e6,
            hold_vol=1e7,
            funding_rate=0.00001,
            fair_price=64000,
            index_price=64000,
            timestamp=1,
        )
        oi = OpenInterestState(
            current=1e7,
            previous=1e7,
            change_pct=0.0,
            rising=False,
            sharp_decline=False,
            confirms_long=False,
            confirms_short=False,
        )
        state = await validate_cross_exchange(
            "BTC_USDT",
            ticker,
            oi,
            Trend.BULLISH,
            okx,
            CrossExchangeConfig(),
        )
        assert state.okx_price > 0
        assert isinstance(state.notes, list)
        assert state.notes
    finally:
        await okx.close()


@pytest.mark.asyncio
async def test_cmc_public_meta_and_news():
    cmc = CoinMarketCapClient(DataSourcesConfig())
    news = NewsIntelligence(cmc, DataSourcesConfig())
    try:
        meta = await cmc.get_market_meta("BTC_USDT")
        assert meta.available
        assert meta.rank > 0 or meta.market_cap > 0
        state = await news.assess("BTC_USDT")
        assert state.notes
    finally:
        await cmc.close()
