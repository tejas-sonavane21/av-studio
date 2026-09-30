"""Shared test fixtures.

Everything here is standard library only, so the whole suite runs on a machine
where **no** optional dependency is installed — the base install (`pip install
-e .`) and nothing else. A test that needed a 750 MB model to catch a layout bug
would not get run, which is the same reason caption-studio's tests are pure Node.
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import pytest

# Make ``import audio_studio`` work even when the package has not been installed.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def write_silent_wav(path: Path, seconds: float = 2.0, rate: int = 8000, channels: int = 1) -> Path:
    """Write a valid 16-bit PCM WAV of silence, using only the stdlib."""
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        frame = b"\x00\x00" * channels
        handle.writeframes(frame * int(rate * seconds))
    return path


@pytest.fixture()
def wav_file(tmp_path: Path) -> Path:
    return write_silent_wav(tmp_path / "clip.wav", seconds=2.0)
