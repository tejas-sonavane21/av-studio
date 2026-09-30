"""
emit/veed.py — a Veed-master-*compatible* master JSON.

This is the bridge to ``caption-studio``. That studio's importer
(``src/io/veed-json.js``) is written against Veed's extractor output, and the
plan is explicitly *not* to rewrite it yet. So instead of asking caption-studio
to learn a new format, this emitter speaks the old one:

  * ``canvas`` present  → ``detectVeedVersion()`` reports version 3;
  * ``subtitles[].words[].{text,s,e}`` → read as the AI word stream, i.e. our
    word timings become the **timing authority**, which is the entire point;
  * no ``styles`` → no invented keyword highlighting.

The consequence is that dropping our file into caption-studio needs **zero
changes to caption-studio**: the timings are ours, and if the user also loads an
SRT the existing aligner still corrects the spelling. Vendor lock-in to the
`.mp3`+JSON pair Veed hands out is bypassed rather than removed.

Two deliberate details, both about not lying to the importer:

``style``
    The importer copies ``font``/``fontSize``/``posX``/``posY``/``align`` onto
    its own ``createDefaultStyle()`` result. We emit exactly the verified Veed
    parity values (Inter, size 0.036 of width, bottom-right 0.772/0.848, centre
    aligned), so the imported document reports itself as *unedited* rather than
    silently picking up a style change it never intended.

``emphasis``
    Veed's "auto-highlight" picks *keywords* — a model decision we cannot
    reproduce, so inventing ranges would be exactly the "silent guessing" the
    suite forbids. Default is ``'none'``: plain text, and the caption editor's
    ``emphasis.source = 'active'`` gives karaoke highlighting with no ranges at
    all. ``'all'`` covers the whole line for a solid highlight.
"""

from __future__ import annotations

import json

from ..model import GENERATOR, Transcript

KIND = "veed"
EXTENSION = ".veed.json"
OPTIONS = (
    "project_id",
    "canvas",
    "include_style",
    "emphasis",
    "include_probability",
    "indent",
)

#: The verified Veed parity style — matches caption-studio's ``createDefaultStyle()``.
PARITY_STYLE = {
    "font": "Inter",
    "fontSize": 0.036,  # fraction of canvas WIDTH (Veed parity)
    "posX": 0.772,
    "posY": 0.848,
    "align": "center",
}

#: The emphasis range payload caption-studio's own aligner produces for
#: ``auto-highlight`` keywords, copied verbatim so the ranges survive its
#: normalisation and reproduce the same emphasis flags.
EMPHASIS_STYLE = {
    "bold": False,
    "italic": True,
    "color": "#ffffff",
    "font": "Inter",
    "spacing": 0,
    "underline": True,
}

EMPHASIS_STYLE_ID = "auto-highlight"

EMPHASIS_MODES = ("none", "all")


def _range_for(text: str) -> list[dict]:
    if not text:
        return []
    return [{"from": 0, "to": len(text), "id": EMPHASIS_STYLE_ID, "style": dict(EMPHASIS_STYLE)}]


def to_veed_master(
    transcript: Transcript,
    *,
    project_id: str = "audio-studio",
    canvas: tuple[int, int] = (1280, 720),
    include_style: bool = True,
    emphasis: str = "none",
    include_probability: bool = True,
) -> dict:
    """Build the Veed-shaped document. See the module docstring for the contract."""
    if emphasis not in EMPHASIS_MODES:
        raise ValueError(f"emphasis must be one of {EMPHASIS_MODES}, got {emphasis!r}")

    width, height = canvas
    out: dict = {
        "version": "3.0",
        # provenance, ignored by the importer but auditable by a human
        "generator": GENERATOR,
        "engine": dict(transcript.engine),
        "projectId": project_id,
        "canvas": {"width": width, "height": height},
    }
    if include_style:
        out["style"] = dict(PARITY_STYLE)

    subtitles = []
    for seg in transcript.segments:
        if not seg.words and not seg.text:
            continue
        words = []
        for word in seg.words:
            entry: dict = {"text": word.text, "s": word.start, "e": word.end}
            if include_probability and word.probability is not None:
                entry["p"] = round(word.probability, 3)
            words.append(entry)
        subtitles.append(
            {
                "start": seg.start,
                "end": seg.end,
                "words": words,
                "styles": _range_for(seg.text) if emphasis == "all" else [],
            }
        )
    out["subtitles"] = subtitles
    return out


def render(transcript: Transcript, indent: int = 2, **options) -> str:
    return json.dumps(to_veed_master(transcript, **options), indent=indent, ensure_ascii=False) + "\n"
