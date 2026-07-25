"""Continuous scan orchestrator."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone

from mexc_assistant.alerts.telegram import TelegramAlerter
from mexc_assistant.analysis.news_intelligence import NewsIntelligence
from mexc_assistant.analysis.pipeline import AnalysisPipeline
from mexc_assistant.core.config import Settings, get_env
from mexc_assistant.core.decision_log import DecisionLogger
from mexc_assistant.core.health import HealthServer, HealthState
from mexc_assistant.core.logging import get_logger
from mexc_assistant.exchange.cmc_client import CoinMarketCapClient
from mexc_assistant.exchange.mexc_rest import MexcRestClient
from mexc_assistant.exchange.mexc_ws import MexcWebSocketClient, TradeBuffer
from mexc_assistant.exchange.okx_rest import OkxRestClient
from mexc_assistant.plugins.base import PluginRegistry
from mexc_assistant.plugins.stubs import PLUGIN_TYPES
from mexc_assistant.risk.manager import RiskManager
from mexc_assistant.signals.engine import SignalEngine

log = get_logger(__name__)


class TradingAssistant:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.env = get_env(settings)
        self.rest = MexcRestClient(settings.exchange)
        self.okx = OkxRestClient(settings.data_sources)
        self.cmc = CoinMarketCapClient(settings.data_sources, api_key=self.env.cmc_api_key)
        self.news = NewsIntelligence(self.cmc, settings.data_sources)
        self.ws = MexcWebSocketClient(settings.exchange)
        self.trades = TradeBuffer(maxlen=settings.order_flow.trade_window * 3)
        self.pipeline = AnalysisPipeline(
            settings,
            self.rest,
            okx=self.okx,
            cmc=self.cmc,
            news=self.news,
        )
        self.risk = RiskManager(settings)
        self.engine = SignalEngine(settings, self.risk)
        self.decisions = DecisionLogger(settings.logging.decision_log_path)
        self.alerter = TelegramAlerter(
            token=self.env.telegram_bot_token,
            chat_id=self.env.telegram_chat_id,
            config=settings.alerts,
            dry_run=settings.app.dry_run or not self.env.telegram_bot_token,
        )
        self.health_state = HealthState(symbols=list(settings.symbols))
        self.health = HealthServer(self.health_state, port=settings.app.health_port)
        self.plugins = PluginRegistry()
        for name in settings.plugins.enabled:
            cls = PLUGIN_TYPES.get(name)
            if cls:
                self.plugins.register(cls())
        self._tasks: list[asyncio.Task[None]] = []
        self._stop = asyncio.Event()

    async def start(self) -> None:
        log.info(
            "assistant_starting",
            symbols=self.settings.symbols,
            dry_run=self.alerter.dry_run,
        )
        await self.plugins.setup_all()
        self.health.start()

        # Seed trade buffers via REST
        for symbol in self.settings.symbols:
            try:
                deals = await self.rest.get_recent_deals(symbol, limit=self.settings.order_flow.trade_window)
                self.trades.seed(symbol, deals)
            except Exception as exc:  # noqa: BLE001
                log.warning("seed_trades_failed", symbol=symbol, error=str(exc))

        await self.ws.connect(self.settings.symbols)
        self._tasks.append(asyncio.create_task(self._consume_ws_trades(), name="ws-trades"))
        self._tasks.append(asyncio.create_task(self._scan_loop(), name="scan-loop"))
        await self.alerter.send_text(
            f"MEXC AI Trading Assistant online. Monitoring: {', '.join(self.settings.symbols)}"
        )
        await self._stop.wait()

    async def _consume_ws_trades(self) -> None:
        try:
            async for symbol, trade in self.ws.stream_trades(self.settings.symbols):
                self.trades.add(symbol, trade)
                if self._stop.is_set():
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("ws_trade_consumer_error", error=str(exc))
            self.health_state.last_error = str(exc)

    async def _scan_loop(self) -> None:
        interval = self.settings.app.scan_interval_seconds
        while not self._stop.is_set():
            try:
                await self._scan_once()
                self.health_state.healthy = True
            except Exception as exc:  # noqa: BLE001
                self.health_state.healthy = False
                self.health_state.last_error = str(exc)
                log.exception("scan_failed", error=str(exc))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=interval)
            except TimeoutError:
                continue

    async def _scan_once(self) -> None:
        log.info("scan_begin", symbols=self.settings.symbols)
        for symbol in self.settings.symbols:
            await self._scan_symbol(symbol)
            await asyncio.sleep(0.25)
        self.health_state.scans += 1
        self.health_state.last_scan_at = datetime.now(timezone.utc)
        log.info("scan_complete", scans=self.health_state.scans)

    async def _scan_symbol(self, symbol: str) -> None:
        trades = self.trades.get(symbol, self.settings.order_flow.trade_window)
        bundle = await self.pipeline.analyze(symbol, trades=trades)
        plugin_meta = await self.plugins.enrich_all(bundle)
        signal, decision = self.engine.evaluate(bundle)
        decision.details["plugins"] = plugin_meta
        decision.details["execution_tf"] = bundle.execution_tf
        decision.details["rejects"] = bundle.rejects
        self.decisions.write(decision)

        if signal is None:
            log.info(
                "setup_rejected",
                symbol=symbol,
                reasons=decision.reasons,
                confidence=decision.confidence,
            )
            return

        allowed, reason = await self.plugins.allow_signal(signal, bundle)
        if not allowed:
            decision.accepted = False
            decision.reasons.append(reason)
            self.decisions.write(decision)
            log.info("signal_filtered_by_plugin", symbol=symbol, reason=reason)
            return

        sent = await self.alerter.send_signal(signal)
        if sent:
            self.risk.register_open()
            self.health_state.signals_sent += 1
            log.info(
                "signal_accepted",
                symbol=symbol,
                side=signal.side.value,
                confidence=signal.confidence,
                rr=signal.risk_reward,
            )

    async def stop(self) -> None:
        self._stop.set()
        for task in self._tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.ws.close()
        await self.rest.close()
        await self.okx.close()
        await self.cmc.close()
        await self.plugins.teardown_all()
        self.health.stop()
        log.info("assistant_stopped")
