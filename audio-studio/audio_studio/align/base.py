"""
align/base.py — the forced-alignment interface.

The same shape as ``engines/base.py``, for the same reason: the sync fix has more
than one possible implementation (a wav2vec2 acoustic model, a hosted aligner,
the deterministic offline stand-in used by tests), and swapping one for another
must not change a single caller.

A backend's job is narrow. It returns, per segment, **one span per word** — where
that word actually is in the audio — plus a confidence, and it touches nothing
else. Turning those spans into a transcript is ``align/apply.py``, which is pure
and therefore testable without a model at all.

Backends are imported lazily and registered by name, so ``import audio_studio``
never pulls in torch.
"""

from __future__ import annotations

import importlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional

from ..config import AlignOptions
from ..media import Audio
from ..model import Transcript

#: name → "module:ClassName". Imported on demand by :func:`get_aligner`.
_REGISTRY: dict[str, str] = {
    "wav2vec": "audio_studio.align.wav2vec:Wav2VecAligner",
    "w2v-bert": "audio_studio.align.w2vbert:Wav2VecBertAligner",
    "fake": "audio_studio.align.fake:FakeAligner",
}

DEFAULT_ALIGNER = "wav2vec"

#: Called as ``on_progress(fraction, message)`` while a job runs.
ProgressHook = Callable[[float, str], None]


@dataclass
class WordSpan:
    """Where one word actually is, and how sure the aligner is about it."""

    start: float
    end: float
    confidence: float = 1.0

    def to_dict(self) -> dict:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "confidence": round(self.confidence, 4),
        }


@dataclass
class AlignmentResult:
    """
    A backend's raw answer.

    ``spans[i][j]`` is the span for word ``j`` of segment ``i``, or ``None`` when
    the aligner has nothing to say about it (a word with no alignable characters,
    most often). It is deliberately *not* a Transcript: whether a span is
    believable is the caller's decision, and keeping that decision out of the
    backend is what lets ``apply.py`` be tested against hand-written spans.
    """

    spans: list[list[Optional[WordSpan]]] = field(default_factory=list)
    provenance: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


class Aligner(ABC):
    """A forced-alignment backend."""

    #: Stable identifier used on the command line and in the artifact.
    name: str = "aligner"

    #: Whether this backend needs the decoded sample buffer. True for anything
    #: that listens to the audio — every real aligner — and False only for the
    #: synthetic stand-in, whose value is that the whole pass can be exercised on
    #: a machine with no decoder installed at all.
    requires_samples: bool = True

    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """``(usable, reason)`` — never raises, so ``doctor`` can always report."""

    @abstractmethod
    def align(
        self,
        audio: Audio,
        transcript: Transcript,
        options: AlignOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> AlignmentResult:
        """Locate every word of ``transcript`` inside ``audio``."""

    def describe(self) -> dict:
        usable, reason = self.available()
        return {"name": self.name, "available": usable, "reason": reason, "requiresSamples": self.requires_samples}


def register(name: str, target: str) -> None:
    """Register a backend by dotted path, so third parties can extend the suite."""
    _REGISTRY[name] = target


def aligner_names() -> list[str]:
    return sorted(_REGISTRY)


def get_aligner(name: str = DEFAULT_ALIGNER) -> Aligner:
    try:
        target = _REGISTRY[name]
    except KeyError:
        raise ValueError(f"unknown aligner {name!r}; expected one of {aligner_names()}") from None

    module_name, separator, class_name = target.partition(":")
    if not separator:
        raise ValueError(f"registry entry for {name!r} must be 'module:ClassName', got {target!r}")

    module = importlib.import_module(module_name)
    return getattr(module, class_name)()


def available_aligners() -> list[dict]:
    """Every registered backend and whether it can actually run right now."""
    out: list[dict] = []
    for name in aligner_names():
        try:
            aligner = get_aligner(name)
            info = aligner.describe()
            info["name"] = name
            info["backend"] = aligner.name
        except Exception as exc:
            # An optional dependency that explodes on import is *unavailable*.
            info = {"name": name, "backend": None, "available": False, "reason": f"import failed: {exc}"}
        out.append(info)
    return out


__all__ = [
    "AlignmentResult",
    "Aligner",
    "DEFAULT_ALIGNER",
    "ProgressHook",
    "WordSpan",
    "aligner_names",
    "available_aligners",
    "get_aligner",
    "register",
]
