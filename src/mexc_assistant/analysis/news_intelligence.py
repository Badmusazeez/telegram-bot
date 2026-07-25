"""News & security intelligence affecting confidence / alert suppression."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from mexc_assistant.core.config import DataSourcesConfig
from mexc_assistant.core.models import NewsIntelligenceState
from mexc_assistant.exchange.cmc_client import CoinMarketCapClient, symbol_to_base

HIGH_IMPACT_PATTERNS = [
    (r"\bhack(ed|ing)?\b", "hack"),
    (r"\bexploit(ed|ation)?\b", "exploit"),
    (r"\bsecurity\s+(breach|advisory|incident)\b", "security"),
    (r"\bphishing\b", "scam"),
    (r"\bscam\b", "scam"),
    (r"\brug\s*pull\b", "scam"),
    (r"\bSEC\b|\bregulati(on|ory)\b|\bbanned\b|\blawsuit\b", "regulatory"),
    (r"\btoken\s+unlock\b|\bunlock(s|ing)?\b", "token_unlock"),
    (r"\bhalving\b|\bETF\b|\binterest\s+rate\b|\bFOMC\b", "macro"),
    (r"\bdelist(ing|ed)?\b|\bsuspend(ed|s)?\s+trading\b", "exchange"),
    (r"\bgovernance\b|\bproposal\b", "governance"),
]

VOLATILITY_HINTS = {
    "hack",
    "exploit",
    "security",
    "scam",
    "regulatory",
    "token_unlock",
    "macro",
    "exchange",
}


class NewsIntelligence:
    def __init__(self, cmc: CoinMarketCapClient, config: DataSourcesConfig) -> None:
        self.cmc = cmc
        self.config = config
        self._suppress_until: datetime | None = None

    async def assess(self, symbol: str) -> NewsIntelligenceState:
        if not self.config.news_enabled:
            return NewsIntelligenceState(notes=["News intelligence disabled"])

        now = datetime.now(timezone.utc)
        if self._suppress_until and self._suppress_until > now:
            return NewsIntelligenceState(
                high_impact=True,
                volatility_risk=True,
                suppress_alerts=True,
                confidence_penalty=self.config.high_impact_penalty,
                notes=[f"Alerts suppressed until {self._suppress_until.isoformat()} after high-impact news"],
            )

        news = await self.cmc.get_news(limit=40)
        base = symbol_to_base(symbol).lower()
        categories: list[str] = []
        headlines: list[str] = []
        matched_impact = False

        for item in news:
            title = str(item.get("title") or "")
            if not title:
                continue
            lower = title.lower()
            relevant = base in lower or any(
                k in lower for k in ("crypto", "bitcoin", "ethereum", "market", "sec", "etf")
            )
            if not relevant and base not in {"btc", "eth"}:
                # Still scan global high-impact security/regulatory headlines
                relevant = bool(re.search(r"hack|exploit|sec|etf|ban|lawsuit", lower))
            if not relevant:
                continue

            hit_cats: list[str] = []
            for pattern, cat in HIGH_IMPACT_PATTERNS:
                if re.search(pattern, title, flags=re.IGNORECASE):
                    hit_cats.append(cat)
            if hit_cats:
                matched_impact = True
                categories.extend(hit_cats)
                headlines.append(title)

        categories = sorted(set(categories))
        volatility_risk = bool(set(categories) & VOLATILITY_HINTS)
        suppress = False
        penalty = 0.0
        notes: list[str] = []

        if matched_impact and volatility_risk:
            penalty = self.config.high_impact_penalty
            # Suppress only for severe categories
            severe = {"hack", "exploit", "security", "scam", "exchange"}
            if set(categories) & severe:
                suppress = True
                self._suppress_until = now + timedelta(minutes=self.config.news_suppress_minutes)
                notes.append(
                    f"High-impact security/exchange news detected; suppressing alerts for "
                    f"{self.config.news_suppress_minutes}m"
                )
            else:
                notes.append("Macro/regulatory/unlock news elevates volatility risk; confidence reduced")
        elif headlines:
            notes.append("Relevant headlines monitored; no severe impact flags")
        else:
            notes.append("No material news impact detected")

        return NewsIntelligenceState(
            headlines=headlines[:5],
            high_impact=matched_impact and volatility_risk,
            volatility_risk=volatility_risk,
            suppress_alerts=suppress,
            confidence_penalty=penalty,
            categories=categories,
            notes=notes,
        )
