"""OKX public REST client for cross-exchange validation."""

from __future__ import annotations

from typing import Any

import aiohttp
from tenacity import retry, stop_after_attempt, wait_exponential

from mexc_assistant.core.config import DataSourcesConfig
from mexc_assistant.core.logging import get_logger
from mexc_assistant.core.models import Candle, Trend

log = get_logger(__name__)


def to_okx_inst_id(symbol: str) -> str:
    """BTC_USDT -> BTC-USDT-SWAP"""
    base = symbol.replace("-", "_").upper()
    if base.endswith("_USDT"):
        return f"{base[:-5]}-USDT-SWAP"
    if base.endswith("USDT") and "_" not in base:
        return f"{base[:-4]}-USDT-SWAP"
    return f"{base.replace('_', '-')}-SWAP"


class OkxRestClient:
    def __init__(
        self,
        config: DataSourcesConfig,
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        self.config = config
        self._session = session
        self._owns_session = session is None
        self._oi_cache: dict[str, float] = {}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
            self._owns_session = True
        return self._session

    @retry(stop=stop_after_attempt(4), wait=wait_exponential(multiplier=1.2, min=1, max=12), reraise=True)
    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        session = await self._get_session()
        url = f"{self.config.okx_base_url.rstrip('/')}/{path.lstrip('/')}"
        async with session.get(url, params=params) as resp:
            resp.raise_for_status()
            payload = await resp.json(content_type=None)
        if str(payload.get("code", "0")) != "0":
            raise RuntimeError(f"OKX API error on {path}: {payload}")
        return payload.get("data", [])

    async def get_ticker(self, symbol: str) -> dict[str, Any]:
        inst = to_okx_inst_id(symbol)
        data = await self._get("/api/v5/market/ticker", {"instId": inst})
        if not data:
            raise RuntimeError(f"OKX ticker missing for {inst}")
        return data[0]

    async def get_funding_rate(self, symbol: str) -> float:
        inst = to_okx_inst_id(symbol)
        data = await self._get("/api/v5/public/funding-rate", {"instId": inst})
        if not data:
            return 0.0
        return float(data[0].get("fundingRate") or 0.0)

    async def get_open_interest(self, symbol: str) -> float:
        inst = to_okx_inst_id(symbol)
        data = await self._get("/api/v5/public/open-interest", {"instId": inst})
        if not data:
            return 0.0
        oi = float(data[0].get("oiUsd") or data[0].get("oi") or 0.0)
        self._oi_cache[symbol] = oi
        return oi

    async def get_klines(self, symbol: str, bar: str = "1H", limit: int = 100) -> list[Candle]:
        inst = to_okx_inst_id(symbol)
        data = await self._get(
            "/api/v5/market/candles",
            {"instId": inst, "bar": bar, "limit": str(limit)},
        )
        # OKX returns newest first: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        candles: list[Candle] = []
        for row in reversed(data or []):
            candles.append(
                Candle(
                    time=int(int(row[0]) / 1000),
                    open=float(row[1]),
                    high=float(row[2]),
                    low=float(row[3]),
                    close=float(row[4]),
                    volume=float(row[5]),
                    amount=float(row[7]) if len(row) > 7 else 0.0,
                )
            )
        return candles

    async def get_liquidations(self, symbol: str, limit: int = 20) -> list[dict[str, Any]]:
        uly = to_okx_inst_id(symbol).replace("-SWAP", "")
        try:
            data = await self._get(
                "/api/v5/public/liquidation-orders",
                {
                    "instType": "SWAP",
                    "uly": uly,
                    "state": "filled",
                    "limit": str(limit),
                },
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("okx_liquidations_failed", symbol=symbol, error=str(exc))
            return []
        details: list[dict[str, Any]] = []
        for block in data or []:
            for item in block.get("details") or []:
                details.append(item)
        return details

    def previous_oi(self, symbol: str) -> float | None:
        return self._oi_cache.get(symbol)

    @staticmethod
    def simple_trend(candles: list[Candle]) -> Trend:
        if len(candles) < 20:
            return Trend.NEUTRAL
        closes = [c.close for c in candles]
        first = sum(closes[:5]) / 5
        last = sum(closes[-5:]) / 5
        change = (last - first) / max(first, 1e-12)
        if change > 0.003:
            return Trend.BULLISH
        if change < -0.003:
            return Trend.BEARISH
        return Trend.NEUTRAL

    async def close(self) -> None:
        if self._owns_session and self._session and not self._session.closed:
            await self._session.close()
