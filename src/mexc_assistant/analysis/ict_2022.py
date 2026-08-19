"""ICT 2022 Model — HTF liquidity sweep → LTF MSS → FVG entry.

Buy (bullish):
  1. HTF (15m+) takes out key Sellside Liquidity (SSL)
  2. Drop to LTF (1–5m)
  3. Market Structure Shift: break above a recent short-term swing high
  4. Bullish FVG in the displacement leg, ideally in discount (< 0.5)
  5. Buy limit at FVG high; target next Buyside Liquidity (BSL)
  6. Stop under sweep swing low or first candle of the FVG

Sell (bearish): mirror — BSL sweep → MSS below swing low → FVG in premium →
sell limit at FVG low → target SSL; stop above swing high / FVG first candle.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from mexc_assistant.core.config import ICT2022Config, StructureConfig
from mexc_assistant.core.models import Candle, Side, SMCZone
from mexc_assistant.analysis.smc import detect_fvgs
from mexc_assistant.analysis.structure import _swing_points


@dataclass(slots=True)
class ICT2022Setup:
    valid: bool = False
    side: Side | None = None
    htf_sweep: bool = False
    mss: bool = False
    fvg_top: float = 0.0
    fvg_bottom: float = 0.0
    entry: float = 0.0
    stop_loss: float = 0.0
    target: float = 0.0
    equilibrium: float = 0.0
    displacement_high: float = 0.0
    displacement_low: float = 0.0
    in_discount: bool = False
    in_premium: bool = False
    quality: float = 0.0
    swept_level: float = 0.0
    mss_level: float = 0.0
    notes: list[str] = field(default_factory=list)


def _key_ssl(htf: list[Candle], daily: list[Candle], config: StructureConfig) -> list[float]:
    """Sellside liquidity: swing lows, equal lows, session / prior-day lows."""
    highs, lows = _swing_points(htf, config.swing_lookback)
    levels = [p for _, p in lows[-6:]]
    session = htf[-96:] if len(htf) >= 96 else htf
    if session:
        levels.append(min(c.low for c in session))
    if len(daily) >= 2:
        levels.append(daily[-2].low)
    # Equal lows (clustered)
    raw_lows = sorted(c.low for c in htf[-80:])
    for i in range(1, len(raw_lows)):
        if abs(raw_lows[i] - raw_lows[i - 1]) / max(raw_lows[i], 1e-12) <= config.equal_level_tolerance_pct:
            levels.append((raw_lows[i] + raw_lows[i - 1]) / 2.0)
    return sorted(set(round(x, 10) for x in levels))


def _key_bsl(htf: list[Candle], daily: list[Candle], config: StructureConfig) -> list[float]:
    """Buyside liquidity: swing highs, equal highs, session / prior-day highs."""
    highs, lows = _swing_points(htf, config.swing_lookback)
    _ = lows
    levels = [p for _, p in highs[-6:]]
    session = htf[-96:] if len(htf) >= 96 else htf
    if session:
        levels.append(max(c.high for c in session))
    if len(daily) >= 2:
        levels.append(daily[-2].high)
    raw_highs = sorted(c.high for c in htf[-80:])
    for i in range(1, len(raw_highs)):
        if abs(raw_highs[i] - raw_highs[i - 1]) / max(raw_highs[i], 1e-12) <= config.equal_level_tolerance_pct:
            levels.append((raw_highs[i] + raw_highs[i - 1]) / 2.0)
    return sorted(set(round(x, 10) for x in levels))


def _find_ssl_sweep(
    htf: list[Candle], ssl_levels: list[float], lookback: int
) -> tuple[bool, float, int]:
    """Return (swept, level, candle_index) for most recent SSL sweep."""
    if not htf or not ssl_levels:
        return False, 0.0, -1
    start = max(1, len(htf) - lookback)
    best: tuple[bool, float, int] = (False, 0.0, -1)
    for i in range(start, len(htf)):
        c = htf[i]
        for lvl in ssl_levels:
            if c.low < lvl and c.close > lvl:
                best = (True, lvl, i)
    return best


def _find_bsl_sweep(
    htf: list[Candle], bsl_levels: list[float], lookback: int
) -> tuple[bool, float, int]:
    if not htf or not bsl_levels:
        return False, 0.0, -1
    start = max(1, len(htf) - lookback)
    best: tuple[bool, float, int] = (False, 0.0, -1)
    for i in range(start, len(htf)):
        c = htf[i]
        for lvl in bsl_levels:
            if c.high > lvl and c.close < lvl:
                best = (True, lvl, i)
    return best


def _map_htf_index_to_ltf(htf: list[Candle], ltf: list[Candle], htf_idx: int) -> int:
    """Approximate LTF index at/after HTF candle time."""
    if htf_idx < 0 or htf_idx >= len(htf) or not ltf:
        return 0
    t = htf[htf_idx].time
    for i, c in enumerate(ltf):
        if c.time >= t:
            return i
    return max(0, len(ltf) - 1)


def _recent_swing_high(ltf: list[Candle], end: int, lookback: int) -> tuple[float, int]:
    highs, _ = _swing_points(ltf[: end + 1], lookback)
    if not highs:
        window = ltf[max(0, end - lookback * 3) : end + 1]
        if not window:
            return ltf[end].high, end
        i = max(range(len(window)), key=lambda j: window[j].high)
        return window[i].high, max(0, end - lookback * 3) + i
    idx, price = highs[-1]
    return price, idx


def _recent_swing_low(ltf: list[Candle], end: int, lookback: int) -> tuple[float, int]:
    _, lows = _swing_points(ltf[: end + 1], lookback)
    if not lows:
        window = ltf[max(0, end - lookback * 3) : end + 1]
        if not window:
            return ltf[end].low, end
        i = min(range(len(window)), key=lambda j: window[j].low)
        return window[i].low, max(0, end - lookback * 3) + i
    idx, price = lows[-1]
    return price, idx


def _fvg_in_discount(zone: SMCZone, eq: float, leg_low: float, leg_high: float) -> bool:
    mid = (zone.top + zone.bottom) / 2.0
    return mid <= eq and leg_low < leg_high


def _fvg_in_premium(zone: SMCZone, eq: float, leg_low: float, leg_high: float) -> bool:
    mid = (zone.top + zone.bottom) / 2.0
    return mid >= eq and leg_low < leg_high


def _first_fvg_candle_extreme(
    ltf: list[Candle], zone: SMCZone, side: Side
) -> float | None:
    """Stop reference: extreme of the first candle of the 3-candle FVG pattern."""
    for i in range(2, len(ltf)):
        c0, c2 = ltf[i - 2], ltf[i]
        if side == Side.BUY and abs(c0.high - zone.bottom) < 1e-9 and abs(c2.low - zone.top) < 1e-9:
            return min(c0.low, ltf[i - 1].low, c2.low)
        if side == Side.SELL and abs(c0.low - zone.top) < 1e-9 and abs(c2.high - zone.bottom) < 1e-9:
            return max(c0.high, ltf[i - 1].high, c2.high)
    return None


def _next_bsl_above(levels: list[float], price: float) -> float | None:
    above = [x for x in levels if x > price * 1.0002]
    return min(above) if above else None


def _next_ssl_below(levels: list[float], price: float) -> float | None:
    below = [x for x in levels if x < price * 0.9998]
    return max(below) if below else None


def detect_ict_2022(
    htf_candles: list[Candle],
    ltf_candles: list[Candle],
    daily_candles: list[Candle],
    structure_config: StructureConfig,
    ict_config: ICT2022Config,
    smc_fvg_min_gap_pct: float,
) -> ICT2022Setup:
    """Detect the highest-quality ICT 2022 buy or sell setup currently present."""
    notes: list[str] = []
    if len(htf_candles) < 30 or len(ltf_candles) < 40:
        return ICT2022Setup(notes=["Insufficient candles for ICT 2022"])

    from mexc_assistant.core.config import SMCConfig

    smc_cfg = SMCConfig(fvg_min_gap_pct=smc_fvg_min_gap_pct)

    ssl = _key_ssl(htf_candles, daily_candles, structure_config)
    bsl = _key_bsl(htf_candles, daily_candles, structure_config)

    buy = _detect_buy(
        htf_candles, ltf_candles, ssl, bsl, structure_config, ict_config, smc_cfg, notes
    )
    sell = _detect_sell(
        htf_candles, ltf_candles, ssl, bsl, structure_config, ict_config, smc_cfg, notes
    )

    candidates = [s for s in (buy, sell) if s.valid]
    if not candidates:
        return ICT2022Setup(
            notes=notes
            or [
                "No ICT 2022 setup: need HTF liquidity sweep + LTF MSS + displacement FVG",
            ]
        )
    return max(candidates, key=lambda s: s.quality)


def _detect_buy(
    htf: list[Candle],
    ltf: list[Candle],
    ssl: list[float],
    bsl: list[float],
    struct_cfg: StructureConfig,
    ict: ICT2022Config,
    smc_cfg,
    notes: list[str],
) -> ICT2022Setup:
    swept, swept_lvl, htf_idx = _find_ssl_sweep(htf, ssl, ict.htf_sweep_lookback)
    if not swept:
        notes.append("BUY path: no HTF SSL sweep")
        return ICT2022Setup(side=Side.BUY, notes=["No SSL sweep"])

    ltf_start = _map_htf_index_to_ltf(htf, ltf, htf_idx)
    # Sweep low on LTF near mapping
    sweep_low = min(c.low for c in ltf[ltf_start : min(len(ltf), ltf_start + 8)] or ltf[-8:])

    mss = False
    mss_level = 0.0
    mss_idx = -1
    search_end = len(ltf) - 1
    for i in range(ltf_start + 2, search_end + 1):
        sh, sh_idx = _recent_swing_high(ltf, i - 1, struct_cfg.swing_lookback)
        if sh_idx >= i:
            continue
        if ltf[i].close > sh and ltf[i - 1].close <= sh:
            mss = True
            mss_level = sh
            mss_idx = i
            # keep most recent MSS after sweep
    if not mss or mss_idx < 0:
        notes.append("BUY path: SSL swept but no LTF MSS above swing high")
        return ICT2022Setup(
            side=Side.BUY,
            htf_sweep=True,
            swept_level=swept_lvl,
            notes=["SSL swept, awaiting MSS"],
        )

    leg_low = sweep_low
    leg_high = max(c.high for c in ltf[ltf_start : mss_idx + 1])
    eq = (leg_low + leg_high) / 2.0

    # FVGs formed during displacement (up to MSS)
    segment = ltf[max(0, ltf_start - 2) : mss_idx + 3]
    fvgs = [z for z in detect_fvgs(segment, smc_cfg) if z.side == Side.BUY]
    if not fvgs:
        notes.append("BUY path: MSS without bullish FVG in displacement")
        return ICT2022Setup(
            side=Side.BUY,
            htf_sweep=True,
            mss=True,
            swept_level=swept_lvl,
            mss_level=mss_level,
            notes=["MSS without FVG"],
        )

    # Prefer discount FVGs; fall back to any in-leg FVG
    discount = [z for z in fvgs if _fvg_in_discount(z, eq, leg_low, leg_high)]
    pool = discount if discount else fvgs
    # Prefer FVG closest to current price from below / still above sweep
    price = ltf[-1].close
    zone = min(pool, key=lambda z: abs(((z.top + z.bottom) / 2) - price))

    entry = zone.top  # buy limit at FVG high
    fvg_first_ext = _first_fvg_candle_extreme(segment, zone, Side.BUY)
    stop_candidates = [leg_low]
    if fvg_first_ext is not None:
        stop_candidates.append(fvg_first_ext)
    stop = min(stop_candidates)
    # Small buffer under structure
    stop *= 1.0 - ict.stop_buffer_pct

    target = _next_bsl_above(bsl, max(entry, price))
    if target is None:
        # Synthetic: extension of displacement
        target = entry + (leg_high - leg_low) * ict.fallback_target_extension

    in_discount = _fvg_in_discount(zone, eq, leg_low, leg_high)
    risk = entry - stop
    reward = target - entry
    if risk <= 0 or reward / risk < ict.min_model_rr:
        notes.append("BUY path: ICT RR below model minimum")
        return ICT2022Setup(
            side=Side.BUY,
            htf_sweep=True,
            mss=True,
            swept_level=swept_lvl,
            mss_level=mss_level,
            notes=["RR too low"],
        )

    quality = 55.0
    quality += 15.0  # SSL sweep
    quality += 15.0  # MSS
    quality += 10.0 if in_discount else 0.0
    quality += 5.0 if discount else 0.0
    # Price near FVG for actionable entry
    if zone.bottom <= price <= zone.top * (1 + ict.entry_proximity_pct) or (
        price <= entry and abs(price - entry) / entry <= ict.entry_proximity_pct
    ):
        quality += 10.0
    quality = min(100.0, quality)

    return ICT2022Setup(
        valid=True,
        side=Side.BUY,
        htf_sweep=True,
        mss=True,
        fvg_top=zone.top,
        fvg_bottom=zone.bottom,
        entry=entry,
        stop_loss=stop,
        target=target,
        equilibrium=eq,
        displacement_high=leg_high,
        displacement_low=leg_low,
        in_discount=in_discount,
        in_premium=False,
        quality=quality,
        swept_level=swept_lvl,
        mss_level=mss_level,
        notes=[
            f"ICT 2022 BUY: SSL {swept_lvl:.6g} swept → LTF MSS above {mss_level:.6g} → "
            f"FVG [{'discount' if in_discount else 'equilibrium/premium'}] entry {entry:.6g} → BSL {target:.6g}"
        ],
    )


def _detect_sell(
    htf: list[Candle],
    ltf: list[Candle],
    ssl: list[float],
    bsl: list[float],
    struct_cfg: StructureConfig,
    ict: ICT2022Config,
    smc_cfg,
    notes: list[str],
) -> ICT2022Setup:
    swept, swept_lvl, htf_idx = _find_bsl_sweep(htf, bsl, ict.htf_sweep_lookback)
    if not swept:
        notes.append("SELL path: no HTF BSL sweep")
        return ICT2022Setup(side=Side.SELL, notes=["No BSL sweep"])

    ltf_start = _map_htf_index_to_ltf(htf, ltf, htf_idx)
    sweep_high = max(c.high for c in ltf[ltf_start : min(len(ltf), ltf_start + 8)] or ltf[-8:])

    mss = False
    mss_level = 0.0
    mss_idx = -1
    for i in range(ltf_start + 2, len(ltf)):
        sl, sl_idx = _recent_swing_low(ltf, i - 1, struct_cfg.swing_lookback)
        if sl_idx >= i:
            continue
        if ltf[i].close < sl and ltf[i - 1].close >= sl:
            mss = True
            mss_level = sl
            mss_idx = i
    if not mss or mss_idx < 0:
        notes.append("SELL path: BSL swept but no LTF MSS below swing low")
        return ICT2022Setup(
            side=Side.SELL,
            htf_sweep=True,
            swept_level=swept_lvl,
            notes=["BSL swept, awaiting MSS"],
        )

    leg_high = sweep_high
    leg_low = min(c.low for c in ltf[ltf_start : mss_idx + 1])
    eq = (leg_low + leg_high) / 2.0

    segment = ltf[max(0, ltf_start - 2) : mss_idx + 3]
    fvgs = [z for z in detect_fvgs(segment, smc_cfg) if z.side == Side.SELL]
    if not fvgs:
        notes.append("SELL path: MSS without bearish FVG in displacement")
        return ICT2022Setup(
            side=Side.SELL,
            htf_sweep=True,
            mss=True,
            swept_level=swept_lvl,
            mss_level=mss_level,
            notes=["MSS without FVG"],
        )

    premium = [z for z in fvgs if _fvg_in_premium(z, eq, leg_low, leg_high)]
    pool = premium if premium else fvgs
    price = ltf[-1].close
    zone = min(pool, key=lambda z: abs(((z.top + z.bottom) / 2) - price))

    entry = zone.bottom  # sell limit at FVG low
    fvg_first_ext = _first_fvg_candle_extreme(segment, zone, Side.SELL)
    stop_candidates = [leg_high]
    if fvg_first_ext is not None:
        stop_candidates.append(fvg_first_ext)
    stop = max(stop_candidates) * (1.0 + ict.stop_buffer_pct)

    target = _next_ssl_below(ssl, min(entry, price))
    if target is None:
        target = entry - (leg_high - leg_low) * ict.fallback_target_extension

    in_premium = _fvg_in_premium(zone, eq, leg_low, leg_high)
    risk = stop - entry
    reward = entry - target
    if risk <= 0 or reward / risk < ict.min_model_rr:
        notes.append("SELL path: ICT RR below model minimum")
        return ICT2022Setup(
            side=Side.SELL,
            htf_sweep=True,
            mss=True,
            swept_level=swept_lvl,
            mss_level=mss_level,
            notes=["RR too low"],
        )

    quality = 55.0
    quality += 15.0
    quality += 15.0
    quality += 10.0 if in_premium else 0.0
    quality += 5.0 if premium else 0.0
    if zone.bottom * (1 - ict.entry_proximity_pct) <= price <= zone.top or (
        price >= entry and abs(price - entry) / entry <= ict.entry_proximity_pct
    ):
        quality += 10.0
    quality = min(100.0, quality)

    return ICT2022Setup(
        valid=True,
        side=Side.SELL,
        htf_sweep=True,
        mss=True,
        fvg_top=zone.top,
        fvg_bottom=zone.bottom,
        entry=entry,
        stop_loss=stop,
        target=target,
        equilibrium=eq,
        displacement_high=leg_high,
        displacement_low=leg_low,
        in_discount=False,
        in_premium=in_premium,
        quality=quality,
        swept_level=swept_lvl,
        mss_level=mss_level,
        notes=[
            f"ICT 2022 SELL: BSL {swept_lvl:.6g} swept → LTF MSS below {mss_level:.6g} → "
            f"FVG [{'premium' if in_premium else 'equilibrium/discount'}] entry {entry:.6g} → SSL {target:.6g}"
        ],
    )
