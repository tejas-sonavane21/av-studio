"""
emit/_time.py — subtitle timestamp formatting, shared by the SRT and VTT writers.

Subtitle times are ``HH:MM:SS,mmm`` (SRT) and ``HH:MM:SS.mmm`` (VTT). Both are
derived from the same rounding used everywhere else (:data:`model.TIME_PRECISION`),
so an artifact and the SRT generated from it can never disagree by a millisecond.
"""

from __future__ import annotations

from typing import Any


def split_timestamp(seconds: Any) -> tuple[int, int, int, int]:
    """
    Split seconds into ``(hours, minutes, seconds, milliseconds)``.

    Negative and non-finite input clamps to zero: a subtitle file with a
    ``-1`` timestamp is rejected by most players, so failing loudly beats
    writing a corrupt file.
    """
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        value = 0.0
    if value != value or value in (float("inf"), float("-inf")) or value < 0:
        value = 0.0

    total_ms = int(round(value * 1000))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return hours, minutes, secs, millis


def format_timestamp(seconds: Any, separator: str = ",") -> str:
    """``format_timestamp(83.5)`` → ``'00:01:23,500'`` (``separator='.'`` for VTT)."""
    hours, minutes, secs, millis = split_timestamp(seconds)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def format_timestamp_millis(seconds: Any, separator: str = ",") -> str:
    """Same as :func:`format_timestamp` — kept explicit for call sites that care."""
    return format_timestamp(seconds, separator)
