"""Exchange adapter interface — future exchanges plug in here."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any

from mexc_assistant.core.models import Candle, TickerSnapshot, TradeTick


class ExchangeClient(ABC):
    """Abstract market-data client.

    Implementations must provide REST candles/tickers and optional WebSocket streams.
    """

    @abstractmethod
    async def get_klines(self, symbol: str, interval: str, limit: int = 300) -> list[Candle]:
        raise NotImplementedError

    @abstractmethod
    async def get_ticker(self, symbol: str) -> TickerSnapshot:
        raise NotImplementedError

    @abstractmethod
    async def get_funding_rate(self, symbol: str) -> float:
        raise NotImplementedError

    @abstractmethod
    async def get_recent_deals(self, symbol: str, limit: int = 100) -> list[TradeTick]:
        raise NotImplementedError

    @abstractmethod
    async def get_depth(self, symbol: str, limit: int = 20) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def stream_trades(self, symbols: list[str]) -> AsyncIterator[tuple[str, TradeTick]]:
        raise NotImplementedError

    @abstractmethod
    def stream_tickers(self, symbols: list[str]) -> AsyncIterator[TickerSnapshot]:
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        raise NotImplementedError
