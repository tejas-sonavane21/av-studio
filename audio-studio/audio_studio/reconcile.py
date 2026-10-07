"""
reconcile.py — cast the transcript onto the original lyrics.

    the audio's timing  +  the lyric sheet's words  ─▶  a transcript with both

A transcriber answers two questions at once and is far better at one of them than
the other. *When* a word was sung is a **measurement** — someone was in the
recording at that moment. *What* was sung is a **guess** drawn from the audio and
the language, and on a sung track with a music bed under it that guess is where
every one of the remaining errors lives. Hand the studio the words and there is
nothing left to guess.

So this pass keeps the transcript's clock and takes the file's spelling. Sequence
alignment decides which reference word is which transcript word; everything else
follows from that mapping.

## Three rules, all deliberate

**Timing is the transcript's, spelling is the file's.** A word the file and the
transcript agree on keeps the transcriber's window and takes the file's text, so
``whould`` becomes ``would`` without moving. A word the file has and the
transcript does not is *inserted*, and its window is interpolated between its
neighbours and marked as interpolated in the record: alignment a rung later
(``--align wav2vec``) is what re-times it against the audio, which is exactly why
this pass runs **before** alignment in ``pipeline.py``. Run the other way round,
inserted words would arrive after the aligner had finished and keep a made-up time.

**A file that is not this song is refused, not applied.** A lyric sheet for the
wrong track would rewrite the whole transcript with confident nonsense — the worst
possible failure, because it would look like success. The pass measures how much
of the audio and the file agree, and below ``ReconcileOptions.min_match`` it
changes nothing, records why, and warns.

**Nothing is silent.** Every rewrite, insertion and deletion is a ledger entry, the
same way ``validate/ledger.py`` records its corrections, so the result can be
audited afterwards without rerunning anything. The entries are numbered against
the transcript *as it was before this pass*, because that is the document the
indices refer to.

Everything here is pure: same transcript + same reference ⇒ byte-identical output.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

from .config import ReconcileOptions
from .model import Segment, Transcript, Word, normalize_transcript, round_time
from .reference import Reference, match_key
from .validate.ledger import classify

ProgressHook = Callable[[float, str], None]

#: No reconciled word is left with a window shorter than this. Interpolation across
#: a boundary can otherwise hand two words the same instant, and a zero-length word
#: is a word no caption editor can show — the offline rules validator reports it.
MIN_WORD_DURATION = 0.02

#: An inserted run placed across a window wider than this is worth saying out loud.
#: It is not an error (alignment will re-time it), but it is usually a sign that the
#: transcription missed a whole line rather than a word.
INSERT_WARN_WINDOW = 5.0

#: No interpolated word is given a window longer than this.
#:
#: Without it, a line the transcriber missed inside a long instrumental break is
#: spread over the whole of it — one word, on screen for three seconds. The window is
#: still spent from its beginning, so the run sits at the earliest plausible moment
#: after the word before it, and a later alignment is free to move it to the right
#: place. Capping trades a wrong-but-precise duration for a bounded, honest one.
INSERT_WORD_CAP = 1.0


# --------------------------------------------------------------------------- #
# the analysis
# --------------------------------------------------------------------------- #


@dataclass
class _Word:
    text: str
    start: float
    end: float


@dataclass
class _Analysis:
    """What the alignment decided, before anything is written down."""

    refusal: str = ""
    matched: int = 0
    rate: float = 0.0
    placed: list[_Word] = field(default_factory=list)
    segment_of: list[int] = field(default_factory=list)
    edits: list[dict] = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    wide_inserts: int = 0


def _flat(transcript: Transcript) -> list[tuple[int, int, Word]]:
    return [
        (segment_index, word_index, word)
        for segment_index, segment in enumerate(transcript.segments)
        for word_index, word in enumerate(segment.words)
    ]


def _distribute(keys: Sequence[str], start: float, end: float) -> list[tuple[float, float]]:
    """
    Lay ``keys`` out across ``[start, end]`` in proportion to their length.

    Length is the weight rather than an even split because a long word takes longer
    to sing than a short one, and the interpolated windows are the starting point the
    aligner then fits to the audio. An empty window degrades to zero-length windows at
    its edge, which the monotonic pass below widens again; an overly generous one is
    capped per word at ``INSERT_WORD_CAP``.
    """
    weights = [max(1, len(key)) for key in keys]
    total = sum(weights) or 1
    span = max(0.0, end - start)
    out: list[tuple[float, float]] = []
    cursor = start
    for weight in weights:
        share = min(INSERT_WORD_CAP, span * weight / total)
        out.append((round_time(cursor), round_time(cursor + share)))
        cursor += share
    return out


def _tail(transcript: Transcript, flat: Sequence[tuple[int, int, Word]]) -> float:
    """The end of the audio, from the transcript's own duration or its last word."""
    return max(transcript.duration, flat[-1][2].end) if flat else transcript.duration


def _insert_run(
    keys: Sequence[str],
    words: Sequence[str],
    left: float,
    right: float,
    slots: list[Optional[tuple[float, float]]],
    slot_start: int,
    edits: list[dict],
) -> tuple[int, int]:
    """Place a run of reference words the transcript has no timing for. ``(inserted, wide)``."""
    windows = _distribute(keys, left, right)
    # Judged on the window, not on the words: the words are capped, so it is the size
    # of the hole they had to be spread across that says a whole line went missing.
    wide = 1 if windows and right - left > INSERT_WARN_WINDOW else 0
    for offset, (start, end) in enumerate(windows):
        slots[slot_start + offset] = (start, end)
        edits.append(
            {
                "op": "insert",
                "to": words[offset],
                "start": round_time(start),
                "interpolated": True,
            }
        )
    return len(windows), wide


def _segment_for_time(segments: Sequence[Segment], moment: float) -> int:
    """
    The segment a moment belongs to: the last one that had already started.

    The last, rather than "the window that contains it", because a word can land in
    the silence *between* two segments — inserted lyrics usually do — and a moment
    in no window at all would otherwise fall off the end of the list.
    """
    chosen = 0
    for index, segment in enumerate(segments):
        if segment.start <= moment:
            chosen = index
        else:
            break
    return chosen


def _analyse(transcript: Transcript, reference: Reference, options: ReconcileOptions) -> _Analysis:
    flat = _flat(transcript)
    transcript_keys = [match_key(word.text) for _, _, word in flat]
    reference_keys = reference.match_keys()

    if not flat:
        return _Analysis(refusal="the transcript has no words to reconcile against")
    if not reference_keys:
        return _Analysis(refusal="the reference has no words")

    # `autojunk` off: a lyric sheet is full of repeated words ("the", "I", "you"),
    # which is exactly the input difflib's heuristic mis-handles.
    matcher = difflib.SequenceMatcher(a=transcript_keys, b=reference_keys, autojunk=False)
    opcodes = matcher.get_opcodes()
    matched = sum(i2 - i1 for tag, i1, i2, _j1, _j2 in opcodes if tag == "equal")
    rate = matched / max(len(transcript_keys), len(reference_keys))

    if rate < options.min_match:
        return _Analysis(
            matched=matched,
            rate=rate,
            refusal=(
                f"the lyrics and the audio agree on only {rate:.1%} of words "
                f"({matched} of {max(len(transcript_keys), len(reference_keys))}), "
                f"below the {options.min_match:.0%} floor: this does not look like the same recording"
            ),
        )

    slots: list[Optional[tuple[float, float]]] = [None] * len(reference_keys)
    edits: list[dict] = []
    counts = {"kept": 0, "rewritten": 0, "inserted": 0, "deleted": 0}
    wide_inserts = 0

    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            for offset in range(j2 - j1):
                _segment_index, _word_index, word = flat[i1 + offset]
                text = reference.words[j1 + offset]
                slots[j1 + offset] = (word.start, word.end)
                if text == word.text:
                    counts["kept"] += 1
                else:
                    counts["rewritten"] += 1
                    edits.append(
                        {
                            "op": "replace",
                            "type": classify(word.text, text),
                            "from": word.text,
                            "to": text,
                            "index": i1 + offset,
                            "start": round_time(word.start),
                        }
                    )
            continue

        if tag == "delete":
            # Words the transcriber heard and the lyric sheet does not have: an
            # invented word, a hallucinated line, or a line the file omits.
            for position in range(i1, i2):
                word = flat[position][2]
                counts["deleted"] += 1
                edits.append(
                    {"op": "delete", "from": word.text, "index": position, "start": round_time(word.start)}
                )
            continue

        if tag == "replace":
            # Both sides have words and they differ. Pair them **positionally** rather
            # than deleting the transcript's and inserting the file's, because the most
            # common disagreement by far is one word the transcriber misheard — and the
            # two words then stand in the same place, where the timing is already
            # measured. Deleting and re-inserting instead would invent a window for the
            # replacement from the silence either side of it, which for a misheard word
            # is no window at all and would squeeze the word to zero length.
            paired = min(i2 - i1, j2 - j1)
            for offset in range(paired):
                word = flat[i1 + offset][2]
                text = reference.words[j1 + offset]
                slots[j1 + offset] = (word.start, word.end)
                counts["rewritten"] += 1
                edits.append(
                    {
                        "op": "replace",
                        "type": classify(word.text, text),
                        "from": word.text,
                        "to": text,
                        "index": i1 + offset,
                        "start": round_time(word.start),
                    }
                )
            for position in range(i1 + paired, i2):
                word = flat[position][2]
                counts["deleted"] += 1
                edits.append(
                    {"op": "delete", "from": word.text, "index": position, "start": round_time(word.start)}
                )
            if j2 - j1 > paired:
                # What is left of the file's version spills past the paired words and
                # has to be placed — it is the one part of a replace that is invented.
                left = flat[i1 + paired - 1][2].end
                right = flat[i2][2].start if i2 < len(flat) else _tail(transcript, flat)
                inserted, wide = _insert_run(
                    reference_keys[j1 + paired : j2],
                    reference.words[j1 + paired : j2],
                    left,
                    max(right, left),
                    slots,
                    j1 + paired,
                    edits,
                )
                counts["inserted"] += inserted
                wide_inserts += wide
            continue

        # `insert`: the file has words the transcript has no timing for at all, so they
        # are spread across the window between the words either side.
        left = flat[i1 - 1][2].end if i1 > 0 else 0.0
        right = flat[i1][2].start if i1 < len(flat) else _tail(transcript, flat)
        inserted, wide = _insert_run(
            reference_keys[j1:j2],
            reference.words[j1:j2],
            left,
            max(right, left),
            slots,
            j1,
            edits,
        )
        counts["inserted"] += inserted
        wide_inserts += wide

    placed: list[_Word] = []
    cursor = 0.0
    for index, slot in enumerate(slots):
        # Every reference word is covered by an opcode, so a missing slot would be a
        # bug in this function rather than bad input; skipping is the safe reaction.
        if slot is None:
            continue
        start, end = slot
        start = max(start, cursor)
        end = max(end, start + MIN_WORD_DURATION)
        placed.append(_Word(reference.words[index], round_time(start), round_time(end)))
        cursor = end

    segment_of = [_segment_for_time(transcript.segments, word.start) for word in placed]
    return _Analysis(
        matched=matched,
        rate=rate,
        placed=placed,
        segment_of=segment_of,
        edits=edits,
        counts=counts,
        wide_inserts=wide_inserts,
    )


# --------------------------------------------------------------------------- #
# the pass
# --------------------------------------------------------------------------- #


def reconcile(
    transcript: Transcript,
    reference: Reference,
    options: Optional[ReconcileOptions] = None,
    on_progress: Optional[ProgressHook] = None,
) -> Transcript:
    """
    Return ``transcript`` with the reference's words and the audio's timing.

    The word count may change. Nothing else about the file moves: segments keep
    their windows where the words allow, and ``normalize_transcript`` re-derives
    the rest (text, ids, gaps, duration).
    """
    options = options or ReconcileOptions()
    _say(on_progress, 0.1, f"{reference.word_count} word(s) of lyrics from {reference.name or 'the reference'}")

    analysis = _analyse(transcript, reference, options)
    if analysis.refusal:
        _say(on_progress, 1.0, f"refused: {analysis.refusal}")
        return _refuse(transcript, reference, options, analysis)

    record = _record(reference, options, analysis)
    out = _rebuild(transcript, analysis)
    out.reference = record

    changed = analysis.counts["inserted"] + analysis.counts["deleted"] + analysis.counts["rewritten"]
    if changed:
        dropped = _drop_stale_provenance(out)
        if dropped:
            record["dropped"] = dropped
            out.warnings.append(_dropped_note(dropped))
    for warning in reference.warnings:
        out.warnings.append(f"reference: {warning}")
    if analysis.wide_inserts:
        out.warnings.append(
            f"reference: {analysis.wide_inserts} inserted run(s) span more than "
            f"{INSERT_WARN_WINDOW:g}s of audio, so their timing is interpolated until a pass re-times it"
        )

    _say(
        on_progress,
        1.0,
        f"{analysis.counts['rewritten']} rewritten, {analysis.counts['inserted']} inserted, "
        f"{analysis.counts['deleted']} deleted ({analysis.rate:.0%} of the audio matched the file)",
    )
    return out


def _rebuild(transcript: Transcript, analysis: _Analysis) -> Transcript:
    buckets: dict[int, list[Word]] = {}
    for word, segment_index in zip(analysis.placed, analysis.segment_of):
        buckets.setdefault(segment_index, []).append(Word(text=word.text, start=word.start, end=word.end))

    segments: list[Segment] = []
    for segment_index in sorted(buckets):
        old = transcript.segments[segment_index]
        segments.append(
            Segment(
                start=old.start,
                end=old.end,
                words=buckets[segment_index],
                id=old.id,
                # The acoustic verdict still belongs to this stretch of audio; only
                # the words inside it changed.
                no_speech_probability=old.no_speech_probability,
            )
        )

    _fit_windows(segments)

    fresh = Transcript(
        segments=segments,
        language=transcript.language,
        duration=transcript.duration,
        source=dict(transcript.source),
        engine=dict(transcript.engine),
        alignment=dict(transcript.alignment) if transcript.alignment else None,
        validation=dict(transcript.validation) if transcript.validation else None,
        corrections=list(transcript.corrections),
        meta=dict(transcript.meta),
    )
    normalize_transcript(fresh)
    # `normalize_transcript` recomputes `warnings` from the structure, so anything
    # said before it is said after it instead.
    return fresh


def _fit_windows(segments: Sequence[Segment]) -> None:
    """
    Keep each segment's own window, but never let it reach past its neighbour's words.

    The transcriber's window is worth keeping: it is the aligner's idea of where to
    listen, and ``align/apply.py`` spends it as context. What it must not do is grow
    into the segment after it, which is exactly what happens when the file puts a
    word in the silence between two lines and the word is attached to the earlier
    one. Two overlapping segments make ``normalize_transcript`` slide the later one
    forward, and *every* following segment slides with it — the drift this suite
    exists to remove, reintroduced by the pass that was supposed to remove errors.

    In-place, and it relies on the words being globally monotonic (which the
    analysis guarantees), so the clamp can never cut a segment off from its own
    words.
    """
    for index, segment in enumerate(segments):
        if not segment.words:
            continue
        first, last = segment.words[0].start, segment.words[-1].end
        start, end = min(segment.start, first), max(segment.end, last)
        if index:
            start = max(start, segments[index - 1].words[-1].end)
        if index + 1 < len(segments):
            end = min(end, segments[index + 1].words[0].start)
        segment.start = round_time(max(0.0, start))
        segment.end = round_time(max(end, last))


def _listing(names: Sequence[str]) -> str:
    """``a``, ``a and b``, ``a, b and c``."""
    items = list(names)
    if len(items) <= 1:
        return items[0] if items else ""
    return f"{', '.join(items[:-1])} and {items[-1]}"


def _drop_stale_provenance(transcript: Transcript) -> dict:
    """
    Forget the records that described the *old* word list.

    An alignment's shift per segment and a validation's applied corrections are
    statements about specific words. Keeping them next to a word list they no longer
    match would make the artifact assert something untrue, so they go — and the
    fact that they went is written down, which is the difference between forgetting
    and hiding.
    """
    dropped: dict = {}
    if transcript.alignment:
        dropped["alignment"] = True
        transcript.alignment = None
    if transcript.validation:
        dropped["validation"] = True
        transcript.validation = None
    if transcript.corrections:
        dropped["corrections"] = len(transcript.corrections)
        transcript.corrections = []
    return dropped


def _dropped_note(dropped: dict) -> str:
    labels = {
        "alignment": "alignment",
        "validation": "validation record",
        "corrections": "corrections ledger",
    }
    names = [labels.get(key, key) for key in dropped]
    verb = "was" if len(names) == 1 else "were"
    return (
        f"the reference pass changed the word list, so the previous {_listing(names)} {verb} "
        "dropped rather than left describing words that no longer exist"
    )


def _record(reference: Reference, options: ReconcileOptions, analysis: _Analysis) -> dict:
    return {
        "pass": "reconcile",
        "name": reference.name,
        "format": reference.format,
        "rolling": reference.rolling,
        "cues": len(reference.cues),
        "words": reference.word_count,
        "matched": analysis.matched,
        "matchRate": round(analysis.rate, 4),
        "minMatch": options.min_match,
        "outcome": "applied",
        "counts": dict(analysis.counts),
        "insertWarnWindow": INSERT_WARN_WINDOW,
        "wideInserts": analysis.wide_inserts,
        "indices": "relative to the transcript as it was before this pass",
        "edits": list(analysis.edits),
        "warnings": list(reference.warnings),
    }


def _refuse(
    transcript: Transcript,
    reference: Reference,
    options: ReconcileOptions,
    analysis: _Analysis,
) -> Transcript:
    """Record the refusal on an untouched transcript — never a silent no-op."""
    record = {
        "pass": "reconcile",
        "name": reference.name,
        "format": reference.format,
        "rolling": reference.rolling,
        "cues": len(reference.cues),
        "words": reference.word_count,
        "matched": analysis.matched,
        "matchRate": round(analysis.rate, 4),
        "minMatch": options.min_match,
        "outcome": "refused",
        "reason": analysis.refusal,
        "counts": {"kept": analysis.matched, "rewritten": 0, "inserted": 0, "deleted": 0},
        "indices": "relative to the transcript as it was before this pass",
        "edits": [],
        "warnings": list(reference.warnings),
    }
    # A copy, not the argument: this module is a function of its inputs, and a
    # refusal that quietly edited the transcript it was handed would make that false.
    return Transcript(
        segments=list(transcript.segments),
        language=transcript.language,
        duration=transcript.duration,
        source=dict(transcript.source),
        engine=dict(transcript.engine),
        alignment=dict(transcript.alignment) if transcript.alignment else None,
        validation=dict(transcript.validation) if transcript.validation else None,
        reference=record,
        gaps=list(transcript.gaps),
        corrections=list(transcript.corrections),
        warnings=list(transcript.warnings) + [f"reference: refused — {analysis.refusal}"],
        meta=dict(transcript.meta),
    )


def _say(on_progress: Optional[ProgressHook], fraction: float, message: str) -> None:
    if on_progress is not None:
        on_progress(fraction, message)


__all__ = ["INSERT_WARN_WINDOW", "INSERT_WORD_CAP", "MIN_WORD_DURATION", "reconcile"]
