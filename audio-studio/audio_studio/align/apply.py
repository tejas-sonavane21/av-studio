"""
align/apply.py — turning aligned spans into a transcript.

This is where the two authorities of the suite meet, and where they are kept
apart:

    the **aligner** is the timing authority  → it may change ``start`` / ``end``
    the **transcript** is the spelling authority → its ``text`` is never touched

So this module rewrites *when* and never *what*. A word's text, a segment's text
and the word count come out identical to what went in; only the numbers move.
That single invariant is what makes alignment safe to run on a transcript the
user has already corrected by hand — and it is the invariant the tests assert
directly, because a "fix" that quietly rewords a lyric is worse than drift.

Everything here is pure: same transcript + same spans ⇒ byte-identical output.

There is also a fourth, structural rule, and it is the one that protects the whole
file rather than one word: **a segment's words may not leave the space the
transcriber allocated to that segment plus the silence around it.** The window
``limits_for`` describes is shared with the backend (so the acoustic model is
asked about the same region) and enforced again here (so no backend can ignore
it). Without it, words from one segment leak into the next, the next overlaps,
and ``normalize_transcript`` slides it forward — and because every following
segment then does the same, a 0.3 s leak at the start becomes a second of lag by
the end of the song. Measured, not theorised: an earlier version of this module
leaked by design and drifted 1.25 s on average against the transcriber.

Three guards decide whether a segment's alignment is believable at all, because a
CTC path over a music bed *can* be confidently wrong, and a wrong-but-confident
onset is exactly the drift this studio exists to remove:

``min_confidence``
    the segment's mean per-word posterior. Below it, the segment keeps its
    original timings and says so.
``max_shift``
    no word may move further than this from where the transcriber put it. A word
    that has to move half a second to fit the audio was not heard there.
``word count``
    a segment whose span list does not match its word list is a bug in a backend,
    not an alignment; it is refused rather than partially applied.
"""

from __future__ import annotations

from typing import Optional

from ..config import AlignOptions
from ..model import MIN_WORD_DURATION, Segment, Transcript, Word, normalize_transcript
from .base import AlignmentResult, WordSpan


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def limits_for(transcript: Transcript, index: int, options: AlignOptions) -> tuple[float, float]:
    """
    How far a segment's words may reach: its own window, plus the silence around it.

    ``window_pad`` is therefore available only where there is a gap to spend. Two
    contiguous segments have nothing between them, so the first may not reach into
    the second at all — which is what stops alignment from cascading into a
    cumulative, and entirely fictitious, lag.

    The recording's own end is a hard edge as well, and it is the last one: the
    aligner hears the music, and the tail of a song is where a choir, a reverb or an
    outro gives it something plausible to latch onto. Moving the last words past the
    audio is how a caption ends up being displayed after the song has stopped.
    """
    segment = transcript.segments[index]
    previous_end = transcript.segments[index - 1].end if index else 0.0
    left = max(previous_end, segment.start - options.window_pad)
    right = segment.end + options.window_pad
    if index + 1 < len(transcript.segments):
        right = min(right, transcript.segments[index + 1].start)
    if transcript.duration > 0:
        right = min(right, transcript.duration)
    if right < left:
        return segment.start, segment.end
    return left, right


def _fill_gaps(spans: list[Optional[WordSpan]], words: list[Word]) -> tuple[list[WordSpan], int]:
    """
    Give every word a span, interpolating for the ones the aligner skipped.

    An interpolated span is bounded by its aligned neighbours, so it can never
    push a word out of order or invent time that belongs to another word. A word
    the aligner could not place at all (no aligned neighbour either side) keeps its
    original window — the honest answer, and the callers count them.
    """
    filled: list[Optional[WordSpan]] = list(spans)
    interpolated = 0
    for index, span in enumerate(filled):
        if span is not None:
            continue
        previous = next((filled[i] for i in range(index - 1, -1, -1) if filled[i]), None)
        following = next((filled[i] for i in range(index + 1, len(filled)) if filled[i]), None)
        if previous is None and following is None:
            filled[index] = WordSpan(words[index].start, words[index].end, 0.0)
        else:
            low = previous.end if previous else following.start
            high = following.start if following else previous.end
            filled[index] = WordSpan(min(low, high), max(low, high), 0.0)
        interpolated += 1
    return [span for span in filled if span is not None], interpolated


def _retime(
    segment: Segment,
    spans: list[Optional[WordSpan]],
    options: AlignOptions,
    limits: tuple[float, float],
) -> tuple[Optional[Segment], str, int, int]:
    """
    ``(segment, status, interpolated, clamped)``. ``segment`` is ``None`` when the
    alignment is not believable and the original must stand.
    """
    words = segment.words
    if not words:
        return None, "empty", 0, 0
    if spans is None or len(spans) != len(words):
        return None, "shape", 0, 0

    provided = [span for span in spans if span is not None]
    if not provided:
        return None, "unplaced", 0, 0

    confidence = _mean([max(0.0, min(1.0, span.confidence)) for span in provided])
    if confidence < options.min_confidence:
        return None, "confidence", 0, 0

    # Paired by *position*, never by packing the provided spans against the front
    # of the word list. Those two are not the same thing as soon as the aligner
    # skips a word: with a gap in the middle, packing slides every later span onto
    # the wrong word, and a 17 s misplacement then passes a 1 s guard. Onsets only,
    # too — how long a transcriber *thinks* a word lasted is the softest number it
    # reports, and refusing a segment for stretching one would make this guard a
    # reason not to align anything.
    shift = max(
        (abs(span.start - words[index].start) for index, span in enumerate(spans) if span is not None),
        default=0.0,
    )
    if shift > options.max_shift:
        return None, "shift", 0, 0

    filled, interpolated = _fill_gaps(spans, words)
    left, right = limits

    retimed: list[Word] = []
    cursor = 0.0
    clamped = 0
    for word, span in zip(words, filled):
        start = max(0.0, min(span.start, span.end))
        end = max(start, span.end)
        if start < left or end > right:
            # Both ends are clamped *into* the window rather than each being clamped
            # on its own. Clamping them independently looks equivalent and is not: a
            # span lying wholly outside the window collapses to a zero-length word
            # sitting at its own, out-of-window start — a word no editor can show and
            # the rules validator rejects — which is a worse outcome than the drift
            # the clamp was there to remove.
            start = min(max(start, left), right)
            end = min(max(end, start), right)
            if end - start < MIN_WORD_DURATION:
                start = max(left, min(start, end - MIN_WORD_DURATION))
            clamped += 1
        # The path is non-decreasing by construction, so this only ever bites on
        # an interpolated span or a genuinely bad backend — either way, never
        # silently: the segment reports how many words it had to nudge.
        if retimed and start < cursor:
            limit = min(cursor, right)
            start, end = limit, max(end, limit)
        cursor = end
        retimed.append(Word(text=word.text, start=start, end=end, probability=word.probability, id=word.id))

    return (
        Segment(
            start=segment.start,
            end=segment.end,
            words=retimed,
            text=segment.text,
            id=segment.id,
            no_speech_probability=segment.no_speech_probability,
        ),
        "aligned",
        interpolated,
        clamped,
    )


def apply_alignment(
    transcript: Transcript,
    result: AlignmentResult,
    options: Optional[AlignOptions] = None,
) -> Transcript:
    """
    Return a new transcript with the aligned word timings applied.

    The input is not modified: this is a transformation, and a caller that wants
    to compare the two has to still have the original.
    """
    options = options or AlignOptions()

    segments: list[Segment] = []
    statuses: dict[str, int] = {}
    shifts: list[float] = []
    confidences: list[float] = []
    aligned_words = 0
    interpolated_total = 0
    clamped_total = 0
    warnings: list[str] = []

    for index, segment in enumerate(transcript.segments):
        spans = result.spans[index] if index < len(result.spans) else None
        retimed, status, interpolated, clamped = _retime(
            segment, spans, options, limits_for(transcript, index, options)
        )
        statuses[status] = statuses.get(status, 0) + 1
        if retimed is None:
            segments.append(segment)
            continue
        clamped_total += clamped

        for word, fresh in zip(segment.words, retimed.words):
            shifts.append(abs(fresh.start - word.start))
        confidences.extend(max(0.0, min(1.0, span.confidence)) for span in (spans or []) if span is not None)
        aligned_words += len(retimed.words)
        interpolated_total += interpolated
        if interpolated:
            warnings.append(
                f"{segment.id or 'segment'}: {interpolated} word(s) had nothing alignable "
                "and were interpolated between their neighbours"
            )
        segments.append(retimed)

    if clamped_total:
        warnings.append(
            f"{clamped_total} word(s) were pulled back inside the space their segment owns: an "
            "alignment may not reach into the next segment — the error would compound down the "
            "file — and may not reach past the end of the recording"
        )

    kept_segments = sum(count for status, count in statuses.items() if status != "aligned")
    if kept_segments:
        reasons = ", ".join(f"{status} {count}" for status, count in sorted(statuses.items()) if status != "aligned")
        warnings.append(
            f"{kept_segments} of {len(transcript.segments)} segment(s) kept their original timings "
            f"({reasons}) — they did not clear the alignment guards"
        )

    provenance = {
        **dict(result.provenance),
        "segments": len(transcript.segments),
        "segmentsAligned": statuses.get("aligned", 0),
        "segmentsKept": kept_segments,
        "wordsAligned": aligned_words,
        "wordsInterpolated": interpolated_total,
        "wordsClamped": clamped_total,
        "meanConfidence": round(_mean(confidences), 4),
        "meanShift": round(_mean(shifts), 4),
        "maxShift": round(max(shifts), 4) if shifts else 0.0,
        "minConfidence": options.min_confidence,
        "maxShiftLimit": options.max_shift,
    }

    fresh = Transcript(
        segments=segments,
        language=transcript.language,
        duration=transcript.duration,
        source=dict(transcript.source),
        engine=dict(transcript.engine),
        alignment=provenance,
        validation=transcript.validation,
        # The reference pass ran before this one, so its record describes the word list
        # these timings now belong to. Carried through, not rebuilt: this pass re-times a
        # transcript and has nothing to say about where its words came from, and dropping
        # the entry does not merely lose a note — an emitted artifact with no `reference`
        # block is indistinguishable from one transcribed without the lyrics, so the
        # caption editor's audit panel reports the run as if no lyrics were ever given.
        # That is exactly what the pipeline's own order (reconcile → align) would do here,
        # because alignment is the pass that runs last of the two.
        reference=dict(transcript.reference) if transcript.reference else None,
        corrections=list(transcript.corrections),
        meta=dict(transcript.meta),
    )
    normalize_transcript(fresh)

    # normalize_transcript recomputes the structural warnings from scratch, so the
    # story this pass has to tell is added back afterwards (deduplicated).
    for warning in list(result.warnings) + warnings:
        if warning not in fresh.warnings:
            fresh.warnings.append(warning)
    return fresh


__all__ = ["apply_alignment"]
