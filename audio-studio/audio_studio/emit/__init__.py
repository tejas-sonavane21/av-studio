"""
emit/ — output formats, behind one registry.

``render(kind, transcript, **options)`` returns a string and ``write_bundle``
writes several at once, so the CLI, the HTTP server and the tests all go through
the same code path. Adding a format means adding a module with ``KIND``,
``EXTENSION`` and ``render``, then listing it in :data:`EMITTERS`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from ..model import Transcript
from . import native, srt, veed, vtt

EMITTERS = {
    native.KIND: native,
    veed.KIND: veed,
    srt.KIND: srt,
    vtt.KIND: vtt,
}

#: What ``transcribe`` writes unless told otherwise. ``veed`` is in the default
#: set on purpose: it is the file caption-studio can import today.
DEFAULT_KINDS = (native.KIND, veed.KIND, srt.KIND, vtt.KIND)


def kinds() -> list[str]:
    return list(EMITTERS)


def extension(kind: str) -> str:
    try:
        return EMITTERS[kind].EXTENSION
    except KeyError:
        raise ValueError(f"unknown emit kind {kind!r}; expected one of {kinds()}") from None


def known_options() -> set[str]:
    """Every option name any emitter understands, e.g. ``{'word_level', 'emphasis'}``."""
    return {name for module in EMITTERS.values() for name in getattr(module, "OPTIONS", ())}


def render(kind: str, transcript: Transcript, **options) -> str:
    """
    Render one format.

    Each emitter declares its ``OPTIONS``, and an option a given format has no
    use for is dropped for that format — that is what lets ``write_bundle`` pass
    one set of options (``word_level``, ``emphasis``, …) across four formats.
    An option no emitter recognises is an error, so a typo still fails loudly.
    """
    try:
        module = EMITTERS[kind]
    except KeyError:
        raise ValueError(f"unknown emit kind {kind!r}; expected one of {kinds()}") from None

    unknown = set(options) - known_options()
    if unknown:
        raise ValueError(f"unknown emit option(s) {sorted(unknown)}; expected any of {sorted(known_options())}")

    accepted = set(getattr(module, "OPTIONS", ()))
    return module.render(transcript, **{name: value for name, value in options.items() if name in accepted})


def filename(kind: str, stem: str) -> str:
    return f"{stem}{extension(kind)}"


def write_bundle(
    transcript: Transcript,
    outdir: str | Path,
    stem: str = "transcript",
    kinds_selected: Iterable[str] = DEFAULT_KINDS,
    **options,
) -> list[Path]:
    """Write every requested format, returning the paths in a stable order."""
    options = {name: value for name, value in options.items() if value is not None}
    unknown = set(options) - known_options()
    if unknown:
        raise ValueError(f"unknown emit option(s) {sorted(unknown)}; expected any of {sorted(known_options())}")

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for kind in kinds_selected:
        path = out / filename(kind, stem)
        path.write_text(render(kind, transcript, **options), encoding="utf-8")
        written.append(path)
    return written


__all__ = [
    "DEFAULT_KINDS",
    "EMITTERS",
    "extension",
    "filename",
    "kinds",
    "known_options",
    "render",
    "write_bundle",
]
