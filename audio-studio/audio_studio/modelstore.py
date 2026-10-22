"""
modelstore.py — the verified copy of the weights, used instead of the hub.

A hub cache answers "which repository?" and lets the hub decide which commit that
is. A pin narrows it to a commit, and that is as far as the cache can go: the files
inside a snapshot are whatever the download produced, and nothing in the cache
records a checksum of them. A snapshot that was interrupted, a disk that returned
a short read, a copy between two machines that dropped one file — all of these
load, and all of them produce a different transcript with nothing on screen to say
so.

The **store** is that missing half:

    models/<repo as a directory>/<commit>/
        model.bin, config.json, vocabulary.txt, ...
        .model-manifest.json      # every file, its size and its SHA-256

The manifest is the claim; :func:`verify` re-hashes the files and checks it. A
store directory without a manifest is not a store, and the loaders refuse to use
one — silently trusting an unlabelled directory would be the same assumption the
cache already makes.

Three rules, and they are what make this worth having:

* **The store wins.** When it has the model, the hub is never contacted, so a
  machine with no network and a machine with one load identical bytes.
* **A mismatch is an error, not a fallback.** Falling back to the cache would
  produce a transcript from weights nobody verified, which is the failure this
  module exists to prevent. The error names the file and the expected hash.
* **A commit is written once.** Two different sets of files under the same commit
  is exactly the divergence being ruled out, so an import never overwrites one
  with the other; it refuses and says so.

The files are copied, not linked, out of the hub cache's symlink farm: a store on
a USB stick or a network share has to survive the original cache being deleted.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from . import fingerprint, models
from .config import PRESETS

#: The manifest's name. Hidden, so the digest of the directory never includes it.
MANIFEST = ".model-manifest.json"

SCHEMA_VERSION = 1


class ModelStoreError(RuntimeError):
    """The store could not be written, or does not match what it claims to hold."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _repo_of(model_id: str) -> str:
    entry = models.MODELS.get(str(model_id))
    return str(entry["repo"]) if entry else str(model_id)


def read_manifest(directory: Path) -> Optional[dict]:
    """The manifest beside the weights, or ``None`` when this is not a store directory."""
    try:
        data = json.loads((directory / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA_VERSION:
        return None
    return data


def write_manifest(directory: Path, repo: str, revision: str, measured: dict) -> dict:
    """Write the manifest for a directory that has just been verified. Atomic."""
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "tool": "audio-studio",
        "repo": repo,
        "revision": revision,
        "sha256": measured["sha256"],
        "files": measured["files"],
        "bytes": measured["bytes"],
        "names": measured.get("names") or [],
        "createdAt": _now(),
    }
    target = directory / MANIFEST
    temp = target.with_suffix(".tmp")
    try:
        temp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        temp.replace(target)
    except OSError as exc:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        raise ModelStoreError(f"could not write {target}: {exc}") from exc
    return manifest


def verify(
    model_id: str,
    *,
    store: Optional[Path] = None,
    env=None,
) -> dict:
    """
    Re-hash a stored model and check it against its manifest.

    ``ok`` is the only field a loader has to read, but the rest is what makes the
    failure fixable: ``mismatched`` names the files whose bytes changed, ``missing``
    the ones that are gone, and ``unexpected`` the ones that appeared. A directory
    that is not a store reports ``present: False`` rather than ``ok: False`` — "install
    this model" and "this copy is corrupt" are different repairs.
    """
    revision = models.revision_for(model_id)
    directory = models.store_dir(model_id, revision=revision, root=store, env=env)
    out: dict = {
        "model": str(model_id),
        "repo": _repo_of(model_id),
        "revision": revision,
        "directory": str(directory) if directory else None,
        "present": False,
        "ok": False,
        "sha256": None,
        "manifestSha256": None,
        "mismatched": [],
        "missing": [],
        "unexpected": [],
        "error": None,
    }
    if directory is None:
        out["error"] = "this model is not pinned to a commit, so it cannot be stored"
        return out
    if not directory.is_dir():
        out["error"] = "the model is not in the store"
        return out
    out["present"] = True

    manifest = read_manifest(directory)
    if manifest is None:
        out["error"] = "the store directory has no manifest: it was not imported by `audio-studio models`"
        return out

    measured = fingerprint.directory_digest(directory, files=True)
    out["sha256"] = measured["sha256"]
    out["manifestSha256"] = manifest.get("sha256")
    if measured.get("error"):
        out["error"] = measured["error"]
        return out
    if measured["sha256"] == manifest.get("sha256"):
        out["ok"] = True
        return out

    claimed = {row.get("name"): row.get("sha256") for row in manifest.get("names") or []}
    found = {row["name"]: row.get("sha256") for row in measured.get("names") or []}
    out["mismatched"] = sorted(name for name in found if name in claimed and found[name] != claimed[name])
    out["missing"] = sorted(name for name in claimed if name not in found)
    out["unexpected"] = sorted(name for name in found if name not in claimed)
    out["error"] = (
        "the files in the store do not match the manifest"
        + (f" ({len(out['mismatched'])} changed, {len(out['missing'])} missing, {len(out['unexpected'])} unexpected)" if
           (out["mismatched"] or out["missing"] or out["unexpected"]) else "")
    )
    return out


def import_model(
    model_id: str,
    source: str | Path = "hf",
    *,
    revision: Optional[str] = None,
    store: Optional[Path] = None,
    env=None,
    overwrite: bool = False,
) -> dict:
    """
    Copy a model's files into the store and record their hashes.

    ``source`` is a directory holding the model files (a snapshot, a USB copy of one,
    another machine's store) or the literal ``"hf"`` for the pinned snapshot already
    in this machine's hub cache — which is how the store is first filled from a
    machine that has already run the pipeline.

    The source is hashed *before* it is copied and the destination *after*, and the
    two are compared: a copy that lost a byte is the failure this is for, and there
    is no reason to discover it on a later run.

    Importing the same commit twice is a no-op when the files agree. When they
    disagree it raises, unless ``overwrite`` says otherwise — two different sets of
    weights under one commit is the divergence the store exists to rule out, so it
    is never resolved silently.
    """
    revision = revision or models.revision_for(model_id)
    repo = _repo_of(model_id)
    if not revision:
        raise ModelStoreError(
            f"{model_id} is not pinned to a commit; a store is addressed by commit, so there is nothing to name it by"
        )

    if str(source).lower() == "hf":
        directory, found = fingerprint.snapshot_dir(repo, revision, root=None, env=env)
        if directory is None:
            raise ModelStoreError(
                f"{repo} @{revision[:8]} is not in this machine's hub cache; run a transcription first, "
                "or import from a directory"
            )
        if found and found != revision:
            raise ModelStoreError(f"the cache holds {found}, not the pinned {revision}")
        source_dir = directory
    else:
        source_dir = Path(source)
        if not source_dir.is_dir():
            raise ModelStoreError(f"no such directory: {source_dir}")

    measured = fingerprint.directory_digest(source_dir, files=True)
    if measured.get("error") or not measured.get("sha256"):
        raise ModelStoreError(f"could not read the weights in {source_dir}: {measured.get('error')}")

    destination = models.store_dir(model_id, revision=revision, root=store, env=env)
    if destination is None:  # pragma: no cover - revision is checked above
        raise ModelStoreError(f"{model_id} has no store path")

    if destination.is_dir():
        existing = verify(model_id, store=store, env=env)
        if existing["ok"] and existing["sha256"] == measured["sha256"]:
            return {
                "model": str(model_id),
                "status": "already",
                "revision": revision,
                "directory": str(destination),
                "sha256": measured["sha256"],
                "files": measured["files"],
            }
        if not overwrite:
            raise ModelStoreError(
                f"{destination} already holds a different set of files for {repo} @{revision[:8]} "
                f"(store {str(existing['sha256'])[:12]}, source {measured['sha256'][:12]}). "
                "Refusing to replace verified weights; pass --overwrite if the store copy is known to be wrong."
            )
        shutil.rmtree(destination, ignore_errors=True)

    destination.mkdir(parents=True, exist_ok=True)
    for row in measured.get("names") or []:
        relative = row["name"]
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copyfile(source_dir / relative, target)
        except OSError as exc:
            raise ModelStoreError(f"could not copy {relative} into the store: {exc}") from exc

    copied = fingerprint.directory_digest(destination, files=True)
    if copied.get("sha256") != measured["sha256"]:
        raise ModelStoreError(
            f"the copy does not match the source ({str(copied.get('sha256'))[:12]} vs {measured['sha256'][:12]}); "
            "the destination may be full or the source changed while it was read"
        )

    write_manifest(destination, repo, revision, copied)
    return {
        "model": str(model_id),
        "status": "imported",
        "revision": revision,
        "directory": str(destination),
        "sha256": copied["sha256"],
        "files": copied["files"],
        "bytes": copied["bytes"],
    }


def known_models() -> list[str]:
    """Every model the catalogue can address by commit: the presets' models and the aligner."""
    ids = list(dict.fromkeys(str(entry["model"]) for entry in PRESETS.values()))
    if models.ALIGN_MODEL not in ids:
        ids.append(models.ALIGN_MODEL)
    return ids


def inventory(*, store: Optional[Path] = None, env=None, check: bool = False) -> list[dict]:
    """
    One row per store-capable model: is it here, and does it still verify?

    Rows that are not in the store are listed too. A store listing that only showed what
    was present would answer "what did I back up" and not "what am I missing", and the
    second question is the one asked on a fresh machine.

    ``check`` re-hashes the files; without it the row reports the manifest's own digest and
    ``ok: None``, because listing a two-gigabyte store should not cost a two-gigabyte read.
    """
    rows: list[dict] = []
    for model_id in known_models():
        if check:
            row = verify(model_id, store=store, env=env)
            rows.append(
                {
                    "model": model_id,
                    "repo": row["repo"],
                    "revision": row["revision"],
                    "present": row["present"],
                    "ok": row["ok"],
                    "sha256": row["sha256"],
                    "directory": row["directory"],
                    "error": row["error"],
                }
            )
            continue
        directory = models.store_dir(model_id, revision=models.revision_for(model_id), root=store, env=env)
        manifest = read_manifest(directory) if directory and directory.is_dir() else None
        rows.append(
            {
                "model": model_id,
                "repo": _repo_of(model_id),
                "revision": models.revision_for(model_id),
                "present": manifest is not None,
                "ok": None,
                "sha256": (manifest or {}).get("sha256"),
                "directory": str(directory) if directory else None,
                "error": None if manifest is not None else ("the model is not in the store" if directory else "unpinned"),
            }
        )
    return rows


def present_models(*, store: Optional[Path] = None, env=None) -> list[str]:
    """
    The models this store actually holds, in catalogue order.

    What "export the store" and "back up the store" mean. Answering with
    :func:`known_models` instead would describe a store nobody has: three of those five
    are presets this studio does not run, and copying them is two gigabytes for nothing.
    This reads manifests only, so it costs a directory listing rather than a re-hash.
    """
    return [row["model"] for row in inventory(store=store, env=env) if row["present"]]


def require(
    model_id: str,
    *,
    store: Optional[Path] = None,
    env=None,
) -> Optional[Path]:
    """
    The store directory to load, or ``None`` when this model is not stored here.

    Raises when the model *is* stored but does not match its manifest: that is a
    corrupt or tampered copy, and loading the fallback cache instead would turn a
    loud failure into a quiet difference in the output.
    """
    directory = models.store_dir(model_id, revision=models.revision_for(model_id), root=store, env=env)
    if directory is None or not directory.is_dir():
        return None
    verdict = verify(model_id, store=store, env=env)
    if not verdict["ok"]:
        raise ModelStoreError(
            f"the stored copy of {model_id} at {directory} does not verify: {verdict['error']}. "
            "Re-import it with `audio-studio models --import`, or point AUDIO_STUDIO_MODELS at a good store. "
            "Falling back to the hub cache would transcribe with weights nobody verified."
        )
    return directory


def export(model_id: str, destination: str | Path, *, store: Optional[Path] = None, env=None) -> dict:
    """
    Copy a stored model out, for another machine that has no network.

    This is the "fixed source" half of the story: the files travel with their
    manifest, so the machine that receives them verifies them on the way in rather
    than trusting the copy. It is deliberately just a copy — rsync, a USB stick or a
    share does the same job — the manifest is what makes any of them checkable.
    """
    directory = require(model_id, store=store, env=env)
    if directory is None:
        raise ModelStoreError(f"{model_id} is not in the store")
    target = Path(destination) / directory.name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(directory, target)
    return {"model": str(model_id), "status": "exported", "directory": str(target)}


__all__ = [
    "MANIFEST",
    "ModelStoreError",
    "export",
    "import_model",
    "inventory",
    "known_models",
    "present_models",
    "read_manifest",
    "require",
    "verify",
    "write_manifest",
]
