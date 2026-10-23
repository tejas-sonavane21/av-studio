"""
fingerprint.py — what a run's numbers were actually computed from.

The same commit, the same model name and the same recording can still produce a
different transcript on two machines. Everything in this project that exists to
prevent that — the pinned commits in ``models.py``, the pinned set in
``requirements.txt`` — decides *which* inputs are used and none of them can prove
that the two machines ended up holding the same bytes. "It works on my machine"
is a statement about the inputs, and until the inputs can be hashed, it is an
assumption.

So this module hashes the layers a transcript is made of, in the order they are
built:

    bytes on disk ─▶ decoded PCM ─▶ model weights ─▶ emissions ─▶ words

Two machines that agree at every layer will produce the same transcript, up to
the floating-point kernel the CPU happens to choose. The first layer that
*differs* is the answer to "why is the other laptop worse" — and it is an answer
that can be read off a report instead of inferred from a log.

Three facts are worth knowing about what is and is not hashed here:

* **The file's hash is not the audio's hash.** ``media.Audio.sha256`` hashes the
  container. Two decoders (PyAV here, a system ``ffmpeg`` on a machine where PyAV
  failed) open the same container and can hand the model slightly different
  samples. ``samples_digest`` hashes the samples the acoustic models actually
  see, which is the only bytes that can change an answer.
* **A model's revision is not its weights.** The pin says which snapshot the
  loader *asked for*; ``weights_digest`` hashes the files that are on this
  machine *now*. A half-finished download, a cache from before the pin existed,
  or a hub that moved ``main`` all show up here and nowhere else.
* **Some CPU differences are legitimate.** ``torch.backends.cpu.get_cpu_capability()``
  returns ``AVX2``/``AVX512``/``DEFAULT``, and that single string decides which
  vectorised kernel a matmul or an int8 GEMM runs on. It is reported, not
  judged: the same weights on two kernels produce answers that differ in the last
  bits, which is enough for a beam search to pick a different word. See
  ``environment``.

Nothing here imports torch or ctranslate2 at module level: ``doctor`` is run on
machines where the optional extras are missing, and it is exactly those machines
whose report matters most.
"""

from __future__ import annotations

import os
import platform
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from . import models, pins

#: The libraries whose version can change a number. A wrong ``httpx`` breaks a download;
#: a wrong ``ctranslate2`` silently computes different logits, which is the difference this
#: module exists to make visible.
NUMERIC_PACKAGES = (
    "numpy",
    "ctranslate2",
    "torch",
    "transformers",
    "tokenizers",
    "av",
    "faster-whisper",
    "huggingface-hub",
)

CHUNK = 1024 * 1024

#: `torch.backends.cpu.get_cpu_capability()` costs an import; the answer cannot change
#: within a process, so it is asked once.
_CAPABILITY: dict[str, Optional[str]] = {}

#: "Use the catalogue's pin", as distinct from an explicit ``revision=None``, which means
#: "the hub's main". The two are different questions and a caller can legitimately ask either.
_PINNED = object()


def sha256_bytes(data: bytes) -> str:
    return sha256(data).hexdigest()


def sha256_path(path: str | Path) -> str:
    """Streamed, so a 1.5 GB checkpoint is hashed without being read into memory."""
    digest = sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def samples_digest(samples: Any) -> Optional[dict]:
    """
    The decoded samples, as the models receive them: little-endian float32 mono.

    ``None`` for undecoded audio rather than an empty hash — "this run never listened"
    and "this run listened to silence" are different records and only one of them is a bug.

    The dtype and count travel with the hash because a hash alone cannot say *what* was
    hashed: two machines on the same hash with different sample counts would otherwise
    look like a match.
    """
    if samples is None:
        return None
    try:
        import numpy as np  # type: ignore
    except ImportError:  # pragma: no cover - numpy is an install extra
        return None
    array = np.asarray(samples, dtype="<f4")
    array = np.ascontiguousarray(array.reshape(-1))
    return {
        "sha256": sha256_bytes(array.tobytes()),
        "samples": int(array.size),
        "dtype": "<f4",
    }


def cpu_capability() -> Optional[str]:
    """
    ``AVX512`` / ``AVX2`` / ``DEFAULT`` — which kernel family torch picked, or ``None``.

    This is the closest thing to a name for "the machine's arithmetic". It is the same
    variable CTranslate2 and BLAS use to choose a vectorised path, so two machines that
    disagree here can disagree in a transcript while every input is identical. ``None``
    when torch is not installed: the question is then not answerable, not "the same".
    """
    if "value" in _CAPABILITY:
        return _CAPABILITY["value"]
    value: Optional[str] = None
    try:
        import torch  # type: ignore

        backend = getattr(getattr(torch, "backends", None), "cpu", None)
        getter = getattr(backend, "get_cpu_capability", None)
        if callable(getter):
            value = str(getter())
    except Exception:  # noqa: BLE001 - a report must never fail on the machine it describes
        value = None
    _CAPABILITY["value"] = value
    return value


def numeric_threads() -> dict:
    """The thread counts the numeric libraries actually decided on, not the ones configured."""
    out: dict = {"cpuCount": os.cpu_count()}
    try:
        import torch  # type: ignore

        out["torchThreads"] = int(torch.get_num_threads())
        out["torchInteropThreads"] = int(torch.get_num_interop_threads())
    except Exception:  # noqa: BLE001
        out["torchThreads"] = None
        out["torchInteropThreads"] = None
    return out


def snapshot_dir(repo: str, revision: Optional[str], *, root: Optional[Path], env=None) -> tuple[Optional[Path], Optional[str]]:
    """
    The directory holding the weights in the *hub cache*, and the commit it is.

    The same resolution order the loaders use: the pinned commit when one is named and
    present, otherwise the commit ``refs/main`` points at. Resolving it here rather than
    guessing at a directory name is what makes the hash comparable with the pin in the
    artifact. ``modelstore`` uses this to import from a cache into the verified store.
    """
    base = (Path(root) if root else models.cache_dir(env)) / models.repo_cache_name(repo)
    snapshots = base / "snapshots"
    if not snapshots.is_dir():
        return None, None
    if revision:
        candidate = snapshots / revision
        return (candidate, revision) if candidate.is_dir() else (None, revision)
    commit = models.cached_commit(repo, root=root, env=env)
    if commit and (snapshots / commit).is_dir():
        return snapshots / commit, commit
    try:
        children = sorted(child for child in snapshots.iterdir() if child.is_dir())
    except OSError:
        return None, None
    return (children[-1], children[-1].name) if children else (None, None)


def _weight_files(directory: Path) -> list[Path]:
    """
    Every regular file in a snapshot, in a stable order.

    Hidden entries are skipped: ``.no_exist`` is the hub's record of files it asked for and
    did not get, which is metadata about a download rather than part of the model.
    """
    files: list[Path] = []
    for path in directory.rglob("*"):
        try:
            if not path.is_file():
                continue
        except OSError:
            continue
        if any(part.startswith(".") for part in path.relative_to(directory).parts):
            continue
        files.append(path)
    return sorted(files, key=lambda p: p.relative_to(directory).as_posix())


def directory_digest(directory: Path, *, files: bool = False) -> dict:
    """
    The digest of one directory of model files: every name, every byte, in name order.

    This is the *definition* of "the same weights" for this project, and it is deliberately
    independent of where the files came from. A hub snapshot and a verified-store copy of
    the same files hash to the same string, which is what lets an artifact made on one
    machine be compared with a run on another without either machine being present.

    Hidden files are skipped, so a store's own manifest and the hub's download bookkeeping
    do not enter the hash.
    """
    digest = sha256()
    total = 0
    names = _weight_files(directory)
    per_file: list[dict] = []
    for path in names:
        # Streamed, not read into one bytes object. The hash is the same either way, but
        # a 2.3 GB checkpoint read whole is a 2.3 GB allocation on the machine that is
        # about to load that same checkpoint - and the first thing it hits is `MemoryError`
        # inside a provenance report. The file size is taken from the filesystem, which is
        # what the bytes that follow are counted against.
        relative = path.relative_to(directory).as_posix().encode("utf-8")
        # Built on a copy so a file that fails halfway leaves `digest` at the last good
        # file rather than at half of this one - the error branch reports a partial
        # `bytes` count, and the hash it returns is None either way.
        running = digest.copy()
        running.update(relative)
        try:
            size = path.stat().st_size
            individual = sha256() if files else None
            # Length-prefixed, so `ab` + `c` cannot hash the same as `a` + `bc`.
            running.update(size.to_bytes(8, "little"))
            drained = 0
            with open(path, "rb") as handle:
                for block in iter(lambda: handle.read(8 << 20), b""):
                    running.update(block)
                    if individual is not None:
                        individual.update(block)
                    drained += len(block)
            if drained != size:
                raise OSError(f"read {drained} bytes of {size}")
        except OSError as exc:
            return {
                "sha256": None,
                "files": len(names),
                "bytes": total,
                "error": f"could not read {path.name}: {exc}",
            }
        digest = running
        total += size
        if files:
            per_file.append(
                {
                    "name": path.relative_to(directory).as_posix(),
                    "bytes": size,
                    "sha256": individual.hexdigest() if individual is not None else None,
                }
            )
    out = {"sha256": digest.hexdigest(), "files": len(names), "bytes": total}
    if files:
        out["names"] = per_file
    return out


def weights_digest(
    model_id: str,
    *,
    revision: Any = _PINNED,
    root: Optional[Path] = None,
    store: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
    files: bool = False,
) -> dict:
    """
    A hash of the weight files on this machine, plus the commit they claim to be.

    ``model_id`` is anything the catalogue knows — a preset's short name (``small``) or a
    hub repository (``facebook/wav2vec2-base-960h``). An unknown id is treated as a
    repository name, which is what a caller passing a path to a local model would need; a
    path that is not a directory resolves to ``"error"`` rather than an exception, because
    the caller is usually a report.

    ``files`` is off by default: the per-file hashes are what answers "which of the two
    files differs", and they are only worth the extra bytes when someone is already
    comparing two reports.

    Nothing is cached between calls. A cache here would be fast and wrong in exactly the
    case that matters: a download that finished between the check and the hash. Reading
    464 MB costs about a second, twice per process at most (the one at load, and `parity`).

    ``revision`` defaults to the catalogue's pin for ``model_id``. A caller that watched a
    pin fall forward to ``main`` should pass the commit it actually loaded, or the digest
    would describe a snapshot that is not the one in the transcript.

    The **verified store wins over the hub cache** when it has the model, because that is
    also the order the loaders load them in. The digest is computed by
    :func:`directory_digest`, so the same files hash the same either way, and ``source``
    says which copy was measured.
    """
    pinned: Optional[str] = models.revision_for(model_id) if revision is _PINNED else revision
    repo = str(model_id)
    entry = models.MODELS.get(str(model_id))
    if entry is not None:
        repo = str(entry["repo"])

    directory = models.store_dir(model_id, revision=pinned, root=store, env=env)
    source = "store"
    if directory is None or not models.in_store(model_id, revision=pinned, root=store, env=env):
        directory, commit = snapshot_dir(repo, pinned, root=root, env=env)
        source = "cache"
    else:
        commit = pinned

    if directory is None:
        return {
            "repo": repo,
            "revision": commit,
            "pinned": pinned,
            "source": None,
            "sha256": None,
            "error": "the weights are not on this machine",
        }

    measured = directory_digest(directory, files=files)
    out = {
        "repo": repo,
        "revision": commit,
        "pinned": pinned,
        "source": source,
        "files": measured["files"],
        "bytes": measured["bytes"],
        "sha256": measured["sha256"],
    }
    if measured.get("error"):
        out["error"] = measured["error"]
    if files and "names" in measured:
        out["names"] = measured["names"]
    return out


def environment() -> dict:
    """
    The machine, in the terms that decide a number.

    Deliberately not "everything": a report full of BIOS versions is a report nobody reads.
    What is here is the set of facts that can change a transcript while the code, the
    model name and the recording stay the same — the CPU's vector kernel, the thread counts
    the libraries chose, and the exact versions of the libraries that compute.
    """
    pins_check = pins.check()
    return {
        "python": platform.python_version(),
        "executable": sys.executable,
        "virtualenv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
        "platform": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpuCapability": cpu_capability(),
        **numeric_threads(),
        "packages": {name: _version(name) for name in NUMERIC_PACKAGES},
        "pins": {
            "ok": sum(1 for row in pins_check if row["status"] == "ok"),
            "differs": [row["name"] for row in pins_check if row["status"] == "differs"],
            "missing": [row["name"] for row in pins_check if row["status"] == "missing"],
        },
        "computeTypes": _compute_types(),
        "torchDeviceThreads": os.environ.get("OMP_NUM_THREADS") or None,
    }


def _version(name: str) -> Optional[str]:
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version(name)
        except PackageNotFoundError:
            return None
    except Exception:  # noqa: BLE001
        return None


def _compute_types() -> Optional[list[str]]:
    try:
        import ctranslate2  # type: ignore

        return sorted(str(item) for item in ctranslate2.get_supported_compute_types("cpu"))
    except Exception:  # noqa: BLE001
        return None


def compare(left: Mapping[str, Any], right: Mapping[str, Any]) -> list[dict]:
    """
    Which fields of two parity reports differ, as ``{stage, field, left, right}``.

    Only the top two levels are compared, which is the shape of the report: a stage and
    one number inside it. The first row is the interesting one — the pipeline is built in
    stages, so a difference upstream makes every downstream difference expected, not
    additional evidence.
    """
    rows: list[dict] = []
    for stage in sorted(set(left) | set(right)):
        a, b = left.get(stage), right.get(stage)
        if not isinstance(a, Mapping) or not isinstance(b, Mapping):
            if a != b:
                rows.append({"stage": stage, "field": None, "left": a, "right": b})
            continue
        for field in sorted(set(a) | set(b)):
            if a.get(field) != b.get(field):
                rows.append({"stage": stage, "field": field, "left": a.get(field), "right": b.get(field)})
    return rows


def summarise(report: Mapping[str, Any]) -> Iterable[str]:
    """The parity report as the lines a person reads, most upstream stage first."""
    order = ("source", "pcm", "weights", "transcript", "emissions", "alignment")
    for stage in order:
        block = report.get(stage)
        if not isinstance(block, Mapping):
            continue
        digest = block.get("sha256")
        detail = block.get("error") or ""
        yield f"  {stage:<11} {digest or '-'}{('  ' + detail) if detail else ''}"


__all__ = [
    "NUMERIC_PACKAGES",
    "compare",
    "cpu_capability",
    "directory_digest",
    "environment",
    "snapshot_dir",
    "numeric_threads",
    "samples_digest",
    "sha256_bytes",
    "sha256_path",
    "summarise",
    "weights_digest",
]
