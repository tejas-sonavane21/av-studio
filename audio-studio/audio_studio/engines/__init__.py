"""
engines/ — transcription backends behind one interface.

``get_engine("whisper")`` returns the local Whisper backend (faster-whisper) and
``get_engine("fake")`` the deterministic offline one. Importing this package
does not import either — the registry resolves them on demand.
"""

from .base import DEFAULT_ENGINE, Engine, ProgressHook, available_engines, engine_names, get_engine, register

__all__ = [
    "DEFAULT_ENGINE",
    "Engine",
    "ProgressHook",
    "available_engines",
    "engine_names",
    "get_engine",
    "register",
]
