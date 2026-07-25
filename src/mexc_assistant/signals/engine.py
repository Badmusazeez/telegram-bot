"""Signal engine — quality-first confluence gate."""

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
from mexc_assistant.signals.confidence import score_signal

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

        side = self._resolve_side(bundle, reasons)
        if side is None:
            reasons.append("No directional confluence")
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=None,
                confidence=None,
                reasons=reasons or ["Idle — conditions not favorable"],
            )

        # Hard rejects that contradict direction
        if side == Side.BUY:
            if bundle.ema.flat_or_intertwined or not (
                bundle.ema.aligned_long or (bundle.ema.price_above_ema20 and bundle.higher_tf_trend == Trend.BULLISH)
            ):
                reasons.append("EMA stack does not support long")
            if bundle.order_flow.supports_short and not bundle.order_flow.supports_long:
                reasons.append("Order flow contradicts long")
            if not bundle.liquidity.swept_low:
                reasons.append("No bullish liquidity sweep/rejection yet")
            if bundle.higher_tf_trend != Trend.BULLISH:
                reasons.append("HTF structure not bullish")
            if not bundle.volume.above_average:
                reasons.append("Low-volume breakout rejected")
        else:
            if bundle.ema.flat_or_intertwined or not (
                bundle.ema.aligned_short or (bundle.ema.price_below_ema20 and bundle.higher_tf_trend == Trend.BEARISH)
            ):
                reasons.append("EMA stack does not support short")
            if bundle.order_flow.supports_long and not bundle.order_flow.supports_short:
                reasons.append("Order flow contradicts short")
            if not bundle.liquidity.swept_high:
                reasons.append("No bearish liquidity sweep/rejection yet")
            if bundle.higher_tf_trend != Trend.BEARISH:
                reasons.append("HTF structure not bearish")
            if not bundle.volume.above_average:
                reasons.append("Low-volume breakout rejected")

        # Unique hard-fail reasons only (dedupe)
        hard_fails = []
        for r in reasons:
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
                )
            ):
                hard_fails.append(r)

        # Soft premium/discount warnings shouldn't always hard-fail if sweep+OB present
        soft = {"Bullish bias but price in premium zone", "Bearish bias but price in discount zone"}
        hard_fails = [r for r in hard_fails if r not in soft]

        if hard_fails:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=None,
                reasons=sorted(set(hard_fails)),
            )

        plan = self.risk.build_plan(side, bundle)
        if plan is None:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=None,
                reasons=["Unable to build valid risk plan / RR < minimum"],
            )

        breakdown = score_signal(side, bundle, plan, self.settings.confidence)
        if breakdown.total < self.settings.confidence.min_score:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=[f"Confidence {breakdown.total}% below minimum {self.settings.confidence.min_score}%"],
                details={"scores": breakdown.scores},
            )

        # Crowded funding is a soft penalty already; hard-block only when extreme + weak flow
        if side == Side.BUY and bundle.funding.crowded_longs and breakdown.total < 80:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=["Avoid buying into heavily crowded longs"],
            )
        if side == Side.SELL and bundle.funding.crowded_shorts and breakdown.total < 80:
            return None, DecisionLog(
                symbol=bundle.symbol,
                accepted=False,
                side=side.value,
                confidence=breakdown.total,
                reasons=["Avoid selling into heavily crowded shorts"],
            )

        status = (
            "Await confirmation candle close."
            if self.settings.alerts.require_confirmation_candle
            else "Active setup."
        )
        reason = generate_reason(side, bundle)
        commentary = generate_commentary(side, bundle, plan)
        lvl = risk_level(breakdown.total, plan)
        invalidation = (
            f"Invalidated on close beyond SL {plan.stop_loss}"
        )

        signal = Signal(
            symbol=bundle.symbol,
            side=side,
            trend=bundle.higher_tf_trend,
            confidence=breakdown.total,
            confidence_breakdown=breakdown,
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
            invalidation=invalidation,
            status=status,
            metadata={
                "execution_tf": bundle.execution_tf,
                "position_size": plan.position_size,
                "trailing_after_tp1": plan.trailing_after_tp1,
                "scores": breakdown.scores,
            },
        )
        return signal, DecisionLog(
            symbol=bundle.symbol,
            accepted=True,
            side=side.value,
            confidence=breakdown.total,
            reasons=[reason],
            details={"scores": breakdown.scores, "rr": plan.risk_reward},
        )

    def _resolve_side(self, bundle: AnalysisBundle, reasons: list[str]) -> Side | None:
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
        if long_ok and short_ok:
            reasons.append("Both sides partially valid — idle to avoid forcing trade")
            return None
        if long_ok:
            return Side.BUY
        if short_ok:
            return Side.SELL
        return None
