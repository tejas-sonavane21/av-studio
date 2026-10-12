"""
env.py — the one file a key is allowed to live in.

A key is read from the **process environment**, and a `.env` file is read *into* it
first, so the common case — one key, and no wish to export it in every shell — needs
no setup beyond copying `.env.example` to `.env`. That is the whole point of this
module: the studio should never have to be told a path, and the key should never be
committed.

Rules, in order:

1. **A real environment variable always wins.** `.env` is applied with ``setdefault``
   semantics, so an exported ``GEMINI_API_KEY`` (or one set by a CI job, a container,
   or a Windows user environment variable) is never overridden by a file somebody
   happened to leave in the tree.
2. **The walk is bounded.** The file is looked for in the working directory and up to
   ``SEARCH_LEVELS`` ancestors, then at the repository root beside this package. An
   unbounded walk to the drive root would find a *different* project's `.env` and send
   that project's key to Google — the failure mode this bound exists to prevent.
3. **No value is ever printed.** Callers ask "is there a key", not "what is it"; the
   audit trail records the provider and the model, never the secret.

The format is the subset of dotenv a person actually types, and nothing more:
``KEY=value``, an optional leading ``export``, ``#`` comments on their own line or
after an unquoted value, single quotes taken literally, and ``\\n`` / ``\\t`` / ``\\"``
escapes inside double quotes. A line that does not parse as an assignment is skipped
rather than guessed at, because guessing at a secret's boundaries is how a key ends up
truncated in a request and reported as a bad key.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional, Union

#: The file the key is read from, and the template that is committed in its place.
ENV_FILENAME = ".env"
ENV_EXAMPLE_FILENAME = ".env.example"

#: How far up from the working directory (and from this package) a `.env` is looked
#: for. Bounded on purpose — see rule 2 above.
SEARCH_LEVELS = 4

#: `KEY=value`, `export KEY=value`. The key is an identifier, deliberately: a line
#: with a space before the `=` is a typo, not a key with a space in its name.
_ASSIGNMENT = re.compile(r"^(?:export\s+)?(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?P<value>.*)$")

#: `\n`, `\t` and friends, for the inside of a double-quoted value.
_ESCAPES = (("\\n", "\n"), ("\\r", "\r"), ("\\t", "\t"), ('\\"', '"'), ("\\\\", "\\"))


def _value(raw: str) -> Optional[str]:
    """
    The value half of an assignment, unquoted. ``None`` means "not a value at all".

    The three cases are genuinely different and are handled differently on purpose:

    * ``'...'`` — literal, exactly as written. Nothing inside is special, which is
      what makes single quotes the right place for a key that contains ``$`` or ``\\``.
    * ``"..."`` — the escapes above are applied, and a ``#`` inside is part of the
      value.
    * bare — trailing whitespace and a `` # comment`` are stripped.
    """
    text = raw.strip()
    if not text:
        return None
    if text[0] == "'":
        end = text.find("'", 1)
        return text[1 : end if end != -1 else len(text)]
    if text[0] == '"':
        end = text.rfind('"')
        body = text[1 : end if end > 0 else len(text)]
        for escaped, literal in _ESCAPES:
            body = body.replace(escaped, literal)
        return body
    # A comment may follow a bare value, but only after whitespace: a value that
    # legitimately contains '#' (a URL fragment, a key) survives intact.
    cut = re.search(r"\s#", text)
    if cut:
        text = text[: cut.start()].rstrip()
    return text or None


def parse_env(text: str) -> dict[str, str]:
    """
    Parse dotenv text into a mapping. **Pure**, and total: bad lines are skipped.

    Empty values are dropped rather than kept as ``""`` — a key set to nothing is not
    a key, and keeping the empty string would make ``if os.environ.get(name)`` and
    "the variable exists" disagree in every caller.
    """
    values: dict[str, str] = {}
    # A byte-order mark, a CRLF (Notepad, a Windows `>` redirect) and a lone CR are all
    # things a hand-written `.env` arrives with; none of them is part of a key.
    for line in text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _ASSIGNMENT.match(stripped)
        if not match:
            continue
        value = _value(match.group("value"))
        if value is not None:
            values[match.group("key")] = value
    return values


def find_env_file(
    start: Optional[Union[str, Path]] = None, levels: int = SEARCH_LEVELS
) -> Optional[Path]:
    """
    The nearest `.env` to ``start`` (default: the working directory), or ``None``.

    Checked in this order, and the first hit wins: ``start`` and its ``levels`` nearest
    ancestors, then the repository root beside this package. The ancestor walk comes
    first so a project that deliberately keeps its own `.env` deeper in the tree is not
    overruled by the root's.
    """
    origin = Path(start).resolve() if start else Path.cwd().resolve()
    candidates = [base / ENV_FILENAME for base in [origin, *origin.parents[:levels]]]
    # .../web_av_editor/audio-studio/audio_studio/env.py → .../web_av_editor
    parents = Path(__file__).resolve().parents
    if len(parents) > 2:
        candidates.append(parents[2] / ENV_FILENAME)

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if candidate.is_file():
                return candidate
        except OSError:  # a path that cannot be stat'd is simply not the file
            continue
    return None


def read_env(
    path: Optional[Union[str, Path]] = None, start: Optional[Union[str, Path]] = None
) -> dict[str, str]:
    """
    The values in ``path`` (or in the nearest `.env`), **without touching the process
    environment**. ``{}`` when there is no file, or it cannot be read.

    Kept separate from :func:`load_env` so a caller that only wants to explain what
    *would* be used does not have to mutate its own environment to find out.
    """
    target = Path(path) if path else find_env_file(start)
    if target is None:
        return {}
    try:
        return parse_env(target.read_text(encoding="utf-8-sig"))
    except OSError:
        return {}


def load_env(
    path: Optional[Union[str, Path]] = None,
    *,
    start: Optional[Union[str, Path]] = None,
    override: bool = False,
) -> dict[str, str]:
    """
    Apply `.env` to ``os.environ`` and return everything the file held.

    ``override=False`` (the default) means an existing, non-empty variable of the same
    name is left exactly as it is — rule 1. Callers that need to know *which* variables
    the file supplied get the mapping back.

    Never raises: a missing, unreadable or malformed file is "no `.env` here", not a
    failure, because the studio has to keep working when the environment is set some
    other way.
    """
    values = read_env(path, start)
    for key, value in values.items():
        if override or not os.environ.get(key):
            os.environ[key] = value
    return values


__all__ = [
    "ENV_EXAMPLE_FILENAME",
    "ENV_FILENAME",
    "SEARCH_LEVELS",
    "find_env_file",
    "load_env",
    "parse_env",
    "read_env",
]
