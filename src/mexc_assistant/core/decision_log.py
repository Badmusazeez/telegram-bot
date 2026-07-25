"""Append-only decision log for accepted and rejected setups."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import orjson

from mexc_assistant.core.models import DecisionLog


class DecisionLogger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, decision: DecisionLog) -> None:
        payload: dict[str, Any] = {
            "symbol": decision.symbol,
            "accepted": decision.accepted,
            "side": decision.side,
            "confidence": decision.confidence,
            "reasons": decision.reasons,
            "timestamp": decision.timestamp.isoformat(),
            "details": decision.details,
        }
        with self.path.open("ab") as fh:
            fh.write(orjson.dumps(payload))
            fh.write(b"\n")
