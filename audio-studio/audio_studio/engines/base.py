"""
engines/base.py — the transcription backend interface.

One interface, several backends. The point is not abstraction for its own sake:
the sync problem this studio exists to fix has more than one plausible answer
(a local Whisper model, a hosted provider, a forced alignment pass), and the
studio must be able to change its mind without every caller changing with it.

Backends are imported **lazily** and registered by name, so ``import
audio_studio`` never pulls in torch or a network client, and ``doctor`` can ask
each backend whether it is usable without installing anything.
"""

from __future__ import annotations

import importlib
from abc import ABC, abstractmethod
from typing import Callable, Optional

from ..config import TranscribeOptions
from ..media import Audio
from ..model import Transcript

#: name → "module:ClassName". Imported on demand by :func:`get_engine`.
_REGISTRY: dict[str, str] = {
    "whisper": "audio_studio.engines.whisper:WhisperEngine",
    "fake": "audio_studio.engines.fake:FakeEngine",
}

DEFAULT_ENGINE = "whisper"

#: Called as ``on_progress(fraction, message)`` while a job runs.
ProgressHook = Callable[[float, str], None]


class Engine(ABC):
    """A speech-to-text backend."""

    #: Stable identifier used on the command line and in artifacts.
    name: str = "engine"

    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """``(usable, reason)`` — never raises, so ``doctor`` can always report."""

    @abstractmethod
    def transcribe(
        self,
        audio: Audio,
        options: TranscribeOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> Transcript:
        """Turn audio into a normalised transcript."""

    def describe(self) -> dict:
        usable, reason = self.available()
        return {"name": self.name, "available": usable, "reason": reason}


def register(name: str, target: str) -> None:
    """Register a backend by dotted path, so third parties can extend the suite."""
    _REGISTRY[name] = target


def engine_names() -> list[str]:
    return sorted(_REGISTRY)


def get_engine(name: str = DEFAULT_ENGINE) -> Engine:
    try:
        target = _REGISTRY[name]
    except KeyError:
        raise ValueError(f"unknown engine {name!r}; expected one of {engine_names()}") from None

    module_name, separator, class_name = target.partition(":")
    if not separator:
        raise ValueError(f"registry entry for {name!r} must be 'module:ClassName', got {target!r}")

    module = importlib.import_module(module_name)
    factory = getattr(module, class_name)
    return factory()


def available_engines() -> list[dict]:
    """
    Every registered backend and whether it can actually run right now.

    ``name`` is the *registry* name — the string a user types after ``--engine``
    — while ``backend`` is what the implementation calls itself. Keeping both
    matters because they differ (``whisper`` → ``faster-whisper``), and a report
    that silently renamed the flag would be worse than no report.
    """
    out: list[dict] = []
    for name in engine_names():
        try:
            engine = get_engine(name)
            info = engine.describe()
            info["name"] = name
            info["backend"] = engine.name
        except Exception as exc:
            # An optional dependency that explodes on import is *unavailable*,
            # not a crash: the base install has to stay importable.
            info = {"name": name, "backend": None, "available": False, "reason": f"import failed: {exc}"}
        out.append(info)
    return out
