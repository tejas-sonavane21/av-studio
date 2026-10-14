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


def _make_cache(
    root: Path,
    repo: str,
    *,
    files: tuple[str, ...] = ("model.bin",),
    revision: "str | None" = None,
) -> Path:
    """
    Lay out a hub cache entry the way the hub does: ``snapshots/<rev>/<files>``.

    The commit defaults to the one the catalogue *pins* for that repository, because the
    check asks for the verified weights: a fixture that invented its own commit would
    describe a cache the studio is right to ignore. Pass ``revision=`` to lay out a
    different one on purpose.
    """
    commit = revision or models.revision_for(repo) or ("a" * 40)
    directory = root / models.repo_cache_name(repo) / "snapshots" / commit
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


# --------------------------------------------------------------------------- #
# the revision pin
# --------------------------------------------------------------------------- #


def test_a_revision_is_a_commit_or_nothing_at_all():
    """
    A pin is a fact read off a cache, so it is either a full commit or absent.

    A short id, a tag or a guess would be worse than no pin: it looks verified, and the
    loader would hand it to the hub as if somebody had checked it.
    """
    import re

    commit = re.compile(r"\A[0-9a-f]{40}\Z")
    for model_id, entry in models.MODELS.items():
        revision = entry.get("revision")
        assert revision is None or commit.match(revision), f"{model_id}: {revision!r} is not a commit"
    assert commit.match(models.ALIGN_REVISION)


def test_the_models_this_project_verified_are_the_pinned_ones():
    """The four presets and the aligner were all fetched and measured here, so all are pinned."""
    for preset in PRESETS.values():
        assert models.revision_for(preset["model"]), f"{preset['model']} is a preset and must be pinned"
    assert models.revision_for(models.ALIGN_MODEL) == models.ALIGN_REVISION


def test_the_aligner_pin_names_the_checkpoint_the_config_uses():
    """Two spellings of the aligner that drift apart would unpin it silently."""
    from audio_studio.config import DEFAULT_ALIGN_MODEL

    assert models.ALIGN_MODEL == DEFAULT_ALIGN_MODEL


def test_a_pin_is_found_by_short_name_and_by_repository():
    """The transcriber holds a model name; a cache check holding a directory only has the repo."""
    assert models.revision_for("small") == models.MODELS["small"]["revision"]
    assert models.revision_for("Systran/faster-whisper-small") == models.MODELS["small"]["revision"]
    assert models.revision_for(models.ALIGN_MODEL) == models.ALIGN_REVISION


def test_a_model_nothing_verified_has_nothing_pinned():
    """``None`` is the honest answer, and it is what keeps an unknown id working."""
    assert models.revision_for("large-v3") is None
    assert models.revision_for("some-org/their-whisper") is None
    assert models.revision_for("out/some/local/model") is None


def test_a_cache_holding_a_different_commit_is_not_the_pinned_weights(tmp_path):
    """
    The check asks for the *verified* weights, not for a directory with the right name.

    This is the machine the pin exists for: it has these models, from an earlier day, at a
    commit the hub has since moved past. Reporting that as present is how two laptops end up
    on different weights while both say the model is already here.
    """
    _make_cache(tmp_path, models.MODELS["small"]["repo"], revision="f" * 40)
    assert models.is_downloaded("small", root=tmp_path) is False

    _make_cache(tmp_path, models.MODELS["small"]["repo"])  # the verified commit as well
    assert models.is_downloaded("small", root=tmp_path) is True


def test_describe_and_preset_details_report_the_pin(tmp_path):
    """A caller can say which weights a run used, and `doctor` reads it from here."""
    assert models.describe("medium")["revision"] == models.MODELS["medium"]["revision"]
    assert models.describe("some-org/their-whisper")["revision"] is None
    rows = {row["id"]: row for row in models.preset_details(PRESETS)}
    assert rows["balanced"]["revision"] == models.MODELS["small"]["revision"]
    assert rows["accurate"]["revision"] == models.MODELS["medium"]["revision"]


# --------------------------------------------------------------------------- #
# a pin the hub no longer has
# --------------------------------------------------------------------------- #

PIN = models.MODELS["small"]["revision"]


class RevisionNotFoundError(Exception):
    """What huggingface_hub raises for a commit that is not there, by name and by class."""


class RepositoryNotFoundError(Exception):
    """And for a repository that is not there at all - which is a different repair."""


def test_a_commit_the_hub_no_longer_has_is_recognised():
    """
    This is the one failure falling forward to ``main`` repairs, so it has to be told apart
    from the two that look like it in a log.
    """
    assert models.revision_unavailable(RevisionNotFoundError(f"Revision {PIN} not found"))
    assert models.revision_unavailable(Exception(f"Revision '{PIN[:12]}' does not exist"))
    # A force-pushed-away commit 404s on the resolve url, which names the commit we asked for -
    # that is about the pin, and it is the shape the hub actually answers with.
    assert models.revision_unavailable(
        Exception(f"404 Client Error: Not Found for url: https://huggingface.co/Systran/faster-whisper-small/resolve/{PIN}/model.bin"),
        PIN,
    )


def test_every_other_failure_is_left_alone():
    """
    A retry that cannot succeed is worse than none: it replaces one clear error with a second,
    more confusing one, and hides the fact that nothing about the weights is wrong.
    """
    # The repository is gone, or the machine is offline: `main` fails exactly the same way.
    assert not models.revision_unavailable(RepositoryNotFoundError("404 Client Error: Not Found for url: https://huggingface.co/Systran/faster-whisper-small"))
    assert not models.revision_unavailable(ConnectionError("HTTPSConnectionPool(host='huggingface.co'): Max retries exceeded"))
    assert not models.revision_unavailable(TimeoutError("timed out"))
    # A file missing from a revision the hub *does* have is the download's problem, not the pin's.
    assert not models.revision_unavailable(Exception("EntryNotFoundError: model.bin not found at this path"))
    # And a bare 404 with no commit named in it is not enough to blame the pin for.
    assert not models.revision_unavailable(Exception(f"404 Client Error: Not Found for url: https://huggingface.co/api/models/Systran/faster-whisper-small"), PIN)


def test_the_commit_a_fetch_resolved_main_to_is_read_off_the_cache(tmp_path):
    """
    A run that fell forward loaded ``main``, and "main, whatever it was that afternoon" is not
    something two machines can be compared with. The hub writes the commit it resolved the ref
    to, so the answer is already on disk - and the only honest alternative is to say nothing.
    """
    repo = models.MODELS["small"]["repo"]
    refs = tmp_path / models.repo_cache_name(repo) / "refs"
    refs.mkdir(parents=True)
    (refs / "main").write_text("c" * 40 + "\n")
    assert models.cached_commit(repo, root=tmp_path) == "c" * 40

    assert models.cached_commit(repo, root=tmp_path, ref="other") is None
    assert models.cached_commit("some-org/their-whisper", root=tmp_path) is None

    # A ref file holding anything that is not a commit is not a commit: this is the field that
    # gets written into a transcript, so a tag name must not arrive there looking like one.
    (refs / "main").write_text("main\n")
    assert models.cached_commit(repo, root=tmp_path) is None


def test_the_cache_the_fetch_wrote_is_where_the_commit_is_read_from(tmp_path):
    """``HF_HOME`` moves the cache, and a commit read from the wrong place is worse than none."""
    repo = models.MODELS["small"]["repo"]
    refs = tmp_path / "hub" / models.repo_cache_name(repo) / "refs"
    refs.mkdir(parents=True)
    (refs / "main").write_text("d" * 40)
    assert models.cached_commit(repo, env={"HF_HOME": str(tmp_path)}) == "d" * 40
    assert models.cached_commit(repo, root=tmp_path) is None
