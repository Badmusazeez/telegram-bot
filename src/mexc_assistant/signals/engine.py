"""Signal engine — quality-first multi-category confluence gate."""

from __future__ import annotations

from mexc_assistant.commentary.generator import generate_commentary, generate_reason, risk_level
from mexc_assistant.core.config import Settings
from mexc_assistant.core.logging import get_logger
from mexc_assistant.core.models import (
    AnalysisBundle,
    DecisionLog,
    RiskLevel,
    Side,
    Signal,
    Trend,
)
from mexc_assistant.risk.manager import RiskManager
from mexc_assistant.signals.confidence import count_positive_categories, score_signal

log = get_logger(__name__)


class SignalEngine:
    def __init__(self, settings: Settings, risk_manager: RiskManager) -> None:
        self.settings = settings
        self.risk = risk_manager

    def evaluate(self, bundle: AnalysisBundle) -> tuple[Signal | None, DecisionLog]:
        reasons: list[str] = list(bundle.rejects)
        ok, gate_reason = self.risk.can_generate()
        if not ok:
            reasons.append(gate_reason)
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=None,
                confidence=None,
                reasons=reasons,
            )

        if bundle.news.suppress_alerts:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=None,
                confidence=None,
                reasons=["News volatility suppression — alerts paused until conditions stabilize"],
                details={"news": bundle.news.notes, "headlines": bundle.news.headlines},
            )

        side = self._resolve_side(bundle, reasons)
        if side is None:
            reasons.append("No directional confluence across required categories")
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=None,
                confidence=None,
                reasons=reasons or ["Idle — conditions not favorable"],
                details={
                    "cross_exchange": bundle.cross_exchange.notes,
                    "news": bundle.news.notes,
                },
            )

        # Never rely on EMA alone — require multi-category hard evidence
        hard_fails = self._hard_fails(side, bundle, reasons)
        soft = {
            "Bullish bias but price in premium zone",
            "Bearish bias but price in discount zone",
            "High-impact news elevates risk",
        }
        hard_fails = [r for r in hard_fails if r not in soft]

        if hard_fails:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=None,
                reasons=sorted(set(hard_fails)),
                details={
                    "cross_exchange": bundle.cross_exchange.notes,
                    "why_rejected": "One or more required confirmation categories failed",
                },
            )

        # Side-aware liquidation heatmap score for confidence weighting
        if side == Side.BUY:
            bundle.liquidation.sweep_aligned = bundle.liquidity.swept_low
            if bundle.liquidity.swept_low:
                bundle.liquidation.score_hint = max(bundle.liquidation.score_hint, 90.0)
        else:
            bundle.liquidation.sweep_aligned = bundle.liquidity.swept_high
            if bundle.liquidity.swept_high:
                bundle.liquidation.score_hint = max(bundle.liquidation.score_hint, 90.0)

        plan = self.risk.build_plan(side, bundle)
        if plan is None:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=None,
                reasons=["Unable to build valid risk plan / RR < minimum 2.5:1"],
            )

        breakdown = score_signal(side, bundle, plan, self.settings.confidence)
        positive_count = count_positive_categories(breakdown, self.settings.confidence)
        if positive_count < self.settings.confidence.min_positive_categories:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=[
                    f"Only {positive_count} positive categories "
                    f"(need {self.settings.confidence.min_positive_categories}); "
                    "EMA-alone / thin confluence rejected"
                ],
                details={
                    "scores": breakdown.scores,
                    "positive": breakdown.positive,
                    "negative": breakdown.negative,
                    "summary": breakdown.summary,
                },
            )

        if breakdown.total < self.settings.confidence.min_score:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=[
                    f"Confidence {breakdown.total}% below minimum {self.settings.confidence.min_score}% "
                    f"({breakdown.level.value})"
                ],
                details={
                    "scores": breakdown.scores,
                    "positive": breakdown.positive,
                    "negative": breakdown.negative,
                    "summary": breakdown.summary,
                },
            )

        if side == Side.BUY and bundle.funding.crowded_longs and breakdown.total < 80:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=["Avoid buying into heavily crowded longs"],
                details={"negative": breakdown.negative},
            )
        if side == Side.SELL and bundle.funding.crowded_shorts and breakdown.total < 80:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=["Avoid selling into heavily crowded shorts"],
                details={"negative": breakdown.negative},
            )

        status = (
            "Await confirmation candle close."
            if self.settings.alerts.require_confirmation_candle
            else "Active setup."
        )
        reason = generate_reason(side, bundle)
        commentary = generate_commentary(side, bundle, plan, breakdown)
        lvl = risk_level(breakdown.total, plan)

        signal = Signal(
            symbol=bundle.symbol,
            side=side,
            trend=bundle.higher_tf_trend,
            confidence=breakdown.total,
            confidence_breakdown=breakdown,
            confidence_level=breakdown.level,
            entry=plan.entry,
            stop_loss=plan.stop_loss,
            tp1=plan.tp1,
            tp2=plan.tp2,
            tp3=plan.tp3,
            final_target=plan.final_target,
            risk_reward=plan.risk_reward,
            risk_level=RiskLevel(lvl),
            reason=reason,
            commentary=commentary,
            invalidation=f"Invalidated on close beyond SL {plan.stop_loss}",
            status=status,
            metadata={
                "execution_tf": bundle.execution_tf,
                "position_size": plan.position_size,
                "trailing_after_tp1": plan.trailing_after_tp1,
                "scores": breakdown.scores,
                "positive_factors": breakdown.positive,
                "negative_factors": breakdown.negative,
                "confidence_summary": breakdown.summary,
                "cross_exchange": bundle.cross_exchange.notes,
                "news": bundle.news.notes,
                "ict_2022": {
                    "valid": bundle.ict_2022.valid,
                    "side": bundle.ict_2022.side.value if bundle.ict_2022.side else None,
                    "quality": bundle.ict_2022.quality,
                    "entry": bundle.ict_2022.entry,
                    "stop": bundle.ict_2022.stop_loss,
                    "target": bundle.ict_2022.target,
                    "notes": bundle.ict_2022.notes,
                },
                "market_meta": {
                    "rank": bundle.market_meta.rank,
                    "market_cap": bundle.market_meta.market_cap,
                },
            },
        )
        return signal, DecisionLog(
            symbol=bundle.symbol,
            accepted=True,
            side=side.value,
            confidence=breakdown.total,
            reasons=[reason, breakdown.summary],
            details={
                "scores": breakdown.scores,
                "positive": breakdown.positive,
                "negative": breakdown.negative,
                "rr": plan.risk_reward,
                "level": breakdown.level.value,
            },
        )

    def _hard_fails(self, side: Side, bundle: AnalysisBundle, reasons: list[str]) -> list[str]:
        out = list(reasons)
        ict = bundle.ict_2022
        ict_ok = (
            self.settings.ict_2022.enabled
            and ict.valid
            and ict.side == side
            and ict.htf_sweep
            and ict.mss
        )

        if self.settings.ict_2022.enabled and self.settings.ict_2022.require_for_alert and not ict_ok:
            out.append("ICT 2022 Model not confirmed for this side")

        if side == Side.BUY:
            if not ict_ok and (
                bundle.ema.flat_or_intertwined
                or not (
                    bundle.ema.aligned_long
                    or (bundle.ema.price_above_ema20 and bundle.higher_tf_trend == Trend.BULLISH)
                )
            ):
                out.append("EMA stack does not support long")
            if bundle.order_flow.supports_short and not bundle.order_flow.supports_long:
                out.append("Order flow contradicts long")
            if not ict_ok and not bundle.liquidity.swept_low:
                out.append("No bullish liquidity sweep/rejection yet")
            if not ict_ok and bundle.higher_tf_trend != Trend.BULLISH:
                out.append("HTF structure not bullish")
            if not bundle.volume.above_average:
                out.append("Low-volume breakout rejected")
            if not ict_ok and not any(z.side == Side.BUY for z in bundle.smc_zones):
                out.append("No bullish SMC zone confirmation")
        else:
            if not ict_ok and (
                bundle.ema.flat_or_intertwined
                or not (
                    bundle.ema.aligned_short
                    or (bundle.ema.price_below_ema20 and bundle.higher_tf_trend == Trend.BEARISH)
                )
            ):
                out.append("EMA stack does not support short")
            if bundle.order_flow.supports_long and not bundle.order_flow.supports_short:
                out.append("Order flow contradicts short")
            if not ict_ok and not bundle.liquidity.swept_high:
                out.append("No bearish liquidity sweep/rejection yet")
            if not ict_ok and bundle.higher_tf_trend != Trend.BEARISH:
                out.append("HTF structure not bearish")
            if not bundle.volume.above_average:
                out.append("Low-volume breakout rejected")
            if not ict_ok and not any(z.side == Side.SELL for z in bundle.smc_zones):
                out.append("No bearish SMC zone confirmation")

        if (
            bundle.cross_exchange.conflicting
            and self.settings.cross_exchange.reject_on_conflict
        ):
            out.append("Cross-exchange validation failed")

        # Filter to hard-fail style messages
        hard: list[str] = []
        for r in out:
            if r in bundle.rejects or any(
                key in r.lower()
                for key in (
                    "contradict",
                    "does not support",
                    "not bullish",
                    "not bearish",
                    "low-volume",
                    "no bullish liquidity",
                    "no bearish liquidity",
                    "flat or intertwined",
                    "declining sharply",
                    "volatility too low",
                    "not revisiting",
                    "mixed/neutral",
                    "cross-exchange",
                    "no bullish smc",
                    "no bearish smc",
                    "news volatility suppression",
                    "ict 2022",
                )
            ):
                hard.append(r)
        return hard

    def _resolve_side(self, bundle: AnalysisBundle, reasons: list[str]) -> Side | None:
        # ICT 2022 Model takes priority when a complete setup is present
        if (
            self.settings.ict_2022.enabled
            and bundle.ict_2022.valid
            and bundle.ict_2022.side is not None
        ):
            return bundle.ict_2022.side

        # Multi-category gate: trend + EMA + structure + SMC + order flow
        long_ok = (
            bundle.higher_tf_trend == Trend.BULLISH
            and (bundle.ema.aligned_long or bundle.ema.price_above_ema20)
            and bundle.structure.trend in {Trend.BULLISH, Trend.NEUTRAL}
            and bundle.order_flow.supports_long
            and any(z.side == Side.BUY for z in bundle.smc_zones)
        )
        short_ok = (
            bundle.higher_tf_trend == Trend.BEARISH
            and (bundle.ema.aligned_short or bundle.ema.price_below_ema20)
            and bundle.structure.trend in {Trend.BEARISH, Trend.NEUTRAL}
            and bundle.order_flow.supports_short
            and any(z.side == Side.SELL for z in bundle.smc_zones)
        )
        if self.settings.ict_2022.enabled and self.settings.ict_2022.require_for_alert:
            reasons.append("ICT 2022 Model required — no complete SSL/BSL → MSS → FVG setup")
            return None
        if long_ok and short_ok:
            reasons.append("Both sides partially valid — idle to avoid forcing trade")
            return None
        if long_ok:
            return Side.BUY
        if short_ok:
            return Side.SELL
        return None
