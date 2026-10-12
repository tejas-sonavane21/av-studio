"""
media.py — the decode chain, and what it says when it cannot decode.

The chain is PyAV → system ffmpeg → the stdlib `wave` reader, and the *message* it
raises when all three miss is the part worth a test. The studio spent a long time
telling people to install a dependency they already had, because every failure was
reported as "the extra is missing"; these tests pin the two cases apart.
"""

from __future__ import annotations

import sys

import pytest

from audio_studio import media
from audio_studio.media import MediaError, MissingDependency, load_audio


@pytest.fixture()
def mp3(tmp_path):
    """A file with an MP3 name and MP3-looking bytes, so no fallback claims it."""
    path = tmp_path / "song.mp3"
    path.write_bytes(b"\xff\xfb\x90\x00" + b"\x00" * 128)
    return path


def test_a_broken_decoder_is_not_reported_as_a_missing_dependency(mp3, monkeypatch):
    """
    The exact failure that cost this project hours: `av` installed, newer than
    faster-whisper knows, so `av.open()` no longer takes the keyword it passes. The
    old message blamed the missing `[asr]` extra, which was already installed — so the
    advice could not fix it and looked like it should have.
    """
    import faster_whisper

    def broken(*args, **kwargs):
        raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")

    monkeypatch.setattr(faster_whisper, "decode_audio", broken)
    monkeypatch.setattr(media, "has_ffmpeg", lambda: False)

    with pytest.raises(MediaError) as caught:
        load_audio(mp3, decode=True)

    assert not isinstance(caught.value, MissingDependency), "the extra is installed; do not say it is missing"
    message = str(caught.value)
    assert "metadata_errors" in message, "the real exception has to survive into the message"
    assert "av<19" in message, "and the fix has to be named"
    assert "doctor" in message, "and how to confirm it"


def test_an_absent_decoder_still_points_at_the_extra(mp3, monkeypatch):
    """With no PyAV at all, the old advice is the right advice, and it stays."""
    monkeypatch.setitem(sys.modules, "faster_whisper", None)  # `from ... import` raises
    monkeypatch.setattr(media, "has_ffmpeg", lambda: False)

    with pytest.raises(MissingDependency) as caught:
        load_audio(mp3, decode=True)

    assert "asr" in str(caught.value)
    assert "ffmpeg" in str(caught.value)


def test_ffmpeg_is_still_tried_before_giving_up(mp3, monkeypatch):
    """
    A broken PyAV must not cost the one fallback that can still decode the file: the
    chain is what makes the studio work on a machine with ffmpeg and no wheels.
    """
    import numpy as np
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "decode_audio", lambda *a, **k: (_ for _ in ()).throw(TypeError("boom")))
    monkeypatch.setattr(media, "has_ffmpeg", lambda: True)
    monkeypatch.setattr(
        media, "decode_with_ffmpeg", lambda path, rate: np.zeros(rate, dtype="<f4").tobytes()
    )

    audio = load_audio(mp3, decode=True)

    assert audio.decoded_by == "ffmpeg"
    assert audio.duration == pytest.approx(1.0)
    assert audio.warnings and "boom" in audio.warnings[0], "the PyAV failure is still recorded"


def test_a_file_that_does_not_exist_is_named(tmp_path):
    with pytest.raises(MediaError, match="not found"):
        load_audio(tmp_path / "nope.mp3", decode=True)
