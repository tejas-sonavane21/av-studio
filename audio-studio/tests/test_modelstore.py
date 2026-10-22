"""modelstore.py — the verified copy of the weights, used instead of the hub.

The store exists for one reason: "same model" has to mean the same bytes on every
machine. So these tests are about the three ways that could quietly stop being
true — a copy that lost a file, a tampered file that still loads, and a second
import silently replacing verified weights — plus the loaders actually reading
from the store instead of the hub.
"""

from __future__ import annotations

import sys
import types

import pytest

from audio_studio import fingerprint, modelstore, models
from audio_studio.config import TranscribeOptions

PIN = models.revision_for("small")


def _source(tmp_path, files: dict | None = None):
    directory = tmp_path / "source"
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in (files or {"model.bin": b"weights", "config.json": b"{}"}).items():
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return directory


def _import(tmp_path, files: dict | None = None, **kwargs):
    source = _source(tmp_path, files)
    return modelstore.import_model("small", source, store=tmp_path / "store", **kwargs)


# --------------------------------------------------------------------------- #
# import and verify
# --------------------------------------------------------------------------- #


def test_an_imported_model_verifies(tmp_path):
    result = _import(tmp_path)
    assert result["status"] == "imported"
    assert result["sha256"] == fingerprint.directory_digest(tmp_path / "source")["sha256"]

    verdict = modelstore.verify("small", store=tmp_path / "store")
    assert verdict["present"] and verdict["ok"]
    assert verdict["error"] is None
    assert verdict["sha256"] == result["sha256"]


def test_the_store_digest_is_the_same_number_as_the_cache_digest(tmp_path):
    """A store copy and a cache copy of the same files must be comparable — that is the point."""
    _import(tmp_path)
    from_store = modelstore.verify("small", store=tmp_path / "store")["sha256"]
    from_source = fingerprint.directory_digest(tmp_path / "source")["sha256"]
    assert from_store == from_source


def test_a_tampered_file_is_named(tmp_path):
    _import(tmp_path)
    stored = tmp_path / "store" / models.repo_cache_name("Systran/faster-whisper-small") / PIN
    (stored / "model.bin").write_bytes(b"weightz")

    verdict = modelstore.verify("small", store=tmp_path / "store")
    assert not verdict["ok"]
    assert verdict["mismatched"] == ["model.bin"]
    assert "manifest" in verdict["error"]


def test_a_missing_file_is_named_too(tmp_path):
    _import(tmp_path)
    stored = tmp_path / "store" / models.repo_cache_name("Systran/faster-whisper-small") / PIN
    (stored / "config.json").unlink()

    verdict = modelstore.verify("small", store=tmp_path / "store")
    assert not verdict["ok"]
    assert verdict["missing"] == ["config.json"]


def test_a_directory_without_a_manifest_is_not_a_store(tmp_path):
    stored = tmp_path / "store" / models.repo_cache_name("Systran/faster-whisper-small") / PIN
    stored.mkdir(parents=True)
    (stored / "model.bin").write_bytes(b"weights")

    verdict = modelstore.verify("small", store=tmp_path / "store")
    assert verdict["present"] and not verdict["ok"]
    assert "no manifest" in verdict["error"]


def test_an_absent_model_is_absent_not_broken(tmp_path):
    verdict = modelstore.verify("small", store=tmp_path / "store")
    assert not verdict["present"] and not verdict["ok"]
    assert "not in the store" in verdict["error"]


# --------------------------------------------------------------------------- #
# the write-once rule
# --------------------------------------------------------------------------- #


def test_importing_the_same_bytes_again_is_a_no_op(tmp_path):
    _import(tmp_path)
    again = modelstore.import_model("small", _source(tmp_path), store=tmp_path / "store")
    assert again["status"] == "already"


def test_importing_different_bytes_under_the_same_commit_is_refused(tmp_path):
    """
    This is the divergence the store exists to rule out: two sets of weights claiming to
    be the same commit. Nothing here may pick one silently.
    """
    _import(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    (other / "model.bin").write_bytes(b"WEIGHTS")
    (other / "config.json").write_bytes(b"{}")

    with pytest.raises(modelstore.ModelStoreError) as caught:
        modelstore.import_model("small", other, store=tmp_path / "store")
    assert "different set of files" in str(caught.value)

    # ...and the verified copy is untouched.
    assert modelstore.verify("small", store=tmp_path / "store")["ok"]


def test_overwrite_is_explicit_and_replaces_it(tmp_path):
    _import(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    (other / "model.bin").write_bytes(b"WEIGHTS")
    (other / "config.json").write_bytes(b"{}")

    result = modelstore.import_model("small", other, store=tmp_path / "store", overwrite=True)
    assert result["status"] == "imported"
    assert modelstore.verify("small", store=tmp_path / "store")["ok"]


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #


def test_require_raises_instead_of_falling_back(tmp_path):
    _import(tmp_path)
    stored = tmp_path / "store" / models.repo_cache_name("Systran/faster-whisper-small") / PIN
    (stored / "model.bin").write_bytes(b"weightz")
    with pytest.raises(modelstore.ModelStoreError) as caught:
        modelstore.require("small", store=tmp_path / "store")
    assert "does not verify" in str(caught.value)


def test_require_returns_none_when_the_model_was_never_stored(tmp_path):
    assert modelstore.require("small", store=tmp_path / "store") is None


def test_the_fingerprint_prefers_the_store(tmp_path):
    _import(tmp_path)
    digest = fingerprint.weights_digest("small", store=tmp_path / "store", root=tmp_path / "cache")
    assert digest["source"] == "store"
    assert digest["sha256"] == fingerprint.directory_digest(tmp_path / "source")["sha256"]


def test_the_transcriber_loads_the_store_and_never_the_hub(tmp_path, monkeypatch):
    from audio_studio.engines import whisper as backend

    stored = tmp_path / "store" / "stored-model"
    stored.mkdir(parents=True)
    monkeypatch.setattr(backend.modelstore, "require", lambda model_id, **kwargs: stored)

    calls: list[dict] = []
    module = types.ModuleType("faster_whisper")
    module.WhisperModel = lambda name, **kwargs: calls.append({"name": name, **kwargs}) or object()
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    monkeypatch.setattr(backend, "load_plan", lambda name: {
        "name": name, "family": "Whisper small", "repo": "Systran/faster-whisper-small",
        "params": "", "downloaded": False, "localOnly": False, "revision": PIN,
        "message": "would fetch",
    })
    # The provenance hash would read the real store; the test is about which *path* the
    # loader hands the library, so the hash is stubbed and asserted separately.
    monkeypatch.setattr(backend.fingerprint, "weights_digest", lambda *a, **k: {"sha256": "h" * 64})
    backend.clear_cache()

    backend._load_model(TranscribeOptions(model="small"))
    assert calls == [{"name": str(stored), "device": "cpu", "compute_type": "int8"}]
    assert backend.loaded_state()[0]["source"] == "store"


def test_the_aligner_loads_the_store_and_never_the_hub(tmp_path, monkeypatch):
    from audio_studio.align import wav2vec

    stored = tmp_path / "stored-aligner"
    stored.mkdir()
    monkeypatch.setattr(wav2vec.modelstore, "require", lambda model_id, **kwargs: stored)

    asked: list[str] = []

    class _Model:
        def to(self, device):
            return self

        def eval(self):
            return self

    module = types.ModuleType("transformers")
    module.AutoTokenizer = types.SimpleNamespace(
        from_pretrained=lambda name, **kwargs: asked.append(name) or object()
    )
    module.Wav2Vec2ForCTC = types.SimpleNamespace(
        from_pretrained=lambda name, **kwargs: asked.append(name) or _Model()
    )
    monkeypatch.setitem(sys.modules, "transformers", module)
    wav2vec.clear_cache()

    wav2vec._load_pair(models.ALIGN_MODEL, models.ALIGN_REVISION, "cpu")
    assert asked == [str(stored), str(stored)]


# --------------------------------------------------------------------------- #
# inventory
# --------------------------------------------------------------------------- #


def test_inventory_lists_what_is_missing_without_hashing_anything(tmp_path):
    rows = modelstore.inventory(store=tmp_path / "store")
    assert {row["model"] for row in rows} == set(modelstore.known_models())
    assert all(row["present"] is False and row["ok"] is None for row in rows)


def test_inventory_verifies_when_asked(tmp_path):
    _import(tmp_path)
    rows = modelstore.inventory(store=tmp_path / "store", check=True)
    small = next(row for row in rows if row["model"] == "small")
    assert small["present"] and small["ok"] is True
    assert small["sha256"] == fingerprint.directory_digest(tmp_path / "source")["sha256"]
