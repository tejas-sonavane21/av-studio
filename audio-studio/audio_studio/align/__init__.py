"""
align/ — the forced-alignment pass, and the sync fix this studio exists for.

    transcript ─┐
                ├─▶ backend (wav2vec2 | fake) ─▶ spans ─▶ apply.py ─▶ transcript'
    audio ──────┘

The backend measures; ``apply.py`` decides; one function wires them together:

    from audio_studio.align import align_transcript

    aligned = align_transcript(transcript, audio, "wav2vec")

Adding a backend means adding a module with an ``Aligner`` subclass and listing it
in :data:`base._REGISTRY` — the same shape as the transcription engines, for the
same reason.
"""

from __future__ import annotations

from typing import Optional

from ..config import AlignOptions
from ..media import Audio
from ..model import Transcript
from .base import (
    DEFAULT_ALIGNER,
    AlignmentResult,
    Aligner,
    ProgressHook,
    WordSpan,
    aligner_names,
    available_aligners,
    get_aligner,
    register,
)

__all__ = [
    "DEFAULT_ALIGNER",
    "AlignmentResult",
    "Aligner",
    "ProgressHook",
    "WordSpan",
    "align_transcript",
    "aligner_names",
    "available_aligners",
    "get_aligner",
    "register",
]


def align_transcript(
    transcript: Transcript,
    audio: Audio,
    options: Optional[AlignOptions] = None,
    backend: str = DEFAULT_ALIGNER,
    on_progress: Optional[ProgressHook] = None,
) -> Transcript:
    """
    Re-time ``transcript`` against ``audio`` and return the result.

    The backend selection is a *name* rather than an instance so that the
    provenance always records which backend actually ran, and so a typo fails with
    a list of valid names instead of an ``AttributeError``.

    Raises whatever the backend raises — an unavailable backend is a request that
    cannot be served, not a transcript that should silently go unaligned. Callers
    that want to degrade gracefully (``transcribe --align`` when torch is missing)
    check ``available()`` first, or catch this themselves.
    """
    from .apply import apply_alignment

    aligner = get_aligner(backend)
    result = aligner.align(audio, transcript, options or AlignOptions(), on_progress)
    # Record *which* implementation ran, not just what it was asked for: the two
    # can differ (a registry name versus the backend's own name), and a provenance
    # record that quietly renamed the thing would be worse than none.
    result.provenance = {"aligner": backend, **dict(result.provenance)}
    return apply_alignment(transcript, result, options)
