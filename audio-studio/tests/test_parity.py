"""parity.py — one clip, every stage, one hash per stage.

The point of the command is that two machines can be compared without either of
them being present, so the tests are about the report's two jobs: it must cover
every stage, and a stage that cannot run must be *inside* the report rather than
an exception that loses the rest of it.
"""

from __future__ import annotations

from array import array
from pathlib import Path

import numpy as np
import pytest

from audio_studio import parity
from audio_studio.align.wav2vec import _Emissions
from audio_studio.media import Audio
from audio_studio.model import Segment, Transcript, Word


def _audio(path, samples=None) -> Audio:
    return Audio(
        path=Path(path),
        samples=np.zeros(16000 * 2, dtype="float32") if samples is None else samples,
        sample_rate=16000,
        duration=2.0,
        sha256="f" * 64,
        decoded_by="test",
    )


def _transcript() -> Transcript:
    return Transcript.from_segments(
        [
            Segment(
                start=0.0,
                end=1.0,
                words=[Word(text="hello", start=0.0, end=0.5), Word(text="world", start=0.5, end=1.0)],
                text="hello world",
            )
        ],
        duration=2.0,
    )


class _Engine:
    name = "whisper"

    def available(self):
        return True, "stub"

    def transcribe(self, audio, options, on_progress=None):
        return _transcript()


def _wire(monkeypatch, *, engine=None, emissions=None):
    monkeypatch.setattr(parity, "load_audio", lambda path, decode=True: _audio(path))
    # The weights stage would read whatever this machine happens to have; the test is about
    # the report's shape, and a test that hashes 464 MB is a test people stop running.
    monkeypatch.setattr(
        parity.fingerprint,
        "weights_digest",
        lambda *a, **k: {"repo": "stub", "revision": "c" * 40, "source": "store", "sha256": "m" * 64},
    )
    monkeypatch.setattr("audio_studio.engines.get_engine", lambda name: engine or _Engine())
    monkeypatch.setattr(
        "audio_studio.align.wav2vec._load",
        lambda model, device: (object(), {}, 0, 1, 320, 16000),
    )
    monkeypatch.setattr(
        parity,
        "compute_emissions",
        lambda samples, model, device="cpu": emissions
        or _Emissions(5, 3, array("d", [0.0, 0.1, 0.2] * 5)),
    )

    def align(transcript, audio, options, backend):
        transcript.alignment = {
            "aligner": "wav2vec",
            "segments": 1,
            "segmentsAligned": 1,
            "segmentsKept": 0,
            "meanConfidence": 0.5,
            "meanShift": 0.1,
            "weightsSha256": "w" * 64,
        }
        return transcript

    monkeypatch.setattr("audio_studio.align.align_transcript", align)


def test_every_stage_is_in_the_report(monkeypatch, tmp_path):
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF")
    _wire(monkeypatch)

    report = parity.run_parity(clip, seconds=2.0)
    assert report["source"]["file"] == "clip.wav"
    assert report["pcm"]["samples"] == 32000
    assert report["transcript"]["words"] == 2
    assert report["transcript"]["first"] == "hello world"
    assert report["emissions"]["frames"] == 5
    assert report["alignment"]["words"] == 2
    assert report["alignment"]["weightsSha256"] == "w" * 64
    assert report["warnings"] == []
    for stage in ("source", "pcm", "weights", "transcript", "emissions", "alignment"):
        assert isinstance(report[stage], dict), f"{stage} is missing from the parity report"


def test_the_same_clip_hashes_the_same_twice(monkeypatch, tmp_path):
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF")
    _wire(monkeypatch)

    first = parity.run_parity(clip, seconds=2.0)
    second = parity.run_parity(clip, seconds=2.0)
    for stage in ("pcm", "transcript", "emissions", "alignment"):
        assert first[stage]["sha256"] == second[stage]["sha256"]
    assert first["pcm"]["sha256"] == second["pcm"]["sha256"]


def test_different_samples_change_the_stage_they_belong_to(monkeypatch, tmp_path):
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF")
    _wire(monkeypatch)
    quiet = parity.run_parity(clip, seconds=2.0)

    samples = np.zeros(16000 * 2, dtype="float32")
    samples[10] = 0.25
    monkeypatch.setattr(parity, "load_audio", lambda path, decode=True: _audio(path, samples))
    loud = parity.run_parity(clip, seconds=2.0)

    assert quiet["pcm"]["sha256"] != loud["pcm"]["sha256"], "the PCM stage must see the samples"


def test_a_stage_that_cannot_run_is_reported_not_raised(monkeypatch, tmp_path):
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF")

    class _Missing(_Engine):
        def available(self):
            return False, "faster-whisper is not installed"

    _wire(monkeypatch, engine=_Missing())
    report = parity.run_parity(clip, seconds=2.0)

    assert report["transcript"] is None
    assert any(
        "transcription stage could not run: faster-whisper is not installed" in warning
        for warning in report["warnings"]
    )
    # The stages that do not depend on Whisper still ran: that is the comparison a machine
    # missing an extra can still contribute.
    assert report["pcm"]["sha256"]
    assert report["emissions"]["sha256"]


def test_a_stage_failure_with_no_message_still_names_the_exception(monkeypatch, tmp_path):
    """
    "could not run: " with nothing after it is a report line that costs a debugging round.

    Some library failures arrive with an empty message - a bare ``OSError`` from a mapping
    that could not be made - and the type is then the only thing the report can say.
    """
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF")

    class _Bare(_Engine):
        def transcribe(self, *args, **kwargs):
            raise OSError()

    _wire(monkeypatch, engine=_Bare())
    report = parity.run_parity(clip, seconds=2.0)

    warning = next(w for w in report["warnings"] if "transcription stage could not run" in w)
    assert warning == "transcription stage could not run: OSError"


def test_audio_that_was_never_decoded_is_an_error(monkeypatch, tmp_path):
    clip = tmp_path / "clip.wav"
    clip.write_bytes(b"RIFF")
    monkeypatch.setattr(
        parity,
        "load_audio",
        lambda path, decode=True: Audio(path=Path(path), samples=None, sample_rate=16000, duration=2.0),
    )
    with pytest.raises(parity.ParityError):
        parity.run_parity(clip)
