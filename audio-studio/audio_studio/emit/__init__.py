"""
emit/ — output formats, behind one registry.

``render(kind, transcript, **options)`` returns a string and ``write_bundle``
writes several at once, so the CLI, the HTTP server and the tests all go through
the same code path. Adding a format means adding a module with ``KIND``,
``EXTENSION`` and ``render``, then listing it in :data:`EMITTERS`.
"""

from __future__ import annotations

import re
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


#: Windows refuses these in a name and the POSIX shells merely dislike them; a
#: recording called `take 2: final?.mp3` should produce `take 2_ final_.srt`, not a
#: crashed run. The allow-list is deliberate rather than a deny-list: a deny-list is
#: always one character short, and the character it misses is the one that escapes.
_UNSAFE = re.compile(r"[^\w.\- ]+", re.UNICODE)

#: Nothing may be an absolute path, a drive, or a climb out of the output folder.
_MAX_STEM = 80


def safe_stem(name: object, fallback: str = "transcript") -> str:
    """
    A file-name stem that cannot escape its folder or break a filesystem.

    Every output name in the suite is built from this: the four emitted documents, the
    `<stem>.run.json` manifest beside them, and the per-job files the HTTP server writes.
    The input is a *filename* — the recording's own stem, or `--stem` off the command
    line — and neither is trusted: `--stem ../../notes/attack` used to write outside the
    output directory, and a source whose name contained a `:` or a `?` used to raise an
    `OSError` on Windows half a run in, after the model had done its work.

    Kept here, in the module that owns every output name, because a second copy of this
    rule is a second answer to "what is a legal name". `caption-studio`'s
    `io/download.js` carries the equivalent function for the browser's side of the suite.
    """
    text = str(name or "").replace("\\", "/")
    # The last segment only: a path is not a name, and taking the whole thing would
    # let one through the moment a separator survived the replacement above.
    text = text.rsplit("/", 1)[-1]
    text = _UNSAFE.sub("_", text)
    text = re.sub(r"\s+", " ", text).strip(" .-")
    if len(text) > _MAX_STEM:
        text = text[:_MAX_STEM].rstrip(" .-")
    return text or fallback


def filename(kind: str, stem: str) -> str:
    return f"{safe_stem(stem)}{extension(kind)}"


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
    stem = safe_stem(stem)

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
    "safe_stem",
    "write_bundle",
]
