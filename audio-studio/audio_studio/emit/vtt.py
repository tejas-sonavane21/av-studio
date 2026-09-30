"""
emit/vtt.py — WebVTT output.

The browser's native subtitle format: ``<track src="...">`` consumes it
directly, so a transcript produced here can be dropped into ``<video>`` in
caption-studio without any conversion step. Word-level cues carry an
``<00:00:01.230>`` inline timestamp when ``word_level=True``.
"""

from __future__ import annotations

from ..model import Transcript
from ._time import format_timestamp

KIND = "vtt"
EXTENSION = ".vtt"
OPTIONS = ("word_level",)

SEPARATOR = "."


def render(transcript: Transcript, word_level: bool = False) -> str:
    lines = ["WEBVTT", ""]
    for index, seg in enumerate(transcript.segments, start=1):
        if not seg.text and not seg.words:
            continue
        start = format_timestamp(seg.start, SEPARATOR)
        end = format_timestamp(seg.end, SEPARATOR)
        lines.append(str(index))
        lines.append(f"{start} --> {end}")
        if word_level and seg.words:
            parts = [f"<{format_timestamp(w.start, SEPARATOR)}>{w.text}" for w in seg.words]
            lines.append(" ".join(parts))
        else:
            lines.append(seg.text)
        lines.append("")
    return "\n".join(lines)
