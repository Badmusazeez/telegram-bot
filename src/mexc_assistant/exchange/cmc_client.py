"""CoinMarketCap market metadata + news (pro API with public fallback)."""

from __future__ import annotations

import time
from typing import Any

import aiohttp

from mexc_assistant.core.config import DataSourcesConfig
from mexc_assistant.core.logging import get_logger
from mexc_assistant.core.models import MarketMetaState

log = get_logger(__name__)


def symbol_to_base(symbol: str) -> str:
    s = symbol.replace("-", "_").upper()
    if s.endswith("_USDT"):
        return s[:-5]
    if s.endswith("USDT"):
        return s[:-4]
    return s.split("_")[0]


class CoinMarketCapClient:
    def __init__(
        self,
        config: DataSourcesConfig,
        api_key: str = "",
        session: aiohttp.ClientSession | None = None,
    ) -> None:
        self.config = config
        self.api_key = api_key
        self._session = session
        self._owns_session = session is None
        self._meta_cache: dict[str, tuple[float, MarketMetaState]] = {}
        self._news_cache: tuple[float, list[dict[str, Any]]] | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
            self._owns_session = True
        return self._session

    async def get_market_meta(self, symbol: str) -> MarketMetaState:
        base = symbol_to_base(symbol)
        cached = self._meta_cache.get(base)
        now = time.time()
        if cached and now - cached[0] < 300:
            return cached[1]

        meta = MarketMetaState()
        if self.api_key:
            meta = await self._pro_quote(base)
        if not meta.available:
            meta = await self._public_listing(base)
        self._meta_cache[base] = (now, meta)
        return meta

    async def _pro_quote(self, base: str) -> MarketMetaState:
        session = await self._get_session()
        url = f"{self.config.cmc_pro_base_url.rstrip('/')}/v1/cryptocurrency/quotes/latest"
        headers = {"X-CMC_PRO_API_KEY": self.api_key}
        try:
            async with session.get(url, params={"symbol": base, "convert": "USD"}, headers=headers) as resp:
                if resp.status >= 400:
                    log.warning("cmc_pro_quote_failed", status=resp.status)
                    return MarketMetaState()
                payload = await resp.json(content_type=None)
            item = (payload.get("data") or {}).get(base) or {}
            if isinstance(item, list):
                item = item[0] if item else {}
            quote = (item.get("quote") or {}).get("USD") or {}
            return MarketMetaState(
                market_cap=float(quote.get("market_cap") or 0.0),
                rank=int(item.get("cmc_rank") or 0),
                volume_24h=float(quote.get("volume_24h") or 0.0),
                dominance=float(quote.get("market_cap_dominance") or 0.0),
                circulating_supply=float(item.get("circulating_supply") or 0.0),
                available=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("cmc_pro_error", error=str(exc))
            return MarketMetaState()

    async def _public_listing(self, base: str) -> MarketMetaState:
        session = await self._get_session()
        url = (
            f"{self.config.cmc_public_base_url.rstrip('/')}"
            "/data-api/v3/cryptocurrency/listing"
        )
        try:
            async with session.get(url, params={"start": 1, "limit": 200, "sortBy": "market_cap"}) as resp:
                if resp.status >= 400:
                    return MarketMetaState()
                payload = await resp.json(content_type=None)
            rows = ((payload.get("data") or {}).get("cryptoCurrencyList")) or []
            for row in rows:
                if str(row.get("symbol", "")).upper() != base:
                    continue
                quotes = row.get("quotes") or []
                usd = next((q for q in quotes if q.get("name") == "USD"), quotes[0] if quotes else {})
                return MarketMetaState(
                    market_cap=float(usd.get("marketCap") or 0.0),
                    rank=int(row.get("cmcRank") or 0),
                    volume_24h=float(usd.get("volume24h") or 0.0),
                    dominance=float(usd.get("dominance") or 0.0),
                    circulating_supply=float(row.get("circulatingSupply") or 0.0),
                    available=True,
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("cmc_public_listing_error", error=str(exc))
        return MarketMetaState()

    async def get_news(self, limit: int = 30) -> list[dict[str, Any]]:
        now = time.time()
        if self._news_cache and now - self._news_cache[0] < 180:
            return self._news_cache[1][:limit]

        session = await self._get_session()
        items: list[dict[str, Any]] = []

        # Public CMC news feed (no key)
        url = f"{self.config.cmc_public_base_url.rstrip('/')}/data-api/v3/headlines/latest"
        try:
            async with session.get(url, params={"limit": str(limit)}) as resp:
                if resp.status < 400:
                    payload = await resp.json(content_type=None)
                    for row in (payload.get("data") or [])[:limit]:
                        items.append(
                            {
                                "title": row.get("title") or row.get("meta", {}).get("title") or "",
                                "source": row.get("sourceName") or "CoinMarketCap",
                                "url": row.get("url") or "",
                                "created_at": row.get("createdAt") or row.get("releasedAt") or "",
                                "cover": row.get("cover") or "",
                            }
                        )
        except Exception as exc:  # noqa: BLE001
            log.warning("cmc_news_failed", error=str(exc))

        # Optional pro news endpoint
        if self.api_key and len(items) < 5:
            pro_url = f"{self.config.cmc_pro_base_url.rstrip('/')}/v1/content/latest"
            headers = {"X-CMC_PRO_API_KEY": self.api_key}
            try:
                async with session.get(pro_url, params={"limit": limit}, headers=headers) as resp:
                    if resp.status < 400:
                        payload = await resp.json(content_type=None)
                        for row in (payload.get("data") or [])[:limit]:
                            items.append(
                                {
                                    "title": row.get("title") or "",
                                    "source": row.get("source_name") or "CMC Pro",
                                    "url": row.get("url") or "",
                                    "created_at": row.get("published_at") or "",
                                }
                            )
            except Exception as exc:  # noqa: BLE001
                log.warning("cmc_pro_news_failed", error=str(exc))

        self._news_cache = (now, items)
        return items[:limit]

    async def close(self) -> None:
        if self._owns_session and self._session and not self._session.closed:
            await self._session.close()
