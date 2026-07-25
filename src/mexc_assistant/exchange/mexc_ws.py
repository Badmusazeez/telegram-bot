"""MEXC Futures WebSocket market-data streams."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Any

import orjson
import websockets
from websockets.asyncio.client import ClientConnection

from mexc_assistant.core.config import ExchangeConfig
from mexc_assistant.core.logging import get_logger
from mexc_assistant.core.models import TickerSnapshot, TradeTick

log = get_logger(__name__)


class MexcWebSocketClient:
    """Realtime trades / tickers / funding via wss://contract.mexc.com/edge."""

    def __init__(self, config: ExchangeConfig) -> None:
        self.config = config
        self._ws: ClientConnection | None = None
        self._running = False
        self._queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=5000)
        self._task: asyncio.Task[None] | None = None
        self._symbols: list[str] = []

    async def connect(self, symbols: list[str]) -> None:
        self._symbols = symbols
        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name="mexc-ws-loop")

    async def _run_loop(self) -> None:
        backoff = 1.0
        while self._running:
            try:
                async with websockets.connect(
                    self.config.ws_url,
                    ping_interval=15,
                    ping_timeout=20,
                    max_size=8 * 1024 * 1024,
                ) as ws:
                    self._ws = ws
                    await self._subscribe(ws)
                    backoff = 1.0
                    log.info("mexc_ws_connected", symbols=self._symbols)
                    async for raw in ws:
                        if not self._running:
                            break
                        await self._handle_message(raw)
            except Exception as exc:  # noqa: BLE001
                log.warning("mexc_ws_disconnected", error=str(exc), backoff=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _subscribe(self, ws: ClientConnection) -> None:
        # Prefer plaintext JSON for simpler parsing in this service.
        await ws.send(orjson.dumps({"method": "sub.tickers", "param": {}, "gzip": False}).decode())
        for symbol in self._symbols:
            for method in ("sub.deal", "sub.funding.rate", "sub.ticker"):
                msg = {"method": method, "param": {"symbol": symbol}, "gzip": False}
                await ws.send(orjson.dumps(msg).decode())
                await asyncio.sleep(0.02)

    async def _handle_message(self, raw: str | bytes) -> None:
        try:
            if isinstance(raw, bytes):
                payload = orjson.loads(raw)
            else:
                payload = orjson.loads(raw.encode() if isinstance(raw, str) else raw)
        except Exception:  # noqa: BLE001
            return

        channel = payload.get("channel", "")
        if channel == "pong" or payload.get("method") == "pong":
            return
        if channel.startswith("rs.") or channel.startswith("rd."):
            return
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
            self._queue.put_nowait(payload)

    async def messages(self) -> AsyncIterator[dict[str, Any]]:
        while self._running:
            item = await self._queue.get()
            yield item

    async def stream_trades(self, symbols: list[str]) -> AsyncIterator[tuple[str, TradeTick]]:
        wanted = set(symbols)
        async for payload in self.messages():
            if payload.get("channel") != "push.deal":
                continue
            symbol = payload.get("symbol") or payload.get("data", {}).get("symbol")
            if symbol not in wanted:
                continue
            data = payload.get("data")
            rows = data if isinstance(data, list) else [data]
            for row in rows:
                if not row:
                    continue
                yield symbol, TradeTick(
                    price=float(row["p"]),
                    quantity=float(row["v"]),
                    side=int(row["T"]),
                    timestamp=int(row.get("t") or row.get("cts") or 0),
                )

    async def stream_tickers(self, symbols: list[str]) -> AsyncIterator[TickerSnapshot]:
        wanted = set(symbols)
        async for payload in self.messages():
            channel = payload.get("channel")
            if channel == "push.ticker":
                data = payload.get("data") or {}
                symbol = data.get("symbol") or payload.get("symbol")
                if symbol not in wanted:
                    continue
                yield self._ticker_from_dict(symbol, data)
            elif channel == "push.tickers":
                for item in payload.get("data") or []:
                    symbol = item.get("symbol")
                    if symbol in wanted:
                        yield self._ticker_from_dict(symbol, item)

    @staticmethod
    def _ticker_from_dict(symbol: str, data: dict[str, Any]) -> TickerSnapshot:
        last = float(data.get("lastPrice") or data.get("fairPrice") or 0.0)
        return TickerSnapshot(
            symbol=symbol,
            last_price=last,
            bid=float(data.get("bid1") or data.get("maxBidPrice") or last),
            ask=float(data.get("ask1") or data.get("minAskPrice") or last),
            volume24=float(data.get("volume24") or 0.0),
            hold_vol=float(data.get("holdVol") or 0.0),
            funding_rate=float(data.get("fundingRate") or 0.0),
            fair_price=float(data.get("fairPrice") or last),
            index_price=float(data.get("indexPrice") or last),
            timestamp=int(data.get("timestamp") or 0),
        )

    async def send_ping(self) -> None:
        if self._ws is not None:
            await self._ws.send(orjson.dumps({"method": "ping"}).decode())

    async def close(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self._ws is not None:
            await self._ws.close()
            self._ws = None


class TradeBuffer:
    """In-memory rolling trade buffer fed by WebSocket or REST fallback."""

    def __init__(self, maxlen: int = 500) -> None:
        self.maxlen = maxlen
        self._data: dict[str, list[TradeTick]] = {}

    def add(self, symbol: str, trade: TradeTick) -> None:
        bucket = self._data.setdefault(symbol, [])
        bucket.append(trade)
        if len(bucket) > self.maxlen:
            del bucket[: len(bucket) - self.maxlen]

    def get(self, symbol: str, limit: int = 200) -> list[TradeTick]:
        return list(self._data.get(symbol, [])[-limit:])

    def seed(self, symbol: str, trades: list[TradeTick]) -> None:
        self._data[symbol] = trades[-self.maxlen :]
