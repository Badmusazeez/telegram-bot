"""CLI entrypoint."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal

from mexc_assistant.app import TradingAssistant
from mexc_assistant.core.config import load_settings
from mexc_assistant.core.logging import get_logger, setup_logging


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MEXC AI Trading Assistant")
    parser.add_argument("--config", default=None, help="Path to settings.yaml")
    parser.add_argument("--once", action="store_true", help="Run a single scan cycle and exit")
    parser.add_argument("--dry-run", action="store_true", help="Log alerts instead of sending Telegram")
    return parser


async def _run(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    if args.dry_run:
        settings.app.dry_run = True
    setup_logging(settings)
    log = get_logger(__name__)

    assistant = TradingAssistant(settings)

    if args.once:
        await assistant.plugins.setup_all()
        assistant.health.start()
        try:
            for symbol in settings.symbols:
                try:
                    deals = await assistant.rest.get_recent_deals(
                        symbol, limit=settings.order_flow.trade_window
                    )
                    assistant.trades.seed(symbol, deals)
                except Exception as exc:  # noqa: BLE001
                    log.warning("seed_failed", symbol=symbol, error=str(exc))
            await assistant._scan_once()
        finally:
            await assistant.rest.close()
            await assistant.okx.close()
            await assistant.cmc.close()
            assistant.health.stop()
            await assistant.plugins.teardown_all()
        return 0

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _handle_stop(*_: object) -> None:
        log.info("shutdown_signal_received")
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, _handle_stop)

    task = asyncio.create_task(assistant.start())
    await stop_event.wait()
    await assistant.stop()
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    return 0


def cli() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(_run(args)))
    except KeyboardInterrupt:
        raise SystemExit(0) from None


if __name__ == "__main__":
    cli()
