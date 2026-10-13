"""
test_models.py — the model catalogue, and the cache check that makes it useful.

Three things are worth testing here, and each one has already cost this project time:

* that the catalogue's short names are the ones the installed ``faster-whisper``
  actually resolves — a typo there fails at run time, minutes into a job, with a hub
  error that names neither the preset nor the file;
* that every preset a user can pick has a model the catalogue can describe, so the
  panel can always say what will run;
* that the download check reads the hub's own directory layout, including the two
  ways it goes wrong — an empty cache and a half-finished fetch — because reporting a
  model as present when it is not is the failure this module exists to prevent.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from audio_studio import models
from audio_studio.config import PRESETS


def _make_cache(root: Path, repo: str, *, files: tuple[str, ...] = ("model.bin",)) -> Path:
    """Lay out a hub cache entry the way the hub does: ``snapshots/<rev>/<files>``."""
    directory = root / models.repo_cache_name(repo) / "snapshots" / ("a" * 40)
    directory.mkdir(parents=True, exist_ok=True)
    for name in files:
        (directory / name).write_bytes(b"")
    return directory


def test_every_preset_names_a_model_the_catalogue_knows():
    for preset in PRESETS.values():
        assert preset["model"] in models.MODELS, f"{preset['model']} is not in the catalogue"


def test_the_catalogue_agrees_with_the_installed_library():
    """The short names are the library's, not ours. A rename upstream must fail here, not in a run."""
    faster_whisper_utils = pytest.importorskip("faster_whisper.utils")
    for model_id, entry in models.MODELS.items():
        assert faster_whisper_utils._MODELS.get(model_id) == entry["repo"]


def test_the_repo_cache_name_is_the_hubs_own_spelling():
    assert models.repo_cache_name("Systran/faster-whisper-small") == "models--Systran--faster-whisper-small"


def test_a_model_that_is_cached_reads_as_downloaded(tmp_path):
    _make_cache(tmp_path, models.MODELS["small"]["repo"])
    assert models.is_downloaded("small", root=tmp_path) is True


def test_an_empty_snapshot_is_not_a_downloaded_model(tmp_path):
    """An interrupted fetch leaves the directory behind; it must not read as present."""
    _make_cache(tmp_path, models.MODELS["base"]["repo"], files=())
    assert models.is_downloaded("base", root=tmp_path) is False


def test_an_absent_model_reads_as_not_downloaded(tmp_path):
    assert models.is_downloaded("medium", root=tmp_path) is False


def test_an_unknown_name_is_unknown_rather_than_absent(tmp_path):
    """``None`` and ``False`` are different answers: a hub id we cannot describe may still be on disk."""
    assert models.is_downloaded("some-org/their-whisper", root=tmp_path) is None
    row = models.describe("some-org/their-whisper", root=tmp_path)
    assert row["known"] is False
    assert row["downloaded"] is None
    assert row["repo"] == "some-org/their-whisper"


def test_the_cache_location_follows_the_hub_environment(tmp_path):
    assert models.cache_dir({}) == Path.home() / ".cache" / "huggingface" / "hub"
    assert models.cache_dir({"HF_HOME": str(tmp_path)}) == tmp_path / "hub"
    explicit = tmp_path / "elsewhere"
    assert models.cache_dir({"HUGGINGFACE_HUB_CACHE": str(explicit), "HF_HOME": str(tmp_path)}) == explicit


def test_a_model_is_looked_for_in_the_cache_the_environment_names(tmp_path):
    root = tmp_path / "hub"
    _make_cache(root, models.MODELS["distil-large-v3"]["repo"])
    assert models.is_downloaded("distil-large-v3", env={"HF_HOME": str(tmp_path)}) is True


def test_preset_details_keep_the_order_presets_are_written_in():
    """Quickest → best is the menu, and sorting it alphabetically would bury the default."""
    rows = models.preset_details(PRESETS)
    assert [row["id"] for row in rows] == list(PRESETS)
    assert rows[-1]["id"] == "best", "the most expensive preset is offered last, not first"
    assert "balanced" in [row["id"] for row in rows]


def test_preset_details_name_a_model_a_person_can_recognise():
    rows = {row["id"]: row for row in models.preset_details(PRESETS)}
    assert rows["best"]["modelName"] == "distil-whisper large-v3"
    assert rows["best"]["repo"] == "Systran/faster-distil-whisper-large-v3"
    assert rows["balanced"]["modelName"] == "Whisper small"
    # every preset carries a one-line answer to "why would I pick this?"
    assert all(row["note"] for row in rows.values())


def test_describe_model_reads_like_a_sentence():
    assert models.describe_model("small") == "Whisper small (Systran/faster-whisper-small, 244 M)"
    assert models.describe_model("not-a-model") == "not-a-model"
    assert models.describe_preset("balanced", PRESETS).startswith("balanced → Whisper small")
