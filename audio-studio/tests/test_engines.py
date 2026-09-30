"""engines/ — the backend interface, the deterministic fake, and lazy imports."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from audio_studio.config import TranscribeOptions
from audio_studio.engines import available_engines, engine_names, get_engine
from audio_studio.engines.fake import apportion
from audio_studio.media import Audio
from audio_studio.model import validate

ROOT = Path(__file__).resolve().parent.parent


def silent_audio(duration: float = 20.0) -> Audio:
    return Audio(path=None, samples=None, sample_rate=16000, duration=duration, sha256="")


# --------------------------------------------------------------------------- #
# the registry must never import a heavy backend just to be asked about it
# --------------------------------------------------------------------------- #


def test_importing_the_package_pulls_in_no_optional_backend():
    """
    The base install is ``pip install -e .`` and nothing else. If importing the
    package required torch or faster-whisper, the model, the emitters and the
    CLI would all stop working on a machine without them.
    """
    code = (
        "import sys, audio_studio, audio_studio.cli, audio_studio.engines\n"
        "heavy = [m for m in ('faster_whisper', 'torch', 'numpy', 'google.genai') if m in sys.modules]\n"
        "assert not heavy, heavy\n"
        "print('ok')\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_engine_names_include_the_local_and_the_offline_backend():
    assert engine_names() == ["fake", "whisper"]


def test_get_engine_returns_a_usable_object():
    engine = get_engine("fake")
    assert engine.name == "fake"
    assert engine.available() == (True, "built in (deterministic, no model)")


def test_unknown_engine_is_a_clear_error():
    with pytest.raises(ValueError, match="unknown engine"):
        get_engine("elevenlabs")


def test_available_engines_reports_rather_than_raises():
    """``doctor`` has to work on a machine where nothing is installed yet."""
    report = {entry["name"]: entry for entry in available_engines()}
    assert report["fake"]["available"] is True
    assert "whisper" in report
    assert isinstance(report["whisper"]["available"], bool)
    assert report["whisper"]["reason"]


# --------------------------------------------------------------------------- #
# apportion
# --------------------------------------------------------------------------- #


def test_apportion_divides_proportionally_and_ends_exactly_on_end():
    slots = apportion(0.0, 6.0, ["a", "bb", "ccc"])  # weights 1:2:3
    assert slots == [(0.0, 1.0), (1.0, 3.0), (3.0, 6.0)]


def test_apportion_slots_are_contiguous():
    slots = apportion(1.0, 5.0, ["hello", "there", "world", "again"])
    for left, right in zip(slots, slots[1:]):
        assert left[1] == right[0]
    assert slots[-1][1] == 5.0
    assert slots[0][0] == 1.0


def test_apportion_handles_degenerate_input():
    assert apportion(0.0, 1.0, []) == []
    assert apportion(2.0, 3.0, ["solo"]) == [(2.0, 3.0)]
    assert apportion(5.0, 5.0, ["a", "b"]) == [(5.0, 5.0), (5.0, 5.0)]


# --------------------------------------------------------------------------- #
# the fake engine
# --------------------------------------------------------------------------- #


def test_fake_engine_is_deterministic():
    engine = get_engine("fake")
    first = engine.transcribe(silent_audio(), TranscribeOptions())
    second = engine.transcribe(silent_audio(), TranscribeOptions())
    assert first.to_dict() == second.to_dict()


def test_fake_engine_output_satisfies_every_invariant():
    transcript = get_engine("fake").transcribe(silent_audio(30.0), TranscribeOptions())
    report = validate(transcript)
    assert report["errors"] == []
    assert transcript.segments and transcript.word_count > 0


def test_fake_engine_keeps_words_inside_their_segment():
    transcript = get_engine("fake").transcribe(silent_audio(20.0), TranscribeOptions())
    for segment in transcript.segments:
        assert segment.words
        assert segment.text == " ".join(w.text for w in segment.words)
        for word in segment.words:
            assert segment.start <= word.start <= word.end <= segment.end


def test_fake_engine_never_overruns_the_audio():
    transcript = get_engine("fake").transcribe(silent_audio(3.0), TranscribeOptions())
    assert all(segment.end <= 3.0 for segment in transcript.segments)


def test_fake_engine_records_that_it_is_not_a_real_transcription():
    transcript = get_engine("fake").transcribe(silent_audio(), TranscribeOptions())
    assert transcript.engine["name"] == "fake"
    assert "not a transcription" in transcript.engine["note"]


def test_fake_engine_accepts_a_custom_script():
    options = TranscribeOptions(extra={"lines": ["one two three"]})
    transcript = get_engine("fake").transcribe(silent_audio(10.0), options, None)
    assert len(transcript.segments) == 1
    assert transcript.segments[0].text == "one two three"


def test_fake_engine_calls_the_progress_hook():
    seen: list[tuple[float, str]] = []
    get_engine("fake").transcribe(silent_audio(), TranscribeOptions(), lambda f, m: seen.append((f, m)))
    assert seen and seen[-1][0] == 1.0


# --------------------------------------------------------------------------- #
# options
# --------------------------------------------------------------------------- #


def test_english_defaults_to_the_distilled_model():
    assert TranscribeOptions().resolved_model() == "distil-large-v3"


def test_a_non_english_language_switches_to_the_multilingual_model():
    assert TranscribeOptions(language="de").resolved_model() == "medium"


def test_an_explicit_model_always_wins():
    assert TranscribeOptions(model="small", language="de").resolved_model() == "small"
