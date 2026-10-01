"""
engines/fake.py — a deterministic engine with no dependencies and no model.

Every other part of the studio (the model, the emitters, the bridge to
caption-studio, the CLI, the server) can therefore be tested end-to-end without
a 750 MB download, and the tests assert on *exact* numbers rather than on
whatever Whisper happened to hear today.

It is also genuinely useful as ``--engine fake``: a fast way to check that the
CLI, the file layout and caption-studio's importer all still work, on a machine
where the model is not installed.
"""

from __future__ import annotations

from typing import Optional

from ..config import TranscribeOptions
from ..media import Audio
from ..model import Segment, Transcript, Word
from .base import Engine, ProgressHook

#: Three lines with the long-line problem baked in: the middle one is a
#: transcript-style run-on that a caption editor is expected to split.
DEFAULT_LINES = (
    "we rise before the morning light",
    "and carry every promise that we made along the long way home",
    "the road taught us how to wait",
)

DEFAULT_DURATION = 20.0
GAP = 0.6
LEAD_IN = 0.4


def apportion(start: float, end: float, tokens: list[str]) -> list[tuple[float, float]]:
    """
    Divide ``[start, end]`` between tokens, proportionally to token length.

    The last token ends exactly on ``end`` so the windows stay contiguous — the
    same rule as ``apportionTimes`` in ``caption-studio/src/model/edit.js``.
    """
    if not tokens:
        return []
    span = max(0.0, end - start)
    weights = [max(1, len(t.strip())) for t in tokens]
    total = sum(weights) or 1
    out: list[tuple[float, float]] = []
    cursor = start
    for index, weight in enumerate(weights):
        if index == len(weights) - 1:
            nxt = end
        else:
            nxt = cursor + span * weight / total
        # Both bounds are rounded from the same unrounded cursor, so one slot's
        # end and the next slot's start are always the exact same millisecond.
        out.append((round(cursor, 3), round(nxt, 3)))
        cursor = nxt
    return out


class FakeEngine(Engine):
    name = "fake"

    def available(self) -> tuple[bool, str]:
        return True, "built in (deterministic, no model)"

    def transcribe(
        self,
        audio: Audio,
        options: TranscribeOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> Transcript:
        lines = options.extra.get("lines") or list(DEFAULT_LINES)
        duration = audio.duration or DEFAULT_DURATION
        language = options.language or "en"

        if on_progress:
            on_progress(0.1, "fake engine")

        # Lay the lines out across the audio with a fixed gap between them, then
        # stretch to fill whatever duration the file actually has.
        available = max(0.0, duration - LEAD_IN - GAP * (len(lines) - 1))
        per_line = available / len(lines) if lines else 0.0

        segments: list[Segment] = []
        for index, line in enumerate(lines):
            start = LEAD_IN + index * (per_line + GAP)
            end = start + per_line
            if end > duration:
                end = duration
            tokens = line.split()
            slots = apportion(start, end, tokens)
            words = [
                Word(text=token, start=slot[0], end=slot[1], probability=0.9)
                for token, slot in zip(tokens, slots)
            ]
            segments.append(Segment(start=round(start, 3), end=round(end, 3), words=words))

        if on_progress:
            on_progress(1.0, "fake engine done")

        return Transcript.from_segments(
            segments,
            language=language,
            duration=duration,
            source=audio.to_dict(),
            engine={
                "name": self.name,
                "model": "fake",
                "preset": options.preset,
                "vadFilter": options.vad_filter,
                "note": "synthetic timings for tests and dry runs - not a transcription",
            },
        )
