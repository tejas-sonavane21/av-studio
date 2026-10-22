"""engines/ — the backend interface, the deterministic fake, and lazy imports."""

from __future__ import annotations

import subprocess
import sys
import types
from pathlib import Path

import pytest

from audio_studio.config import (
    DEFAULT_MODEL,
    DEFAULT_PRESET,
    PRESETS,
    TranscribeOptions,
    options_from_preset,
)
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
# what a run is about to do with the weights
# --------------------------------------------------------------------------- #


def _cached_model(root: Path, model_id: str) -> None:
    """
    Lay out a hub cache entry the way the hub does: ``snapshots/<rev>/model.bin``.

    At the commit the catalogue pins, not an invented one: the loader is handed *that* pin,
    so these fixtures describe the cache a real machine would actually hit.
    """
    from audio_studio import models as catalogue

    revision = catalogue.revision_for(model_id) or ("b" * 40)
    directory = root / catalogue.repo_cache_name(catalogue.MODELS[model_id]["repo"]) / "snapshots" / revision
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "model.bin").write_bytes(b"")


def test_a_cached_model_is_read_from_disk_and_the_hub_is_not_asked(tmp_path):
    """
    The guarantee this exists for: weights that are already here are never fetched again.

    ``localOnly`` is what carries it into the loader — without it the hub resolves the
    cached snapshot over the network on every process, which is the round-trip that reads
    to a person as "it is downloading the model again".
    """
    from audio_studio.engines.whisper import load_plan

    _cached_model(tmp_path, "small")
    plan = load_plan("small", root=tmp_path)
    assert plan["downloaded"] is True
    assert plan["localOnly"] is True
    assert "already on this machine" in plan["message"]
    assert "no download" in plan["message"]


def test_a_missing_model_says_it_is_fetching_once(tmp_path):
    from audio_studio.engines.whisper import load_plan

    plan = load_plan("medium", root=tmp_path)
    assert plan["downloaded"] is False
    assert plan["localOnly"] is False
    assert plan["repo"] == "Systran/faster-whisper-medium"
    assert "once" in plan["message"]
    assert "769 M" in plan["message"]


def test_an_uncatalogued_name_is_loaded_but_never_told_to_stay_offline(tmp_path):
    """A local path or a hub id we do not know may be local; nothing is assumed about it."""
    from audio_studio.engines.whisper import load_plan

    plan = load_plan("some-org/their-whisper", root=tmp_path)
    assert plan["downloaded"] is None
    assert plan["localOnly"] is False
    assert "some-org/their-whisper" in plan["message"]


def test_an_empty_snapshot_is_a_download_not_a_cache_hit(tmp_path):
    """A half-finished fetch must not be mistaken for weights that are already here."""
    from audio_studio import models as catalogue
    from audio_studio.engines.whisper import load_plan

    (tmp_path / catalogue.repo_cache_name("Systran/faster-whisper-small") / "snapshots" / "c").mkdir(parents=True)
    plan = load_plan("small", root=tmp_path)
    assert plan["downloaded"] is False
    assert plan["localOnly"] is False


def test_the_plan_hands_the_loader_the_verified_commit(tmp_path):
    """
    A plan that named the model but not the weights would leave the hub to choose them.

    The revision is returned by the plan rather than looked up again at load time, so what a
    person is told and what is loaded cannot disagree — which is the whole point of pinning.
    """
    from audio_studio import models as catalogue
    from audio_studio.engines.whisper import load_plan

    _cached_model(tmp_path, "small")
    plan = load_plan("small", root=tmp_path)
    assert plan["revision"] == catalogue.MODELS["small"]["revision"]
    assert len(plan["revision"]) == 40


def test_a_model_nothing_verified_is_planned_without_a_pin(tmp_path):
    """A local path or an unknown hub id must still load: there is just nothing to pin it to."""
    from audio_studio.engines.whisper import load_plan

    assert load_plan("some-org/their-whisper", root=tmp_path)["revision"] is None
    assert load_plan("medium", root=tmp_path)["revision"] is not None


# --------------------------------------------------------------------------- #
# a pin the hub no longer has
# --------------------------------------------------------------------------- #

PIN = "536b0662742c02347bc0e980a01041f333bce120"


class RevisionNotFoundError(Exception):
    """The hub's own name for "that commit is not there any more"."""


def _stub_faster_whisper(monkeypatch, construct):
    """
    A ``faster_whisper`` whose ``WhisperModel`` is ours, so the loader's decisions are testable.

    The library is imported *inside* the loader - that is what keeps an optional backend out of
    `import audio_studio` - so it is the import that has to be answered, and a `sys.modules`
    entry is the only way to answer it from a test.
    """
    module = types.ModuleType("faster_whisper")
    module.WhisperModel = construct  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    # The verified store answers before the cache, and the answers are on disk — a machine
    # that has filled its store would otherwise short-circuit every decision these tests are
    # about. `test_modelstore.py` is where the store's own precedence is tested.
    monkeypatch.setattr("audio_studio.engines.whisper.modelstore.require", lambda *a, **k: None)
    return module


def _plan(**overrides) -> dict:
    """The plan `load_plan` would return for a model this machine does not have yet."""
    plan = {
        "name": "small",
        "family": "Whisper small",
        "repo": "Systran/faster-whisper-small",
        "params": "244 M",
        "downloaded": False,
        "localOnly": False,
        "revision": PIN,
        "message": "fetching Whisper small once",
    }
    plan.update(overrides)
    return plan


def test_the_loader_is_handed_the_verified_commit(monkeypatch):
    """A plan that named the model but not the weights would leave the hub to choose them."""
    from audio_studio.engines import whisper as backend

    calls: list[dict] = []
    _stub_faster_whisper(monkeypatch, lambda name, **kwargs: calls.append(kwargs) or object())
    monkeypatch.setattr(backend, "load_plan", lambda name: _plan())
    backend.clear_cache()

    backend._load_model(TranscribeOptions(model="small"))
    assert calls == [{"device": "cpu", "compute_type": "int8", "revision": PIN}]


def test_a_pin_the_hub_no_longer_has_falls_forward_to_main(monkeypatch):
    """
    The pin is a preference for the weights this project measured, not a promise that the hub
    keeps them. A commit that is gone costs one retry - and the run has to say which weights it
    ended up with, because loading different ones is exactly the thing the pin exists to notice.
    """
    from audio_studio.engines import whisper as backend

    asked: list[dict] = []

    def construct(name, **kwargs):
        asked.append(kwargs)
        if kwargs.get("revision"):
            raise RevisionNotFoundError(f"Revision {PIN} not found in Systran/faster-whisper-small")
        return object()

    _stub_faster_whisper(monkeypatch, construct)
    monkeypatch.setattr(backend, "load_plan", lambda name: _plan())
    # What the fetch wrote: the commit `main` resolved to. Read from the cache in a real run.
    monkeypatch.setattr(backend.models, "cached_commit", lambda repo, *args, **kwargs: "c" * 40)
    backend.clear_cache()

    said: list[str] = []
    backend._load_model(TranscribeOptions(model="small"), lambda fraction, message: said.append(message))

    assert ["revision" in kwargs for kwargs in asked] == [True, False], "the pin, then main - once"
    assert any("not on the hub any more" in message for message in said), said
    note = backend.loaded_state()[0]
    assert note["revision"] == "c" * 40, "the artifact names the weights that were actually used"
    assert PIN[:8] in note["revisionNote"], "and the pin it could not have is still on record"


def test_a_failure_that_is_not_about_the_pin_is_not_retried(monkeypatch):
    """A retry that cannot succeed turns one clear error into two, and hides the real one."""
    from audio_studio.engines import whisper as backend

    asked: list[dict] = []

    def construct(name, **kwargs):
        asked.append(kwargs)
        raise ConnectionError("HTTPSConnectionPool(host='huggingface.co'): Max retries exceeded")

    _stub_faster_whisper(monkeypatch, construct)
    monkeypatch.setattr(backend, "load_plan", lambda name: _plan())
    backend.clear_cache()

    with pytest.raises(ConnectionError):
        backend._load_model(TranscribeOptions(model="small"))
    assert len(asked) == 1


def test_an_unpinned_model_is_never_retried_either(monkeypatch):
    """There is no pin to lose, so a failure is the failure - even one that mentions a revision."""
    from audio_studio.engines import whisper as backend

    asked: list[dict] = []

    def construct(name, **kwargs):
        asked.append(kwargs)
        raise RevisionNotFoundError("Revision not found")

    _stub_faster_whisper(monkeypatch, construct)
    monkeypatch.setattr(backend, "load_plan", lambda name: _plan(revision=None))
    backend.clear_cache()

    with pytest.raises(RevisionNotFoundError):
        backend._load_model(TranscribeOptions(model="some-org/their-whisper"))
    assert len(asked) == 1


def test_a_fallback_run_says_so_in_the_transcript_it_produces(monkeypatch):
    """
    A warning rather than a log line: these words did not come out of the measured weights, and a
    transcript has to carry that with it - the terminal of the run that made it is long gone by
    the time somebody asks why two machines disagree.
    """
    from audio_studio.engines import whisper as backend

    class Segment:
        start, end, text, words = 0.0, 1.0, " hi", []

    class Info:
        language, duration, language_probability = "en", 5.0, 1.0

    class Model:
        def transcribe(self, source, **kwargs):
            return [Segment()], Info()

    def construct(name, **kwargs):
        if kwargs.get("revision"):
            raise RevisionNotFoundError(f"Revision {PIN} not found")
        return Model()

    _stub_faster_whisper(monkeypatch, construct)
    monkeypatch.setattr(backend, "load_plan", lambda name: _plan())
    monkeypatch.setattr(backend.models, "cached_commit", lambda repo, *args, **kwargs: "c" * 40)
    backend.clear_cache()

    transcript = backend.WhisperEngine().transcribe(silent_audio(5.0), TranscribeOptions(model="small"))
    assert transcript.engine["modelRevision"] == "c" * 40
    assert "not on the hub any more" in transcript.engine["modelRevisionFallback"]
    assert any("may not reproduce" in warning for warning in transcript.warnings), transcript.warnings
    backend.clear_cache()


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


def test_english_defaults_to_the_cpu_viable_model():
    # Measured: distil-large-v3 runs below 0.1x realtime on a 4-core CPU, and
    # base garbles lyrics, so small is the default that actually finishes.
    assert TranscribeOptions().resolved_model() == DEFAULT_MODEL
    assert DEFAULT_MODEL == "small"


def test_vad_is_off_by_default():
    # VAD deletes sung vocals: 224 words -> 2 on the real fixture. It is only
    # correct for spoken-word audio, so it must be opt-in.
    assert TranscribeOptions().vad_filter is False
    assert all(not preset["vad_filter"] for preset in PRESETS.values())


def test_the_default_preset_is_the_balanced_one():
    assert DEFAULT_PRESET == "balanced"
    options = options_from_preset()
    assert options.resolved_model() == "small"
    assert options.preset == "balanced"


def test_a_non_english_language_switches_to_the_multilingual_model():
    assert TranscribeOptions(language="de").resolved_model() == "medium"


def test_an_explicit_model_always_wins():
    assert TranscribeOptions(model="small", language="de").resolved_model() == "small"
