"""Structured logging setup."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

import orjson
import structlog

from mexc_assistant.core.config import Settings


def _orjson_serializer(obj: Any, **kwargs: Any) -> str:
    return orjson.dumps(obj, default=str).decode("utf-8")


def setup_logging(settings: Settings) -> None:
    level = getattr(logging, settings.logging.level.upper(), logging.INFO)
    log_path = Path(settings.logging.app_log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    file_handler = logging.FileHandler(log_path)
    handlers.append(file_handler)

    logging.basicConfig(format="%(message)s", level=level, handlers=handlers, force=True)

    processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    if settings.logging.json_logs:
        processors.append(structlog.processors.JSONRenderer(serializer=_orjson_serializer))
    else:
        processors.append(structlog.dev.ConsoleRenderer())

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
