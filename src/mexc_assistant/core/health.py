"""Lightweight health/metrics HTTP endpoint for VPS monitoring."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any


@dataclass
class HealthState:
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_scan_at: datetime | None = None
    scans: int = 0
    signals_sent: int = 0
    last_error: str | None = None
    symbols: list[str] = field(default_factory=list)
    healthy: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": "ok" if self.healthy else "degraded",
            "started_at": self.started_at.isoformat(),
            "last_scan_at": self.last_scan_at.isoformat() if self.last_scan_at else None,
            "scans": self.scans,
            "signals_sent": self.signals_sent,
            "last_error": self.last_error,
            "symbols": self.symbols,
        }


class HealthServer:
    def __init__(self, state: HealthState, port: int = 8080) -> None:
        self.state = state
        self.port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: Thread | None = None

    def start(self) -> None:
        state = self.state

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path not in {"/", "/health", "/healthz"}:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = json.dumps(state.as_dict()).encode()
                code = 200 if state.healthy else 503
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

        self._server = ThreadingHTTPServer(("0.0.0.0", self.port), Handler)
        self._thread = Thread(target=self._server.serve_forever, name="health-server", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
