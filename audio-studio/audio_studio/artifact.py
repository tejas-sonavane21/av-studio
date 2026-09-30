"""
artifact.py — read and write the native ``*.speech.json`` artifact.

Kept separate from ``emit/`` because it is the *inbound* direction: the CLI and
the server both need to re-open a transcript (to re-emit it as SRT, to validate
its text, or to serve it back), and doing that through an emitter module would
be the wrong way round.
"""

from __future__ import annotations

import json
from pathlib import Path

from .model import SCHEMA_VERSION, Transcript, normalize_transcript


class ArtifactError(ValueError):
    """Raised when a file is not a transcript artifact we can trust."""


def loads(text: str) -> Transcript:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ArtifactError(f"not valid JSON: {exc}") from exc
    return from_data(data)


def from_data(data: object) -> Transcript:
    if not isinstance(data, dict):
        raise ArtifactError("artifact must be a JSON object")
    if "segments" not in data:
        raise ArtifactError("artifact has no 'segments' key; is this really a *.speech.json?")

    version = data.get("schemaVersion")
    if version is not None and int(version) > SCHEMA_VERSION:
        raise ArtifactError(
            f"artifact schemaVersion {version} is newer than this build understands ({SCHEMA_VERSION})"
        )

    transcript = Transcript.from_dict(data)
    # Re-normalise on load. A hand-edited artifact is a legitimate input, and the
    # invariants have to hold regardless of who wrote the file.
    return normalize_transcript(transcript)


def load(path: str | Path) -> Transcript:
    return loads(Path(path).read_text(encoding="utf-8"))


def save(transcript: Transcript, path: str | Path) -> Path:
    from .emit import native

    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(native.render(transcript), encoding="utf-8")
    return out
