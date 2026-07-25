"""Plugin interface for future enhancements without core refactors."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from mexc_assistant.core.models import AnalysisBundle, Signal


class Plugin(ABC):
    name: str = "base"

    async def setup(self) -> None:
        return None

    @abstractmethod
    async def enrich(self, bundle: AnalysisBundle) -> dict[str, Any]:
        """Return metadata to attach to analysis / signals."""

    async def filter_signal(self, signal: Signal, bundle: AnalysisBundle) -> tuple[bool, str]:
        """Return (allow, reason). Default allow."""
        return True, "ok"

    async def teardown(self) -> None:
        return None


class PluginRegistry:
    def __init__(self) -> None:
        self._plugins: list[Plugin] = []

    def register(self, plugin: Plugin) -> None:
        self._plugins.append(plugin)

    async def setup_all(self) -> None:
        for plugin in self._plugins:
            await plugin.setup()

    async def enrich_all(self, bundle: AnalysisBundle) -> dict[str, Any]:
        meta: dict[str, Any] = {}
        for plugin in self._plugins:
            meta[plugin.name] = await plugin.enrich(bundle)
        return meta

    async def allow_signal(self, signal: Signal, bundle: AnalysisBundle) -> tuple[bool, str]:
        for plugin in self._plugins:
            ok, reason = await plugin.filter_signal(signal, bundle)
            if not ok:
                return False, f"{plugin.name}: {reason}"
        return True, "ok"

    async def teardown_all(self) -> None:
        for plugin in self._plugins:
            await plugin.teardown()
