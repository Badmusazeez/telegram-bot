"""Telegram message formatting for BUY/SELL alerts."""

from __future__ import annotations

from mexc_assistant.core.models import Side, Signal


def _fmt_price(value: float) -> str:
    if value >= 1000:
        return f"{value:,.2f}"
    if value >= 1:
        return f"{value:,.4f}"
    return f"{value:.6f}"


def format_signal_message(signal: Signal) -> str:
    emoji = "🟢" if signal.side == Side.BUY else "🔴"
    display_symbol = signal.symbol.replace("_", "")
    bd = signal.confidence_breakdown

    positive = "\n".join(f"• {p}" for p in bd.positive[:6]) or "• n/a"
    negative = "\n".join(f"• {n}" for n in bd.negative[:6]) or "• none material"

    return (
        f"{emoji} <b>{signal.side.value} {display_symbol}</b>\n\n"
        f"<b>Confidence:</b> {signal.confidence:.0f}% "
        f"({signal.confidence_level.value})\n\n"
        f"<b>Trend:</b>\n{signal.trend.value}\n\n"
        f"<b>Reason:</b>\n{signal.reason}\n\n"
        f"<b>Positive Factors:</b>\n{positive}\n\n"
        f"<b>Negative Factors:</b>\n{negative}\n\n"
        f"<b>Entry:</b>\n{_fmt_price(signal.entry)}\n\n"
        f"<b>Stop Loss:</b>\n{_fmt_price(signal.stop_loss)}\n\n"
        f"<b>Take Profit 1:</b>\n{_fmt_price(signal.tp1)}\n\n"
        f"<b>Take Profit 2:</b>\n{_fmt_price(signal.tp2)}\n\n"
        f"<b>Take Profit 3:</b>\n{_fmt_price(signal.tp3)}\n\n"
        f"<b>Risk-to-Reward:</b>\n{signal.risk_reward:.1f} : 1\n\n"
        f"<b>Risk:</b>\n{signal.risk_level.value}\n\n"
        f"<b>Status:</b>\n{signal.status}\n\n"
        f"<b>Commentary:</b>\n{signal.commentary}\n\n"
        f"<b>Invalidation:</b>\n{signal.invalidation}"
    )
