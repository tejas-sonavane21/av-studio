"""
align/fake.py — a deterministic aligner with no dependencies and no model.

Two jobs, and it is honest about both.

**It is a test harness.** ``apply.py`` makes real decisions — which segments clear
the confidence guard, how an unalignable word is interpolated, whether a shift is
too wild to believe — and those decisions have to be testable with *exact* spans.
A synthetic backend that produces spans from the segment's own geometry gives the
tests a stable, reproducible answer without a 360 MB acoustic model, and lets the
guards be driven into each of their branches on purpose.

**It is a wiring check.** ``--align fake`` runs the whole pass — backend, guards,
provenance, emitters — on a machine where torch is not installed, so "did the
alignment plumbing break?" is answerable in a second rather than a download.

It is **not** an alignment, and says so: the provenance records
``"synthetic": true`` and every span is derived from the word's own length rather
than from the audio. The numbers it produces are plausible-looking and worthless,
which is exactly why it is never the default.
"""

from __future__ import annotations

from typing import Optional

from ..config import AlignOptions
from ..media import Audio
from ..model import Transcript
from .base import AlignmentResult, Aligner, ProgressHook, WordSpan


def apportion(start: float, end: float, weights: list[int]) -> list[tuple[float, float]]:
    """
    Divide ``[start, end]`` into contiguous slots proportional to ``weights``.

    Contiguous and rounded from one unrounded cursor, so slot *i*'s end and slot
    *i+1*'s start are the same millisecond — the same rule as ``apportionTimes`` in
    ``caption-studio/src/model/edit.js``.
    """
    if not weights:
        return []
    span = max(0.0, end - start)
    total = sum(weights) or 1
    out: list[tuple[float, float]] = []
    cursor = start
    for index, weight in enumerate(weights):
        nxt = end if index == len(weights) - 1 else cursor + span * weight / total
        out.append((round(cursor, 3), round(nxt, 3)))
        cursor = nxt
    return out


class FakeAligner(Aligner):
    name = "fake"

    #: It derives its timings from the transcript's own geometry, so it never
    #: touches the samples — and therefore never needs a decoder either.
    requires_samples = False

    def available(self) -> tuple[bool, str]:
        return True, "built in (deterministic, no model)"

    def align(
        self,
        audio: Audio,
        transcript: Transcript,
        options: AlignOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> AlignmentResult:
        spans: list[list[Optional[WordSpan]]] = []
        total = len(transcript.segments) or 1

        for index, segment in enumerate(transcript.segments):
            words = segment.words
            if not words:
                spans.append([])
                continue
            weights = [max(1, len(word.text.strip())) for word in words]
            slots = apportion(segment.start, segment.end, weights)
            spans.append(
                [
                    WordSpan(start=slot[0], end=slot[1], confidence=_confidence(word.text, slot))
                    for word, slot in zip(words, slots)
                ]
            )
            if on_progress:
                on_progress((index + 1) / total, f"{index + 1}/{total} segments")

        return AlignmentResult(
            spans=spans,
            provenance={
                "backend": self.name,
                "synthetic": True,
                "note": "timings derived from word length, not from the audio",
                "windowPad": options.window_pad,
            },
            warnings=["the fake aligner does not listen to the audio: its timings are synthetic"],
        )


def _confidence(text: str, slot: tuple[float, float]) -> float:
    """
    A deterministic, word-dependent confidence in ``[0.5, 1.0]``.

    Word-dependent on purpose: the tests need to push a *specific* segment below
    the confidence guard, and a constant would make every segment cross or clear it
    together.
    """
    if not text:
        return 0.0
    digest = sum((position + 1) * ord(char) for position, char in enumerate(text))
    return round(0.5 + 0.5 * ((digest * 2654435761) % 1000) / 1000.0, 4)


__all__ = ["FakeAligner", "apportion"]
