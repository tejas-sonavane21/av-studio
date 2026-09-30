"""
audio-studio — the audio-side studio of the ``web_av_editor`` suite.

Where ``caption-studio`` owns the *caption* timeline (text, style, placement),
this studio owns the *audio* timeline: speech-to-text with word-level timing,
forced alignment of a trusted transcript against the audio, silence/gap
analysis, and optional LLM validation of the transcript text.

The two studios are siblings: each runs standalone, and the artifacts this one
emits are importable by ``caption-studio`` unchanged.

Design rule: this package must import with **no third-party packages installed**.
Heavy backends (faster-whisper, torch, google-genai) are imported lazily inside
the functions that need them, so the model and the emitters stay pure and
testable.
"""

from .model import (
    APP_VERSION,
    GENERATOR,
    SCHEMA_VERSION,
    Gap,
    Segment,
    Transcript,
    Word,
)

__version__ = APP_VERSION

__all__ = [
    "APP_VERSION",
    "GENERATOR",
    "SCHEMA_VERSION",
    "Gap",
    "Segment",
    "Transcript",
    "Word",
    "__version__",
]
