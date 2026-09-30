"""
emit/srt.py — SubRip output.

One cue per segment (the default), or one cue per word when ``word_level=True``
— which is what a karaoke-style burn-in wants, and is the honest way to hand
word timings to a tool that only understands subtitles.
"""

from __future__ import annotations

from ..model import Segment, Transcript
from ._time import format_timestamp

KIND = "srt"
EXTENSION = ".srt"
OPTIONS = ("word_level",)


def _cues(transcript: Transcript, word_level: bool) -> list[tuple[float, float, str]]:
    cues: list[tuple[float, float, str]] = []
    for seg in transcript.segments:
        if word_level and seg.words:
            for word in seg.words:
                cues.append((word.start, word.end, word.text))
        elif seg.text:
            cues.append((seg.start, seg.end, seg.text))
    return cues


def to_cues(transcript: Transcript, word_level: bool = False) -> list[tuple[float, float, str]]:
    return _cues(transcript, word_level)


def render(transcript: Transcript, word_level: bool = False) -> str:
    blocks: list[str] = []
    for index, (start, end, text) in enumerate(_cues(transcript, word_level), start=1):
        blocks.append(f"{index}\n{format_timestamp(start)} --> {format_timestamp(end)}\n{text}")
    if not blocks:
        return ""
    # A blank line separates cues *and* terminates the file - the shape every
    # subtitle parser expects, including caption-studio's own src/io/srt.js.
    return "\n\n".join(blocks) + "\n\n"


def from_segments(segments: list[Segment]) -> str:
    return render(Transcript.from_segments(segments))
