"""Risk management, stops/targets, and loss-limit gates."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from mexc_assistant.analysis.smc import price_in_zone
from mexc_assistant.core.config import Settings
from mexc_assistant.core.models import AnalysisBundle, RiskPlan, Side


@dataclass
class RiskLedger:
    daily_pnl_pct: float = 0.0
    weekly_pnl_pct: float = 0.0
    open_positions: int = 0
    day_key: str = ""
    week_key: str = ""
    halted_until: datetime | None = None
    history: list[float] = field(default_factory=list)

    def roll(self, now: datetime | None = None) -> None:
        now = now or datetime.now(timezone.utc)
        day = now.strftime("%Y-%m-%d")
        week = now.strftime("%Y-%W")
        if day != self.day_key:
            self.day_key = day
            self.daily_pnl_pct = 0.0
            if self.halted_until and self.halted_until <= now:
                self.halted_until = None
        if week != self.week_key:
            self.week_key = week
            self.weekly_pnl_pct = 0.0


class RiskManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.ledger = RiskLedger()

    def can_generate(self) -> tuple[bool, str]:
        self.ledger.roll()
        now = datetime.now(timezone.utc)
        if self.ledger.halted_until and self.ledger.halted_until > now:
            return False, "Risk halt active after loss limit"
        cfg = self.settings.risk
        if self.ledger.open_positions >= cfg.max_simultaneous_positions:
            return False, "Max simultaneous positions reached"
        if abs(self.ledger.daily_pnl_pct) >= cfg.daily_loss_limit_pct and self.ledger.daily_pnl_pct < 0:
            self.ledger.halted_until = now.replace(hour=23, minute=59, second=59)
            return False, "Daily loss limit reached"
        if abs(self.ledger.weekly_pnl_pct) >= cfg.weekly_loss_limit_pct and self.ledger.weekly_pnl_pct < 0:
            return False, "Weekly loss limit reached"
        return True, "ok"

    def register_open(self) -> None:
        self.ledger.open_positions += 1

    def register_close(self, pnl_pct: float) -> None:
        self.ledger.roll()
        self.ledger.open_positions = max(0, self.ledger.open_positions - 1)
        self.ledger.daily_pnl_pct += pnl_pct
        self.ledger.weekly_pnl_pct += pnl_pct
        self.ledger.history.append(pnl_pct)

    def build_plan(self, side: Side, bundle: AnalysisBundle) -> RiskPlan | None:
        cfg = self.settings.risk
        vol_cfg = self.settings.volatility
        atr = bundle.volatility.atr
        if atr <= 0:
            return None

        ict = bundle.ict_2022
        use_ict = (
            self.settings.ict_2022.enabled
            and ict.valid
            and ict.side == side
            and ict.entry > 0
            and ict.stop_loss > 0
            and ict.target > 0
        )

        if use_ict:
            entry = ict.entry
            stop = ict.stop_loss
            if side == Side.BUY:
                risk = entry - stop
            else:
                risk = stop - entry
            if risk <= 0:
                return None
            # ICT primary target is opposite liquidity; still emit TP ladder
            final = ict.target
            if side == Side.BUY:
                if final <= entry:
                    return None
                span = final - entry
                tp1, tp2, tp3 = entry + span * 0.4, entry + span * 0.7, final
            else:
                if final >= entry:
                    return None
                span = entry - final
                tp1, tp2, tp3 = entry - span * 0.4, entry - span * 0.7, final
            rr = abs(final - entry) / risk
            if rr < cfg.min_rr:
                # Stretch final slightly only if still short of min RR but model target exists
                needed = risk * cfg.min_rr
                if side == Side.BUY:
                    final = entry + needed
                    tp3 = final
                else:
                    final = entry - needed
                    tp3 = final
                rr = abs(final - entry) / risk
            if rr < cfg.min_rr:
                return None
            risk_amount = cfg.account_equity * cfg.risk_per_trade_pct
            position_size = risk_amount / risk
            return RiskPlan(
                entry=entry,
                stop_loss=stop,
                tp1=tp1,
                tp2=tp2,
                tp3=tp3,
                final_target=final,
                risk_reward=rr,
                position_size=position_size,
                risk_amount=risk_amount,
                trailing_after_tp1=cfg.trailing_after_tp1,
            )

        entry = bundle.price
        structure_stop = (
            bundle.structure.swing_low
            if side == Side.BUY
            else bundle.structure.swing_high
        )
        atr_stop = (
            entry - atr * vol_cfg.stop_atr_multiplier
            if side == Side.BUY
            else entry + atr * vol_cfg.stop_atr_multiplier
        )

        ob_invalid = self._order_block_invalidation(side, bundle)
        if side == Side.BUY:
            candidates = [atr_stop, structure_stop]
            if ob_invalid:
                candidates.append(ob_invalid)
            stop = min(candidates)
            if stop >= entry:
                stop = atr_stop
            risk = entry - stop
        else:
            candidates = [atr_stop, structure_stop]
            if ob_invalid:
                candidates.append(ob_invalid)
            stop = max(candidates)
            if stop <= entry:
                stop = atr_stop
            risk = stop - entry

        if risk <= 0:
            return None

        # Prefer 3R, enforce min 2.5R on final target
        r1, r2, r3, r_final = 1.5, 2.5, cfg.preferred_rr, max(cfg.preferred_rr, cfg.min_rr + 0.5)
        if side == Side.BUY:
            tp1, tp2, tp3 = entry + risk * r1, entry + risk * r2, entry + risk * r3
            final = entry + risk * r_final
        else:
            tp1, tp2, tp3 = entry - risk * r1, entry - risk * r2, entry - risk * r3
            final = entry - risk * r_final

        rr = abs(final - entry) / risk
        if rr < cfg.min_rr:
            return None

        risk_amount = cfg.account_equity * cfg.risk_per_trade_pct
        position_size = risk_amount / risk

        return RiskPlan(
            entry=entry,
            stop_loss=stop,
            tp1=tp1,
            tp2=tp2,
            tp3=tp3,
            final_target=final,
            risk_reward=rr,
            position_size=position_size,
            risk_amount=risk_amount,
            trailing_after_tp1=cfg.trailing_after_tp1,
        )

    def _order_block_invalidation(self, side: Side, bundle: AnalysisBundle) -> float | None:
        tol = self.settings.smc.zone_touch_tolerance_pct
        zones = [
            z
            for z in bundle.smc_zones
            if z.side == side and z.kind in {"order_block", "mitigation_block"}
            and price_in_zone(bundle.price, z, tol)
        ]
        if not zones:
            return None
        z = max(zones, key=lambda x: x.strength)
        return z.bottom if side == Side.BUY else z.top
