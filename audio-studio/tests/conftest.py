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


class FakeClock:
    """A monotonic clock that only moves when something sleeps."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture(autouse=True)
def llm_clock(monkeypatch):
    """Drive every free-tier cool-down through a fake clock.

    The retry policy is written in seconds, so a test that verified it by really
    waiting would add minutes to the suite to learn nothing: what matters is
    *which* waits the pass asks for, in which order, and how many requests come out
    of one refusal. So ``validate.llm``'s ``_sleep`` and ``_monotonic`` are
    replaced for every test in this directory, and a test that wants to inspect the
    waits just takes ``llm_clock`` as an argument.

    Autouse rather than opt-in because the failure mode of forgetting it is a slow
    suite, which is easy to not notice. It also resets the module's per-model
    strike counts before and after each test, so no test can arm another one's
    cool-down.
    """
    from audio_studio.validate import llm

    clock = FakeClock()
    monkeypatch.setattr(llm, "_sleep", clock.sleep)
    monkeypatch.setattr(llm, "_monotonic", clock.monotonic)
    llm.reset_retry_state()
    yield clock
    llm.reset_retry_state()
