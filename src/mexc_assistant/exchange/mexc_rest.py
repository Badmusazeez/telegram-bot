"""MEXC USDT-M Futures REST client."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
from tenacity import retry, stop_after_attempt, wait_exponential

from mexc_assistant.core.config import ExchangeConfig
from mexc_assistant.core.logging import get_logger
from mexc_assistant.core.models import Candle, TickerSnapshot, TradeTick

log = get_logger(__name__)


class MexcRestClient:
    def __init__(self, config: ExchangeConfig, session: aiohttp.ClientSession | None = None) -> None:
        self.config = config
        self._session = session
        self._owns_session = session is None
        self._oi_cache: dict[str, float] = {}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=self.config.request_timeout_seconds)
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._owns_session = True
        return self._session

    @retry(
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=1.5, min=1, max=20),
        reraise=True,
    )
    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        session = await self._get_session()
        url = f"{self.config.rest_base_url.rstrip('/')}/{path.lstrip('/')}"
        async with session.get(url, params=params) as resp:
            resp.raise_for_status()
            payload = await resp.json(content_type=None)
        if not payload.get("success", True) and payload.get("code", 0) != 0:
            raise RuntimeError(f"MEXC API error on {path}: {payload}")
        return payload.get("data", payload)

    async def get_klines(self, symbol: str, interval: str, limit: int = 300) -> list[Candle]:
        data = await self._get(f"/api/v1/contract/kline/{symbol}", {"interval": interval})
        times = data.get("time", [])
        opens = data.get("open", [])
        highs = data.get("high", [])
        lows = data.get("low", [])
        closes = data.get("close", [])
        vols = data.get("vol", [])
        amounts = data.get("amount", [0.0] * len(times))

        candles = [
            Candle(
                time=int(times[i]),
                open=float(opens[i]),
                high=float(highs[i]),
                low=float(lows[i]),
                close=float(closes[i]),
                volume=float(vols[i]),
                amount=float(amounts[i]) if i < len(amounts) else 0.0,
            )
            for i in range(len(times))
        ]
        if limit and len(candles) > limit:
            candles = candles[-limit:]
        return candles

    async def get_ticker(self, symbol: str) -> TickerSnapshot:
        data = await self._get("/api/v1/contract/ticker", {"symbol": symbol})
        if isinstance(data, list):
            match = next((item for item in data if item.get("symbol") == symbol), None)
            if match is None:
                raise RuntimeError(f"Ticker not found for {symbol}")
            data = match

        hold_vol = float(data.get("holdVol", 0.0))
        self._oi_cache[symbol] = hold_vol
        return TickerSnapshot(
            symbol=symbol,
            last_price=float(data["lastPrice"]),
            bid=float(data.get("bid1", data["lastPrice"])),
            ask=float(data.get("ask1", data["lastPrice"])),
            volume24=float(data.get("volume24", 0.0)),
            hold_vol=hold_vol,
            funding_rate=float(data.get("fundingRate", 0.0)),
            fair_price=float(data.get("fairPrice", data["lastPrice"])),
            index_price=float(data.get("indexPrice", data["lastPrice"])),
            timestamp=int(data.get("timestamp", 0)),
        )

    async def get_funding_rate(self, symbol: str) -> float:
        data = await self._get(f"/api/v1/contract/funding_rate/{symbol}")
        if isinstance(data, list):
            match = next((item for item in data if item.get("symbol") == symbol), data[0])
            return float(match["fundingRate"])
        return float(data["fundingRate"])

    async def get_recent_deals(self, symbol: str, limit: int = 100) -> list[TradeTick]:
        data = await self._get(f"/api/v1/contract/deals/{symbol}", {"limit": limit})
        trades: list[TradeTick] = []
        for item in data or []:
            trades.append(
                TradeTick(
                    price=float(item["p"]),
                    quantity=float(item["v"]),
                    side=int(item["T"]),
                    timestamp=int(item["t"]),
                )
            )
        return trades

    async def get_depth(self, symbol: str, limit: int = 20) -> dict[str, Any]:
        return await self._get(f"/api/v1/contract/depth/{symbol}", {"limit": limit})

    def previous_open_interest(self, symbol: str) -> float | None:
        return self._oi_cache.get(symbol)

    async def ping(self) -> bool:
        try:
            await self._get("/api/v1/contract/ping")
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("mexc_ping_failed", error=str(exc))
            return False

    async def close(self) -> None:
        if self._owns_session and self._session and not self._session.closed:
            await self._session.close()
            await asyncio.sleep(0.05)
