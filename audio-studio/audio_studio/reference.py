"""
reference.py — the original lyrics, when the user has them.

Transcribing a **sung** track is transcribing something the words for already
exist. When the user can hand the studio those words — a ``.srt``, a ``.vtt`` or a
plain text file — the text stops being a guess and only *timing* is still a
question. This module reads the file; ``reconcile.py`` casts the transcript onto
it.

## Why this is a pass of its own, and not a validator

``validate/ledger.py`` refuses, by construction, any proposal that changes the
word count: inserting, deleting or splitting a word moves the timing of
everything after it, and that is the exact bug class this suite exists to remove.
Reconciling with the real lyrics **is** changing the word count — that is the
whole point — so it cannot be smuggled through that ledger. It gets its own pass,
its own record and its own rules, and it runs *before* alignment so the aligner
then gets to re-time every word it introduced.

## Reading a subtitle file is not splitting lines

The reference material for this project has a *rolling* subtitle file: every cue
repeats the lines above it and adds one, and the first cue introduces **two**
lines at once. Read naively, such a file duplicates the whole lyric sheet several
times over. Reading it as "the last line of each cue" instead is wrong in the
other direction, and silently drops the first cue's first line.

So this module *measures* the file instead of assuming a convention: for every
cue it computes the largest overlap between the suffix of the previous cue and the
prefix of this one, and treats the file as rolling only when that overlap is the
rule rather than the exception (``ROLLING_SHARE``). A rolling cue contributes what
is left after the overlap; an ordinary cue contributes all of its lines. Both
conventions therefore read correctly, and ``Reference.rolling`` records which one
was detected.

SRT and WebVTT share one parser: the formats differ only in the header, the
comment blocks and the decimal separator, and all three are handled below.
``format`` is kept for provenance, not because it changes the reading.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional, Sequence

#: Recognised shapes, as reported in the artifact. ``text`` is a bare lyric sheet.
FORMATS = ("srt", "vtt", "text")

#: The share of cues that must overlap the cue above before the file is read as
#: rolling. A rolling file overlaps on essentially every cue, so the two conventions
#: are far apart — but a plain file is not at zero either: a lyric line that spans two
#: adjacent cues repeats next to itself, and a tiny file can even land on half its cues
#: that way. Three quarters separates the two without being delicate, and the cost of
#: reading rolling is that a repeated line is dropped, which is the error worth
#: avoiding.
ROLLING_SHARE = 0.75
ROLLING_MIN_CUES = 3

#: ``00:01:02,345`` / ``00:01:02.345`` / ``01:02.345`` (WebVTT may omit the hours).
#: Four groups per timestamp, in order h, m, s, ms — so the second half of a cue line
#: starts at group 5. The enclosing groups are non-capturing on purpose: one stray
#: capturing group here would renumber every index in ``_cue_time``.
#:
#: The fraction is **optional**, because a whole class of real exporters writes
#: ``00:12 --> 00:17``: the free transcription tool this suite's users bring files
#: from truncates to the second in its own SRT download. Requiring ``[.,]\d{1,3}``
#: did not reject those files — it silently failed to recognise their cue lines, so
#: the file fell through to the plain-text reader and every cue number and every
#: ``00:12`` became a *word*, which then came back out as subtitle text. One
#: optional group is the difference between a lyric sheet and a timing dump.
_TIME = r"(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?"
_CUE_RE = re.compile(rf"^\s*(?:{_TIME})\s*-->\s*(?:{_TIME})")

#: Formatting that is never sung: ``<v Singer>``, ``<c.yellow>``, ``{\an8}``.
_TAG_RE = re.compile(r"<[^>]*>|\{[^}]*\}")

#: A bracket group, e.g. ``[Chorus]`` or ``(oh yeah)``.
_BRACKET_RE = re.compile(r"[\[(]([^\[\]()]*)[\])]")

#: A counter rather than a word: ``2``, ``x2``, ``×4``.
_COUNT_RE = re.compile(r"[x×]?\d+")

#: The closed vocabulary of section labels. Closed on purpose: ``(oh yeah)`` is a
#: lyric, and dropping it would be the studio inventing words rather than reading
#: them, so a bracket group is only thrown away when it names a section.
_SECTIONS = frozenset(
    {
        "verse", "chorus", "pre chorus", "prechorus", "post chorus", "bridge", "intro",
        "outro", "hook", "refrain", "instrumental", "solo", "guitar solo", "break",
        "interlude", "tag", "spoken", "ad lib", "adlib", "repeat", "drop", "build",
        "buildup", "instrumental break", "fade", "end",
    }
)

#: Keys inside a WebVTT block that carry no lyric.
_VTT_KEYWORDS = ("webvtt", "note", "style", "region", "x-timestamp-map", "kind:", "language:")


class ReferenceParseError(RuntimeError):
    """The file is not a lyric sheet this studio can read."""


# --------------------------------------------------------------------------- #
# text handling
# --------------------------------------------------------------------------- #


def match_key(text: str) -> str:
    """
    The form in which two words are compared: lowercase letters and digits only.

    Folding punctuation away is what makes the comparison useful, because a
    transcript and a lyric sheet disagree about apostrophes far more often than
    about words: ``won't``/``wont``, ``I'm``/``Im`` and ``Love,``/``love`` all have
    to be the *same* key, or a spelling difference reads as a missing word and the
    reconciliation starts inserting.
    """
    return "".join(char for char in str(text).lower() if char.isalnum())


def _looks_like_section(text: str) -> bool:
    tokens = [t for t in re.split(r"[\s._\-–—/]+", text) if t and not _COUNT_RE.fullmatch(t)]
    return bool(tokens) and " ".join(tokens).lower() in _SECTIONS


def _strip_markers(line: str) -> str:
    """Remove bracket groups that name a section, and leave the sung ones alone."""

    def swap(match: "re.Match[str]") -> str:
        return " " if _looks_like_section(match.group(1)) else match.group(0)

    return _BRACKET_RE.sub(swap, line)


def _is_marker(line: str) -> bool:
    """True for ``[Chorus]``, ``Verse 2:`` and ``(x2)`` — but not for ``(oh yeah)``."""
    if not _strip_markers(line).strip():
        return _BRACKET_RE.search(line) is not None
    stripped = line.strip()
    return stripped.endswith(":") and _looks_like_section(stripped.rstrip(":"))


def _lyric_line(raw: str) -> str:
    """One line of the file as a lyric: markup off, labels dropped. ``''`` = not a lyric."""
    if _is_marker(raw):
        return ""
    return " ".join(_TAG_RE.sub(" ", _strip_markers(raw)).split())


def _seconds(hours: Optional[str], minutes: str, seconds: str, millis: Optional[str]) -> float:
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int((millis or "0").ljust(3, "0")) / 1000.0


def _cue_time(match: "re.Match[str]", base: int) -> float:
    return _seconds(*(match.group(base + offset) for offset in range(4)))


def _split_blocks(text: str) -> list[list[str]]:
    """Split on blank lines — both formats separate cues that way."""
    blocks: list[list[str]] = []
    current: list[str] = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        if line.strip():
            current.append(line)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    return blocks


def _detect_format(text: str, blocks: Sequence[Sequence[str]]) -> str:
    if text.lstrip().lower().startswith("webvtt"):
        return "vtt"
    if any(_CUE_RE.match(line) for block in blocks for line in block):
        return "srt"
    return "text"


def _words_in(lines: Iterable[str]) -> list[str]:
    """
    Flatten lines into words.

    A token with no letter or digit in it (``—``, ``...``, ``?``) is dropped: it is
    punctuation the file used for layout, and a reference word has to be something
    that can be sung.
    """
    out: list[str] = []
    for line in lines:
        for token in line.split():
            if match_key(token):
                out.append(token)
    return out


def _overlap(previous: Sequence[str], current: Sequence[str]) -> int:
    """Largest ``k`` for which the last ``k`` lines above are the first ``k`` here."""
    for size in range(min(len(previous), len(current)), 0, -1):
        if list(previous[-size:]) == list(current[:size]):
            return size
    return 0


# --------------------------------------------------------------------------- #
# the model
# --------------------------------------------------------------------------- #


@dataclass
class Cue:
    """One subtitle cue: its window, and the lines it **adds** to the file."""

    start: Optional[float]
    end: Optional[float]
    lines: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        out: dict = {"lines": list(self.lines)}
        if self.start is not None:
            out["start"] = self.start
        if self.end is not None:
            out["end"] = self.end
        return out


@dataclass
class Reference:
    """
    A lyric sheet, flat and in order.

    Cue timings are kept for provenance and for a human reading the artifact, and
    are deliberately **not** used to place words: a subtitle file is routinely cut
    for a different edit of the song, so its clock is not this audio's clock. The
    transcript's own timing is the only time authority in the reconcile pass.
    """

    name: str = ""
    format: str = "text"
    rolling: bool = False
    cues: list[Cue] = field(default_factory=list)
    words: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def word_count(self) -> int:
        return len(self.words)

    def match_keys(self) -> list[str]:
        return [match_key(word) for word in self.words]

    def to_dict(self) -> dict:
        """A compact record of the file's *shape*, not a second copy of it."""
        return {
            "name": self.name,
            "format": self.format,
            "rolling": self.rolling,
            "cues": len(self.cues),
            "words": len(self.words),
            "warnings": list(self.warnings),
        }

    @classmethod
    def from_text(cls, text: str, name: str = "", format: Optional[str] = None) -> "Reference":
        reference = parse_reference(text, name=name, format=format)
        if not reference.words:
            raise ReferenceParseError(
                f"{name or 'the reference'} contains no words; expected lyrics as .srt, .vtt or plain text"
            )
        return reference

    @classmethod
    def from_file(cls, path: "str | Path") -> "Reference":
        target = Path(path)
        try:
            text = target.read_text(encoding="utf-8-sig", errors="replace")
        except OSError as exc:
            raise ReferenceParseError(f"could not read {target}: {exc}") from exc
        return cls.from_text(text, name=target.name)


def parse_reference(text: str, name: str = "", format: Optional[str] = None) -> Reference:
    """
    Read a lyric sheet.

    Never guesses: an unreadable file yields *no* words, and ``Reference.from_text``
    turns that into an error rather than into an empty pass that looks successful.
    """
    normalised = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    blocks = _split_blocks(normalised)
    detected = format if format in FORMATS else _detect_format(normalised, blocks)

    if detected == "text":
        lines = [line for line in (_lyric_line(raw) for raw in normalised.split("\n")) if line]
        words = _words_in(lines)
        return Reference(
            name=name,
            format="text",
            rolling=False,
            cues=[Cue(None, None, tuple(lines))] if words else [],
            words=words,
        )

    raw_cues: list[tuple[Optional[float], Optional[float], list[str]]] = []
    for block in blocks:
        start = end = None
        body: list[str] = []
        for line in block:
            match = _CUE_RE.match(line)
            if match:
                start = _cue_time(match, 1)
                end = _cue_time(match, 5)
                # Everything above the timestamp is an identifier — an SRT cue number
                # or a WebVTT cue id — and never a lyric. Reading them as words is
                # what turns a 255-word lyric sheet into a 793-word one.
                body = []
                continue
            if start is None or line.strip().lower().startswith(_VTT_KEYWORDS):
                continue
            body.append(line)
        if start is None:
            # A cue identifier, a NOTE, or the WEBVTT header: no timing, no lyric.
            continue
        raw_cues.append((start, end, [line for line in (_lyric_line(raw) for raw in body) if line]))

    if not raw_cues:
        return Reference(name=name, format=detected, rolling=False, cues=[], words=[])

    overlaps = [_overlap(above[2], below[2]) for above, below in zip(raw_cues, raw_cues[1:])]
    share = sum(1 for size in overlaps if size) / len(overlaps) if overlaps else 0.0
    rolling = len(raw_cues) >= ROLLING_MIN_CUES and share >= ROLLING_SHARE

    cues: list[Cue] = []
    empty = 0
    for index, (start, end, body) in enumerate(raw_cues):
        lines = body if index == 0 or not rolling else body[_overlap(raw_cues[index - 1][2], body) :]
        if not lines:
            empty += 1
        cues.append(Cue(start, end, tuple(lines)))

    warnings: list[str] = []
    if rolling:
        warnings.append(
            f"read as a rolling subtitle file ({share:.0%} of cues repeat the cue above), "
            "so a repeated line was counted once"
        )
    if empty:
        warnings.append(f"{empty} cue(s) carried no lyric")

    words = _words_in(line for cue in cues for line in cue.lines)
    return Reference(name=name, format=detected, rolling=rolling, cues=cues, words=words, warnings=warnings)


__all__ = [
    "FORMATS",
    "ROLLING_MIN_CUES",
    "ROLLING_SHARE",
    "Cue",
    "Reference",
    "ReferenceParseError",
    "match_key",
    "parse_reference",
]
