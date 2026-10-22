"""fingerprint.py — the hashes that let two machines be compared.

These are the numbers a "it is worse on my laptop" thread turns into a fact, so
the tests are about the two ways such a tool lies: a hash that does not change
when the thing changes, and a hash that changes when it should not.
"""

from __future__ import annotations

import numpy as np
import pytest

from audio_studio import fingerprint, models

COMMIT = "a" * 40


def _fake_cache(root, model_id: str, files: dict | None = None):
    """
    A hub cache laid out the way the hub lays one out: `refs/main` plus a snapshot at the
    commit the catalogue would ask for, which is the snapshot a loader here would load.
    """
    repo = (models.MODELS.get(model_id) or {}).get("repo", model_id)
    commit = models.revision_for(model_id) or COMMIT
    directory = root / models.repo_cache_name(repo)
    (directory / "refs").mkdir(parents=True, exist_ok=True)
    (directory / "refs" / "main").write_text(commit + "\n", encoding="utf-8")
    snapshot = directory / "snapshots" / commit
    snapshot.mkdir(parents=True, exist_ok=True)
    for name, data in (files or {"model.bin": b"weights", "config.json": b"{}"}).items():
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return snapshot, commit


# --------------------------------------------------------------------------- #
# samples
# --------------------------------------------------------------------------- #


def test_the_pcm_hash_follows_the_samples_not_the_container():
    a = np.zeros(16000, dtype="float32")
    b = a.copy()
    b[1] = 0.5
    assert fingerprint.samples_digest(a)["sha256"] != fingerprint.samples_digest(b)["sha256"]
    # Same samples, different buffer plumbing: the same answer.
    assert fingerprint.samples_digest(a)["sha256"] == fingerprint.samples_digest(list(a))["sha256"]


def test_undecoded_audio_has_no_pcm_hash():
    # `None` and "hash of silence" are different records, and only one of them is a bug.
    assert fingerprint.samples_digest(None) is None


def test_the_pcm_hash_says_what_it_hashed():
    digest = fingerprint.samples_digest(np.zeros(100, dtype="float32"))
    assert digest["samples"] == 100 and digest["dtype"] == "<f4"


# --------------------------------------------------------------------------- #
# weights
# --------------------------------------------------------------------------- #


def test_the_weights_hash_is_the_files_on_disk(tmp_path):
    _, commit = _fake_cache(tmp_path, "small")
    digest = fingerprint.weights_digest("small", root=tmp_path, store=tmp_path / "store")
    assert digest["revision"] == commit == models.revision_for("small")
    assert digest["files"] == 2
    assert digest["bytes"] == len(b"weights") + len(b"{}")
    assert len(digest["sha256"]) == 64
    assert "error" not in digest


def test_one_changed_byte_changes_the_weights_hash(tmp_path):
    snapshot, _ = _fake_cache(tmp_path, "small")
    before = fingerprint.weights_digest("small", root=tmp_path, store=tmp_path / "store")["sha256"]
    (snapshot / "model.bin").write_bytes(b"weightz")  # one byte, same length
    after = fingerprint.weights_digest("small", root=tmp_path, store=tmp_path / "store")["sha256"]
    assert before != after, "a hash that ignores the weights is a hash that answers nothing"


def test_a_snapshot_that_is_not_here_is_an_error_not_an_exception(tmp_path):
    _fake_cache(tmp_path, "small")
    digest = fingerprint.weights_digest("small", revision="b" * 40, root=tmp_path, store=tmp_path / "store")
    assert digest["sha256"] is None
    assert "not on this machine" in digest["error"]
    # ...and it names the commit that was asked for, which is what makes it diagnosable.
    assert digest["revision"] == "b" * 40


def test_the_aligner_is_hashed_by_its_own_repository(tmp_path):
    _fake_cache(tmp_path, models.ALIGN_MODEL, files={"model.safetensors": b"acoustic"})
    digest = fingerprint.weights_digest(models.ALIGN_MODEL, root=tmp_path, store=tmp_path / "store")
    assert digest["repo"] == models.ALIGN_MODEL
    assert digest["pinned"] == models.ALIGN_REVISION


# --------------------------------------------------------------------------- #
# environment and comparison
# --------------------------------------------------------------------------- #


def test_the_environment_reports_the_arithmetic():
    report = fingerprint.environment()
    assert "cpuCapability" in report  # None on a machine without torch, a name when there is
    assert report["cpuCount"] >= 1
    assert set(report["packages"]) == set(fingerprint.NUMERIC_PACKAGES)
    assert set(report["pins"]) == {"ok", "differs", "missing"}


def test_compare_finds_the_stage_that_diverged():
    left = {"pcm": {"sha256": "a"}, "weights": {"sha256": "b"}, "alignment": {"sha256": "c"}}
    right = {"pcm": {"sha256": "a"}, "weights": {"sha256": "b"}, "alignment": {"sha256": "d"}}
    rows = fingerprint.compare(left, right)
    assert rows == [
        {"stage": "alignment", "field": "sha256", "left": "c", "right": "d"}
    ]


def test_compare_is_silent_when_the_reports_agree():
    report = {"pcm": {"sha256": "a"}, "weights": {"sha256": "b"}}
    assert fingerprint.compare(report, dict(report)) == []


def test_summarise_is_in_pipeline_order():
    report = {
        "alignment": {"sha256": "c"},
        "pcm": {"sha256": "a"},
        "weights": {"sha256": None, "error": "not here"},
    }
    lines = list(fingerprint.summarise(report))
    assert [line.split()[0] for line in lines] == ["pcm", "weights", "alignment"]
    assert "not here" in lines[1]


def test_hashing_a_model_the_catalogue_does_not_know_is_not_an_exception(tmp_path):
    # An unknown id is a hub repository or a local path, and a report has to survive it.
    digest = fingerprint.weights_digest("someone/custom-whisper", root=tmp_path, store=tmp_path / "store")
    assert digest["sha256"] is None
    assert digest["repo"] == "someone/custom-whisper"
