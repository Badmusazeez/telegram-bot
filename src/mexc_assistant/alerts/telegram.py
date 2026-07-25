"""Telegram alert delivery with deduplication."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import aiohttp

from mexc_assistant.alerts.formatter import format_signal_message
from mexc_assistant.core.config import AlertsConfig
from mexc_assistant.core.logging import get_logger
from mexc_assistant.core.models import Signal

log = get_logger(__name__)


class TelegramAlerter:
    def __init__(
        self,
        token: str,
        chat_id: str,
        config: AlertsConfig,
        dry_run: bool = False,
    ) -> None:
        self.token = token
        self.chat_id = chat_id
        self.config = config
        self.dry_run = dry_run
        self._last_sent: dict[str, datetime] = {}

    def _dedupe_key(self, signal: Signal) -> str:
        return f"{signal.symbol}:{signal.side.value}"

    def should_send(self, signal: Signal) -> bool:
        key = self._dedupe_key(signal)
        last = self._last_sent.get(key)
        if last is None:
            return True
        window = timedelta(minutes=self.config.dedupe_window_minutes)
        return datetime.now(timezone.utc) - last >= window

    async def send_signal(self, signal: Signal) -> bool:
        if not self.should_send(signal):
            log.info("alert_deduped", symbol=signal.symbol, side=signal.side.value)
            return False

        text = format_signal_message(signal)
        if self.dry_run or not self.token or not self.chat_id:
            log.info("alert_dry_run", symbol=signal.symbol, side=signal.side.value, text=text)
            self._last_sent[self._dedupe_key(signal)] = datetime.now(timezone.utc)
            return True

        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": self.config.telegram_parse_mode,
            "disable_web_page_preview": True,
        }
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload) as resp:
                body = await resp.text()
                if resp.status >= 400:
                    log.error("telegram_send_failed", status=resp.status, body=body)
                    return False
        self._last_sent[self._dedupe_key(signal)] = datetime.now(timezone.utc)
        log.info("alert_sent", symbol=signal.symbol, side=signal.side.value, confidence=signal.confidence)
        return True

    async def send_text(self, text: str) -> None:
        if self.dry_run or not self.token or not self.chat_id:
            log.info("telegram_text_dry_run", text=text)
            return
        url = f"https://api.telegram.org/bot{self.token}/sendMessage"
        payload = {"chat_id": self.chat_id, "text": text, "parse_mode": self.config.telegram_parse_mode}
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status >= 400:
                    log.error("telegram_text_failed", status=resp.status, body=await resp.text())
