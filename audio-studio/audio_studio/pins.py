"""
pins.py — what `requirements.txt` pins, against what is actually installed.

The failure this exists to catch has already happened once. On one machine the studio
decoded audio and on another it could not, from the same commit, because `av` was
resolved as `>=11` by `faster-whisper` and picked up a release that removed a keyword
`faster-whisper` still passes. The error surfaced as *"install the 'asr' extra or put
ffmpeg on PATH"* — a message about a missing binary, for a problem in a library version.

`requirements.txt` is the fix: it is the exact set this project was built and verified
on. This module is the other half of that fix, because a pin that nothing checks is a
comment: `doctor` now compares the two and names the difference, so "the same code
behaves differently on two machines" has an answer that does not involve bisecting a
dependency tree.

Nothing here imports a heavy library. Versions come from the installed distribution's
metadata, so asking the question never pays the cost of answering it with an import.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Mapping, Optional

#: `name==version`, with the environment markers and index lines in the file ignored.
#: Only ``==`` counts as a pin: `>=` is a floor, and a floor is what let the two
#: machines diverge in the first place.
_PIN = re.compile(r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*(?P<version>[^\s;#]+)")

#: The file's own name, and where it sits relative to this package: `audio-studio/`.
REQUIREMENTS_FILENAME = "requirements.txt"


def requirements_path(start: Optional[Path] = None) -> Optional[Path]:
    """The pinned set that travels with this checkout, or ``None`` when there is none.

    From a source tree that is ``audio-studio/requirements.txt``. From an installed
    package it is usually absent — a wheel does not carry the development pin list —
    and the honest answer to "what is pinned" is then "nothing is", not an exception.
    """
    base = Path(start) if start else Path(__file__).resolve().parents[1]
    candidate = base / REQUIREMENTS_FILENAME
    try:
        return candidate if candidate.is_file() else None
    except OSError:
        return None


def read_pins(path: Optional[Path] = None) -> dict[str, str]:
    """
    Every ``name==version`` in the file, lower-cased by name. ``{}`` when unreadable.

    Comments, blank lines and `--extra-index-url` lines are skipped rather than
    guessed at, and a name may appear once: the file lists each pin a single time,
    and a second mention would be a contradiction nobody wrote on purpose.
    """
    target = path or requirements_path()
    if target is None:
        return {}
    try:
        text = target.read_text(encoding="utf-8")
    except OSError:
        return {}
    pins: dict[str, str] = {}
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        match = _PIN.match(line)
        if match:
            pins[match.group("name").lower()] = match.group("version")
    return pins


def installed_versions(names: Mapping[str, str] | list[str]) -> dict[str, Optional[str]]:
    """
    What each installed distribution reports, by name. ``None`` means "not installed".

    Metadata rather than ``import``: `import av` to ask its version would be a doctor
    that loads the very library it is diagnosing, and `import torch` would add seconds
    and 300 MB to a command whose whole job is to be quick and safe to run.
    """
    from importlib.metadata import PackageNotFoundError, version

    out: dict[str, Optional[str]] = {}
    for name in names:
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            out[name] = None
        except Exception:  # a broken distribution must not break the report
            out[name] = None
    return out


def compare(pins: Mapping[str, str], installed: Mapping[str, Optional[str]]) -> list[dict]:
    """
    One row per pin: ``{name, pinned, installed, status}``.

    The statuses are deliberately different, because the fixes are:

    * ``ok`` — the pinned version is the installed one;
    * ``differs`` — a different version is installed; this is the one that changes
      behaviour, and it is what a fresh ``pip install -r requirements.txt`` repairs;
    * ``missing`` — not installed at all, which is a pass that cannot run rather than a
      wrong answer (the alignment and validation extras are optional by design).

    Pure: the caller supplies both sides.
    """
    rows: list[dict] = []
    for name in sorted(pins):
        want = pins[name]
        have = installed.get(name)
        if have is None:
            status = "missing"
        elif have == want:
            status = "ok"
        else:
            status = "differs"
        rows.append({"name": name, "pinned": want, "installed": have, "status": status})
    return rows


def check(path: Optional[Path] = None) -> list[dict]:
    """`:func:`compare` for this checkout against this interpreter."""
    pins = read_pins(path)
    return compare(pins, installed_versions(list(pins)))


__all__ = [
    "REQUIREMENTS_FILENAME",
    "check",
    "compare",
    "installed_versions",
    "read_pins",
    "requirements_path",
]
