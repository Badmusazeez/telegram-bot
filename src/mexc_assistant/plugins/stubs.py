"""Stubs documenting future plugin hooks (disabled by default)."""

from __future__ import annotations

from typing import Any

from mexc_assistant.core.models import AnalysisBundle
from mexc_assistant.plugins.base import Plugin


class WhaleWalletPlugin(Plugin):
    name = "whale_wallets"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented", "symbol": bundle.symbol}


class TokenUnlockPlugin(Plugin):
    name = "token_unlocks"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented"}


class EconomicCalendarPlugin(Plugin):
    name = "economic_calendar"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented"}


class NewsSentimentPlugin(Plugin):
    name = "news_sentiment"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented"}


class StablecoinFlowPlugin(Plugin):
    name = "stablecoin_flows"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented"}


class OnChainAnalyticsPlugin(Plugin):
    name = "onchain_analytics"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented", "hint": "wallet/tx monitoring hook"}


class ExchangeReservePlugin(Plugin):
    name = "exchange_reserves"

    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        return {"status": "not_implemented"}


PLUGIN_TYPES: dict[str, type[Plugin]] = {
    "whale_wallets": WhaleWalletPlugin,
    "token_unlocks": TokenUnlockPlugin,
    "economic_calendar": EconomicCalendarPlugin,
    "news_sentiment": NewsSentimentPlugin,
    "stablecoin_flows": StablecoinFlowPlugin,
    "onchain_analytics": OnChainAnalyticsPlugin,
    "exchange_reserves": ExchangeReservePlugin,
}
