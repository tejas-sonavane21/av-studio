"""
model.py — the transcript model. Pure data, standard library only.

This mirrors ``caption-studio/src/model/document.js`` on purpose. The two
studios exchange timing data, so they have to agree on what a *well-formed*
word stream is, and disagreeing silently is exactly the bug class that makes a
split caption drift out of sync with the audio. The invariants:

  * segments are sorted by start and never overlap;
  * words inside a segment are sorted by start and never overlap;
  * a segment's ``text`` is exactly its word texts joined by a single space —
    caption-studio's invariant is ``block.text === words.map(t => t.text).join(' ')``,
    and its Veed importer re-derives the text from the words, so a word list that
    does not join back to the text loses punctuation or invents spaces;
  * no NaN / infinities, no negative durations.

Every function here is pure: same input ⇒ byte-identical output. That is what
makes the pipeline auditable, and what makes it testable without loading a
model or touching an audio file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

SCHEMA_VERSION = 1
APP_VERSION = "0.1.0"
GENERATOR = f"audio-studio/{APP_VERSION}"

#: Timings are serialised at millisecond precision. Whisper's own output is not
#: meaningfully more precise than this, and rounding keeps artifacts small and
#: diffable (two runs of the same audio produce byte-identical JSON).
TIME_PRECISION = 3


# --------------------------------------------------------------------------- #
# small pure helpers
# --------------------------------------------------------------------------- #


def round_time(seconds: Any) -> float:
    """Round a time to millisecond precision, mapping junk to 0.0."""
    return round(_num(seconds), TIME_PRECISION)


def _num(value: Any, fallback: float = 0.0) -> float:
    """Coerce to a finite float. NaN / inf / None / garbage become ``fallback``."""
    try:
        out = float(value)
    except (TypeError, ValueError):
        return fallback
    if out != out:  # NaN
        return fallback
    if out in (float("inf"), float("-inf")):
        return fallback
    return out


def normalize_text(text: Any) -> str:
    """Collapse runs of whitespace and strip. ``None`` becomes ``''``."""
    return " ".join(str(text if text is not None else "").split())


def _pair(a: float, b: float) -> tuple[float, float]:
    """Return ``(start, end)`` ordered and rounded, never negative."""
    start = round_time(max(0.0, a))
    end = round_time(max(start, b))
    return start, end


# --------------------------------------------------------------------------- #
# Word
# --------------------------------------------------------------------------- #


@dataclass
class Word:
    """One spoken word with its own ``[start, end]`` window."""

    text: str
    start: float
    end: float
    probability: Optional[float] = None
    id: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def mid(self) -> float:
        return (self.start + self.end) / 2.0

    def normalized(self) -> "Word":
        text = normalize_text(self.text)
        start, end = _pair(_num(self.start), _num(self.end))
        prob = self.probability
        if prob is not None:
            prob = min(1.0, max(0.0, _num(prob)))
        return Word(text=text, start=start, end=end, probability=prob, id=self.id)

    def shifted(self, delta: float) -> "Word":
        """Return a copy moved by ``delta`` seconds (durations preserved)."""
        return Word(
            text=self.text,
            start=round_time(max(0.0, self.start + delta)),
            end=round_time(max(0.0, self.end + delta)),
            probability=self.probability,
            id=self.id,
        )

    def to_dict(self) -> dict:
        out: dict = {"text": self.text, "start": round_time(self.start), "end": round_time(self.end)}
        if self.id:
            out["id"] = self.id
        if self.probability is not None:
            out["probability"] = round(_num(self.probability), 3)
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Word":
        """
        Accept our own shape and the two conventions we actually receive in the
        wild: ``{text, start, end}`` and Veed-style ``{text, s, e}``.
        """
        data = data or {}
        probability = data.get("probability")
        if probability is None:
            probability = data.get("p", data.get("confidence"))
        return cls(
            text=normalize_text(data.get("text", data.get("value", ""))),
            start=_num(data.get("start", data.get("s", data.get("from", 0.0)))),
            end=_num(data.get("end", data.get("e", data.get("to", 0.0)))),
            probability=probability,
            id=str(data.get("id", "") or ""),
        )


# --------------------------------------------------------------------------- #
# Segment
# --------------------------------------------------------------------------- #


@dataclass
class Segment:
    """
    One caption-sized chunk of speech: a window, a text line, and the words.

    ``text`` is derived from ``words`` whenever words are present — never the
    other way round. That single rule is why an emitted artifact round-trips
    through caption-studio without losing or inventing a space.
    """

    start: float
    end: float
    words: list[Word] = field(default_factory=list)
    text: str = ""
    id: str = ""
    no_speech_probability: Optional[float] = None

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def normalized(self) -> "Segment":
        """Return a consistent copy: monotonic words, text rebuilt from them."""
        words: list[Word] = []
        for raw in self.words:
            word = raw if isinstance(raw, Word) else Word.from_dict(raw)
            word = word.normalized()
            if not word.text:
                continue
            if words and word.start < words[-1].end:
                word = Word(
                    text=word.text,
                    start=words[-1].end,
                    end=max(words[-1].end, word.end),
                    probability=word.probability,
                    id=word.id,
                )
            words.append(word)

        start = round_time(max(0.0, _num(self.start)))
        end = round_time(max(start, _num(self.end, start)))
        if words:
            # Words define the envelope, so a word can never fall outside it.
            start = min(start, words[0].start)
            end = max(end, words[-1].end)
        text = " ".join(w.text for w in words) if words else normalize_text(self.text)
        if not words and not text:
            text = ""

        no_speech = self.no_speech_probability
        if no_speech is not None:
            no_speech = min(1.0, max(0.0, _num(no_speech)))

        return Segment(
            start=start,
            end=end,
            words=words,
            text=text,
            id=self.id,
            no_speech_probability=no_speech,
        )

    def shifted(self, delta: float) -> "Segment":
        return Segment(
            start=round_time(max(0.0, self.start + delta)),
            end=round_time(max(0.0, self.end + delta)),
            words=[w.shifted(delta) for w in self.words],
            text=self.text,
            id=self.id,
            no_speech_probability=self.no_speech_probability,
        )

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "start": round_time(self.start),
            "end": round_time(self.end),
            "text": self.text,
            "words": [w.to_dict() for w in self.words],
        }
        if self.no_speech_probability is not None:
            out["noSpeechProbability"] = round(_num(self.no_speech_probability), 3)
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Segment":
        return cls(
            start=_num(data.get("start", 0.0)),
            end=_num(data.get("end", 0.0)),
            words=[Word.from_dict(w) for w in (data.get("words") or [])],
            text=normalize_text(data.get("text", "")),
            id=str(data.get("id", "") or ""),
            no_speech_probability=data.get("noSpeechProbability"),
        )


# --------------------------------------------------------------------------- #
# Gap
# --------------------------------------------------------------------------- #


@dataclass
class Gap:
    """A stretch of audio with no speech in it (an instrumental hole, a pause)."""

    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_dict(self) -> dict:
        return {"start": round_time(self.start), "end": round_time(self.end), "duration": round_time(self.duration)}

    @classmethod
    def from_dict(cls, data: dict) -> "Gap":
        return cls(start=_num(data.get("start", 0.0)), end=_num(data.get("end", 0.0)))


# --------------------------------------------------------------------------- #
# Transcript
# --------------------------------------------------------------------------- #


@dataclass
class Transcript:
    """The whole artifact: segments, provenance, and the audit trail."""

    segments: list[Segment] = field(default_factory=list)
    language: Optional[str] = None
    duration: float = 0.0
    source: dict = field(default_factory=dict)
    engine: dict = field(default_factory=dict)
    alignment: Optional[dict] = None
    validation: Optional[dict] = None
    #: What the reference pass did, when the user supplied the original lyrics.
    #: Same shape of record as ``alignment`` and ``validation``: a stage of the
    #: pipeline describing itself, absent when the stage did not run.
    reference: Optional[dict] = None
    gaps: list[Gap] = field(default_factory=list)
    corrections: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    # -- derived ---------------------------------------------------------- #

    @property
    def word_count(self) -> int:
        return sum(len(s.words) for s in self.segments)

    @property
    def speech_duration(self) -> float:
        return round_time(sum(s.duration for s in self.segments))

    @property
    def speech_ratio(self) -> float:
        return round(self.speech_duration / self.duration, 4) if self.duration > 0 else 0.0

    def iter_words(self):
        for seg in self.segments:
            yield from seg.words

    # -- construction ----------------------------------------------------- #

    @classmethod
    def from_segments(cls, segments: Iterable[Segment], **meta: Any) -> "Transcript":
        """Build and normalise in one step — the only sane way to make one."""
        out = cls(segments=list(segments), **meta)
        return normalize_transcript(out)

    # -- serialisation ---------------------------------------------------- #

    def to_dict(self) -> dict:
        out = {
            "schemaVersion": SCHEMA_VERSION,
            "generator": GENERATOR,
            "language": self.language,
            "duration": round_time(self.duration),
            "source": dict(self.source),
            "engine": dict(self.engine),
            "alignment": dict(self.alignment) if self.alignment else None,
            "validation": dict(self.validation) if self.validation else None,
            "reference": dict(self.reference) if self.reference else None,
            "stats": {
                "segments": len(self.segments),
                "words": self.word_count,
                "speechDuration": self.speech_duration,
                "speechRatio": self.speech_ratio,
            },
            "segments": [s.to_dict() for s in self.segments],
            "gaps": [g.to_dict() for g in self.gaps],
            "corrections": list(self.corrections),
            "warnings": list(self.warnings),
            "meta": dict(self.meta),
        }
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Transcript":
        data = data or {}
        return cls(
            segments=[Segment.from_dict(s) for s in (data.get("segments") or [])],
            language=data.get("language"),
            duration=_num(data.get("duration", 0.0)),
            source=dict(data.get("source") or {}),
            engine=dict(data.get("engine") or {}),
            alignment=dict(data["alignment"]) if data.get("alignment") else None,
            validation=dict(data["validation"]) if data.get("validation") else None,
            reference=dict(data["reference"]) if data.get("reference") else None,
            gaps=[Gap.from_dict(g) for g in (data.get("gaps") or [])],
            corrections=list(data.get("corrections") or []),
            warnings=list(data.get("warnings") or []),
            meta=dict(data.get("meta") or {}),
        )


# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #


def assign_ids(transcript: Transcript) -> Transcript:
    """
    Give every segment and word a stable, order-derived id.

    Ids are positional on purpose: re-running the pipeline on the same audio
    produces the same ids, so a diff between two artifacts shows *timing*
    changes rather than churn.
    """
    for si, seg in enumerate(transcript.segments, start=1):
        seg.id = f"seg-{si:04d}"
        for wi, word in enumerate(seg.words, start=1):
            word.id = f"w-{si:04d}-{wi:03d}"
    return transcript


def normalize_segment(segment: Segment) -> Segment:
    """In-place normalisation of one segment. Prefer :func:`normalize_transcript`."""
    fresh = segment.normalized()
    segment.start, segment.end = fresh.start, fresh.end
    segment.words, segment.text = fresh.words, fresh.text
    segment.no_speech_probability = fresh.no_speech_probability
    return segment


def _structural_warnings(transcript: Transcript) -> list[str]:
    """Warnings that are a property of the data, recomputed on every normalise."""
    warnings: list[str] = []

    for seg in transcript.segments:
        if seg.duration <= 0:
            warnings.append(f"{seg.id or 'segment'}: zero duration")
        outside = [w for w in seg.words if w.start < seg.start - 1e-6 or w.end > seg.end + 1e-6]
        if outside:
            warnings.append(f"{seg.id or 'segment'}: {len(outside)} word(s) outside the segment window")
        if seg.words and not seg.text:
            warnings.append(f"{seg.id or 'segment'}: has words but no text")

    if transcript.duration > 0:
        past = [s for s in transcript.segments if s.end > transcript.duration + 1e-6]
        if past:
            warnings.append(
                f"{len(past)} segment(s) extend past the reported duration "
                f"({transcript.duration:.3f}s)"
            )

    for i in range(1, len(transcript.segments)):
        prev, cur = transcript.segments[i - 1], transcript.segments[i]
        if cur.start < prev.end - 1e-6:
            warnings.append(f"{prev.id} and {cur.id}: overlapping windows")

    empty = sum(1 for s in transcript.segments if not s.words)
    if empty:
        warnings.append(f"{empty} segment(s) carry no word timings (word-level editing unavailable)")

    for gap in transcript.gaps:
        if gap.duration >= 5.0:
            warnings.append(f"timing gap {gap.start:.3f}s-{gap.end:.3f}s ({gap.duration:.2f}s)")

    return warnings


def normalize_transcript(transcript: Transcript, min_gap: float = 1.0) -> Transcript:
    """
    Make every document invariant true, deterministically.

    Segments are dropped when they are empty, normalised word-by-word, sorted,
    then de-overlapped by *sliding* a late segment forward — mirroring the
    safety net in ``caption-studio/src/align/aligner.js``. Sliding preserves each
    segment's duration, while clamping to a boundary would quietly shorten a
    caption. Every slide is named in ``warnings``, because a repair that moves a
    caption in time without saying so is the failure this studio exists to remove.
    """
    segments: list[Segment] = []
    for raw in transcript.segments:
        seg = raw.normalized() if isinstance(raw, Segment) else Segment.from_dict(raw)
        if seg.duration <= 0 and not seg.words:
            continue
        if not seg.words and not seg.text:
            continue
        segments.append(seg)

    segments.sort(key=lambda s: (s.start, s.end))

    cursor = -1.0
    slid: list[tuple[int, float]] = []
    for index, seg in enumerate(segments):
        if cursor >= 0 and seg.start < cursor:
            delta = cursor - seg.start
            moved = seg.shifted(delta)
            seg.start, seg.end, seg.words = moved.start, moved.end, moved.words
            slid.append((index, delta))
        cursor = max(cursor, seg.end)

    transcript.segments = segments
    if segments:
        transcript.duration = max(round_time(_num(transcript.duration)), segments[-1].end)

    assign_ids(transcript)
    transcript.gaps = find_gaps(transcript, min_duration=min_gap)
    transcript.warnings = _structural_warnings(transcript)

    # The slide itself has to be reported. `_structural_warnings` looks at the
    # document *after* it was repaired, so on its own it would find nothing wrong
    # and a segment could be moved a second later than the transcriber put it
    # without a word of explanation — precisely the silent guessing this module
    # refuses. 'No silent guessing' applies to timing as much as to spelling.
    #
    # The record is kept in `meta` rather than passed straight into `warnings`
    # because this function has to stay idempotent: a second normalisation of an
    # already-normalised transcript no longer slides anything, so a warning that
    # came only from *doing* the slide would vanish on the second pass and the
    # output would stop being byte-identical. `meta` survives the round trip, so
    # the report is reproduced rather than remembered.
    recorded = [dict(entry) for entry in (transcript.meta.get("slides") or [])]
    for index, delta in slid:
        label = transcript.segments[index].id or f"segment #{index + 1}"
        entry = {"segment": label, "delta": round_time(delta)}
        if entry not in recorded:
            recorded.append(entry)
    if recorded:
        transcript.meta["slides"] = recorded
        for entry in recorded:
            transcript.warnings.append(
                f"{entry['segment']}: slid forward {entry['delta']:.3f}s to resolve an overlap "
                "with the segment before it"
            )
    return transcript


# --------------------------------------------------------------------------- #
# analysis
# --------------------------------------------------------------------------- #


def find_gaps(
    transcript: Transcript,
    min_duration: float = 1.0,
    *,
    lead_in: bool = True,
    tail: bool = True,
) -> list[Gap]:
    """
    Silent windows between segments.

    Lead-in (0 → first segment) and tail (last segment → duration) are included
    when enabled, because a long instrumental intro is a real gap the caption
    editor must not stretch a line across.
    """
    gaps: list[Gap] = []
    segments = transcript.segments
    if not segments:
        if tail and transcript.duration > min_duration:
            gaps.append(Gap(0.0, round_time(transcript.duration)))
        return gaps

    if lead_in and segments[0].start >= min_duration:
        gaps.append(Gap(0.0, round_time(segments[0].start)))

    for prev, cur in zip(segments, segments[1:]):
        if cur.start - prev.end >= min_duration:
            gaps.append(Gap(round_time(prev.end), round_time(cur.start)))

    if tail and transcript.duration - segments[-1].end >= min_duration:
        gaps.append(Gap(round_time(segments[-1].end), round_time(transcript.duration)))

    return gaps


def validate(transcript: Transcript) -> dict:
    """
    Check every invariant. Returns ``{"errors": [...], "warnings": [...]}``.

    Errors mean the artifact is not a valid transcript and must not be shipped;
    warnings mean it is valid but the user should know something is off.
    """
    errors: list[str] = []
    warnings: list[str] = []

    for i, seg in enumerate(transcript.segments):
        label = seg.id or f"segment #{i + 1}"
        if seg.start != seg.start or seg.end != seg.end:
            errors.append(f"{label}: non-finite timing")
            continue
        if seg.end < seg.start:
            errors.append(f"{label}: end ({seg.end}) is before start ({seg.start})")
        if seg.words and seg.text != " ".join(w.text for w in seg.words):
            errors.append(f"{label}: text does not match its words joined by a space")
        if i and seg.start < transcript.segments[i - 1].end - 1e-6:
            errors.append(f"{label}: overlaps the previous segment")

        prev_end = -1.0
        for wi, word in enumerate(seg.words):
            wlabel = f"{label} word #{wi + 1} ({word.text!r})"
            if not word.text:
                errors.append(f"{wlabel}: empty text")
            if word.end < word.start:
                errors.append(f"{wlabel}: end ({word.end}) is before start ({word.start})")
            if word.start < prev_end - 1e-6:
                errors.append(f"{wlabel}: starts before the previous word ended")
            if f"{word.start}" in ("nan", "inf", "-inf") or f"{word.end}" in ("nan", "inf", "-inf"):
                errors.append(f"{wlabel}: non-finite timing")
            prev_end = word.end

    for w in _structural_warnings(transcript):
        if w not in warnings:
            warnings.append(w)

    return {"errors": errors, "warnings": warnings}
