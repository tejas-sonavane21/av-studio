"""
runlog.py — what a run produced, written down beside what it produced.

`out/song.srt` and `out/song.veed.json` are files. They are not a *record*: nothing
in them says which recording they came from, which pass re-timed them, or whether
they are the run you just did or the one from Tuesday — and every file shares one
flat folder, so the second run over a different `song.mp3` overwrites the first
without a word.

A run therefore writes `<stem>.run.json` next to its outputs, holding:

* **what produced it** — the tool, its version, and the exact command line;
* **what it read** — the source path, its size and its **SHA-256**, which is the
  same hash the artifact records, so a manifest and a transcript can be shown to
  be talking about the same bytes;
* **what it wrote** — every output file, with its kind and size;
* **what happened** — the engine, the alignment, the validation passes, the
  counts.

Why a file and not a log line: a menu of recent runs needs to *find* them, and the
browser that wants to import one is a different process that cannot read this
program's stderr. `find_manifests()` is the other half — the reader — so the
folder is discoverable by anything that can see it, including `caption-studio`
over its dev server.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

from .emit import safe_stem

#: The suffix a manifest carries. `<stem>.run.json`, so it sorts beside its own run
#: and cannot be mistaken for one of the emitted documents.
SUFFIX = ".run.json"

#: The schema this file is written as. Bumped when a reader would have to change.
SCHEMA_VERSION = 1


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _kind_of(path: Path, stem: str) -> str:
    """`song.veed.json` → `veed`; `song.speech.json` → `speech`; `song.srt` → `srt`."""
    name = path.name
    if not name.startswith(stem):
        return path.suffix.lstrip(".")
    rest = name[len(stem) :].lstrip(".")
    parts = rest.split(".")
    return parts[0] if len(parts) == 1 else ".".join(parts[:-1])


def build_manifest(
    transcript: Any,
    *,
    stem: str,
    outputs: Iterable[Path],
    source: Optional[Any] = None,
    command: Optional[str] = None,
    created: Optional[str] = None,
) -> dict:
    """
    The manifest for one run. Pure apart from file sizes, and JSON-safe.

    `source` is a `media.Audio` when one was decoded — the same object whose hash and
    duration the transcript's provenance carries — and `None` for a re-emit, where the
    run never saw the recording at all. That difference is recorded rather than papered
    over: a manifest that claimed a source it did not read would be worse than no source.
    """
    written = [Path(p) for p in outputs]
    manifest: dict = {
        "schemaVersion": SCHEMA_VERSION,
        "tool": "audio-studio",
        "createdAt": created or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stem": stem,
        "source": None,
        "outputs": [
            {"kind": _kind_of(path, stem), "file": path.name, "bytes": _size(path)} for path in written
        ],
        "summary": {
            "segments": len(getattr(transcript, "segments", [])),
            "words": getattr(transcript, "word_count", 0),
            "durationSeconds": round(float(getattr(transcript, "duration", 0.0) or 0.0), 3),
            "speechSeconds": round(float(getattr(transcript, "speech_duration", 0.0) or 0.0), 3),
            "language": getattr(transcript, "language", None),
            "warnings": list(getattr(transcript, "warnings", []) or []),
        },
        "engine": getattr(transcript, "engine", None),
        "alignment": getattr(transcript, "alignment", None),
        "validation": getattr(transcript, "validation", None),
        "reference": getattr(transcript, "reference", None),
        "command": command,
    }
    if source is not None:
        path = getattr(source, "path", None)
        manifest["source"] = {
            "file": Path(path).name if path else None,
            "path": str(path) if path else None,
            "sha256": getattr(source, "sha256", None) or None,
            "durationSeconds": round(float(getattr(source, "duration", 0.0) or 0.0), 3),
            "bytes": _size(Path(path)) if path else 0,
            "decodedBy": getattr(source, "decoded_by", None) or None,
        }
    return manifest


def manifest_path(outdir: str | Path, stem: str) -> Path:
    """
    Where the manifest for `stem` lives. Pure.

    The name is sanitised by `emit.safe_stem`, the same rule the documents beside it are
    named by — a manifest is looked for *by name* (`find_manifests` reads the suffix), so
    a manifest named differently from its own outputs would be indistinguishable from a
    manifest belonging to another run.
    """
    return Path(outdir) / f"{safe_stem(stem)}{SUFFIX}"


def write_manifest(outdir: str | Path, stem: str, manifest: dict) -> Path:
    """Write it, atomically, and return where. Returns the path even if the write fails."""
    target = manifest_path(outdir, stem)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    try:
        temp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        temp.replace(target)
    except OSError:
        # A run that produced its transcripts has succeeded; a manifest it could not
        # write is worth a missing menu entry, not a failed job.
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
    return target


def read_manifest(path: str | Path) -> Optional[dict]:
    """Parse one manifest, or `None` when the file is not one."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("tool") != "audio-studio":
        return None
    return data


def find_manifests(directory: str | Path, limit: Optional[int] = None) -> list[dict]:
    """
    Every run recorded in `directory`, **newest first**.

    Recursive on purpose: the interactive server writes one folder per job and the
    command line writes one flat folder, and a reader that only understood one of the
    two layouts would be a reader that worked in only one of the two modes.
    """
    root = Path(directory)
    if not root.is_dir():
        return []
    found: list[dict] = []
    for candidate in root.rglob(f"*{SUFFIX}"):
        manifest = read_manifest(candidate)
        if manifest is None:
            continue
        # `as_posix()` and not `str()`: this is read by a browser over HTTP, where a
        # Windows path separator is not a separator at all. A record whose paths only
        # resolve on the machine that wrote them is not a record of much.
        manifest["manifest"] = candidate.relative_to(root).as_posix()
        manifest["directory"] = (
            candidate.parent.relative_to(root).as_posix() if candidate.parent != root else "."
        )
        found.append(manifest)
    # The timestamp is written by this program, but a file can also be copied or
    # edited; sorting on the manifest's own name keeps that from breaking the order.
    found.sort(key=lambda m: (str(m.get("createdAt") or ""), str(m.get("manifest") or "")), reverse=True)
    return found[:limit] if limit else found


def describe(manifest: dict) -> str:
    """One line about a run, for a menu. Never raises on a partial manifest."""
    summary: dict = manifest.get("summary") or {}
    source: dict = manifest.get("source") or {}
    name = source.get("file") or manifest.get("stem") or "a run"
    seconds = summary.get("durationSeconds")
    return (
        f"{name} — {summary.get('segments', '?')} segments, {summary.get('words', '?')} words"
        + (f", {seconds:.1f}s" if isinstance(seconds, (int, float)) else "")
    )


__all__ = [
    "SCHEMA_VERSION",
    "SUFFIX",
    "build_manifest",
    "describe",
    "find_manifests",
    "manifest_path",
    "read_manifest",
    "write_manifest",
]
