"""
validate/ledger.py — typed, auditable corrections, and the rules for applying them.

Phase D polices the *text* of a transcript: the spelling, the casing, the
punctuation that a transcriber gets approximately right and a language model can
often get better. Two hard rules keep that from becoming a liability.

**Timings never depend on it.** A correction is applied to a word's ``text`` and to
nothing else. Not its ``start``, not its ``end``, not its ``probability``, not the
number of words. A "fix" that inserts, deletes or splits a word would move every
word after it in time, which is the exact class of bug this suite exists to
remove — so such a proposal is *refused and recorded*, never partially applied.
That is a property this module can be, and is, tested for directly: applying a
full ledger leaves every timing byte-identical.

**Nothing is silent.** Every proposal produces a ledger entry — applied, refused,
stale or low-confidence — with the original text, the proposed text, who proposed
it, how sure they were and why. A transcript that was repaired can therefore be
audited afterwards without rerunning anything, and a proposal that was *not*
applied is as visible as one that was.

Everything here is pure: same transcript + same proposals ⇒ byte-identical output.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, Optional, Sequence

from ..config import ValidateOptions
from ..model import Segment, Transcript, Word, normalize_transcript

#: What a proposal changes about a word. ``punctuation`` and ``case`` are the
#: low-risk classes; ``spelling`` is one word becoming another; ``word`` is a
#: judgement call the caller may want to review by hand.
CORRECTION_TYPES = ("case", "punctuation", "spelling", "word")

#: Outcomes a ledger entry can have. ``reported`` is a finding rather than a
#: proposal: something worth knowing that carries no replacement text.
OUTCOMES = ("applied", "reported", "low-confidence", "unchanged", "stale", "unsafe", "missing")


def classify(before: str, after: str) -> str:
    """
    Name the kind of change, from the two texts alone.

    Deliberately mirrors ``classifyTextDiff`` in
    ``caption-studio/src/align/corrections.js``: comparing the letters only, so
    ``Don't`` → ``dont`` reads as case plus punctuation rather than as a different
    word. The studios cross-check their corrections, so the vocabulary has to mean
    the same thing on both sides.
    """
    if before == after:
        return "unchanged"
    if before.lower() == after.lower():
        return "case"
    if _letters(before) == _letters(after):
        return "punctuation"
    return "spelling"


def _letters(text: str) -> str:
    return "".join(char for char in str(text).lower() if char.isalnum())


def _single_token(text: str) -> bool:
    return bool(text) and not any(char.isspace() for char in text)


@dataclass
class Correction:
    """One proposed change to one word."""

    index: int
    from_text: str
    to_text: str = ""
    confidence: float = 0.5
    type: str = "spelling"
    reason: str = ""
    source: str = ""
    #: A finding with no replacement text. It goes through the ledger like any
    #: other entry, so it is visible in the artifact, but it can never be applied.
    report_only: bool = False
    segment_id: str = ""
    word_id: str = ""
    #: Filled in by :func:`apply_corrections`.
    applied: bool = False
    outcome: str = "missing"
    note: str = ""

    def to_dict(self) -> dict:
        out = {
            "index": self.index,
            "type": self.type,
            "from": self.from_text,
            "confidence": round(max(0.0, min(1.0, self.confidence)), 4),
            "applied": self.applied,
            "outcome": self.outcome,
            "source": self.source,
        }
        if self.to_text:
            out["to"] = self.to_text
        if self.reason:
            out["reason"] = self.reason
        if self.note:
            out["note"] = self.note
        if self.segment_id:
            out["segmentId"] = self.segment_id
        if self.word_id:
            out["wordId"] = self.word_id
        return out

    @classmethod
    def from_dict(cls, data: dict) -> "Correction":
        return cls(
            index=int(data.get("index", -1)),
            from_text=str(data.get("from", data.get("fromText", "")) or ""),
            to_text=str(data.get("to", data.get("toText", "")) or ""),
            confidence=float(data.get("confidence", 0.5) or 0.0),
            type=str(data.get("type", "spelling") or "spelling"),
            reason=str(data.get("reason", "") or ""),
            source=str(data.get("source", "") or ""),
            report_only=bool(data.get("reportOnly", False)),
            segment_id=str(data.get("segmentId", "") or ""),
            word_id=str(data.get("wordId", "") or ""),
            applied=bool(data.get("applied", False)),
            outcome=str(data.get("outcome", "missing") or "missing"),
            note=str(data.get("note", "") or ""),
        )

    def as_proposal(self) -> "Correction":
        """A copy with the outcome fields cleared, ready to be applied again."""
        return replace(self, applied=False, outcome="missing", note="")


def apply_corrections(
    transcript: Transcript,
    proposals: Iterable[Correction | dict],
    options: Optional[ValidateOptions] = None,
    *,
    backend: str = "rules",
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> Transcript:
    """
    Apply the proposals that are safe, record all of them, and return a new transcript.

    A proposal is **applied** when all of the following hold:

    * it points at a word that exists (by flat index, or by ``word_id``);
    * the text it says it is replacing is what that word says *at that point in the
      batch* — a proposal quoting something else is describing a different
      transcript, and the entry is marked ``stale`` instead;
    * the replacement is a single, non-empty token. Splitting one word into two,
      or deleting it, changes the word count and therefore every later timing, so
      those are ``unsafe``;
    * its confidence clears ``options.min_confidence``.

    Proposals are applied **in order, against the running text**, not each against
    the original. Two proposals for the same word are therefore a small patch
    series: the second sees what the first wrote, so if it quoted the earlier text
    it is recorded ``stale`` rather than claiming to have applied a change that
    went through a state it never names. Reading the ledger top to bottom
    reconstructs exactly what happened, which is the only thing that makes it an
    audit trail instead of a tally.

    Nothing else about the transcript moves: the ledger is the only other change.
    """
    options = options or ValidateOptions()

    flat: list[tuple[int, int, Word]] = [
        (segment_index, word_index, word)
        for segment_index, segment in enumerate(transcript.segments)
        for word_index, word in enumerate(segment.words)
    ]
    by_id = {word.id: (segment_index, word_index) for segment_index, word_index, word in flat if word.id}

    edits: dict[tuple[int, int], Correction] = {}
    ledger: list[Correction] = []
    #: The text each word will have once the proposals processed so far have landed.
    pending: dict[tuple[int, int], str] = {}

    for raw in proposals:
        proposal = raw if isinstance(raw, Correction) else Correction.from_dict(raw)
        entry = proposal.as_proposal()
        target = _locate(proposal, flat, by_id)

        if proposal.report_only:
            # A finding, not a proposal: it is recorded verbatim and cannot reach
            # the transcript, which is what lets a validator report without
            # acquiring the right to rewrite.
            entry.outcome, entry.note = "reported", proposal.reason
        elif target is None:
            entry.outcome, entry.note = "missing", "no word matches this index or id"
        else:
            segment_index, word_index = target
            word = transcript.segments[segment_index].words[word_index]
            entry.index = _flat_index(flat, segment_index, word_index)
            entry.segment_id = transcript.segments[segment_index].id
            entry.word_id = word.id

            # What the word says *now*, not what it said before this batch started:
            # proposals are a patch series and each one reads the previous one's
            # output.
            current = pending.get((segment_index, word_index), word.text)

            if proposal.from_text != current:
                entry.outcome = "stale"
                if current != word.text:
                    entry.note = (
                        f"this word says {current!r} rather than {proposal.from_text!r}: an "
                        "earlier proposal in this pass already changed it"
                    )
                else:
                    entry.note = f"this word says {current!r}, not {proposal.from_text!r}"
            elif proposal.to_text == current:
                entry.outcome, entry.note = "unchanged", "the proposal is a no-op"
            elif not _single_token(proposal.to_text):
                entry.outcome = "unsafe"
                entry.note = (
                    "the replacement is not a single token; changing the word count would move "
                    "the timing of everything after it"
                )
            elif proposal.confidence < options.min_confidence:
                entry.outcome = "low-confidence"
                entry.note = f"below the {options.min_confidence:g} confidence threshold"
            else:
                entry.applied, entry.outcome = True, "applied"
                entry.type = (
                    proposal.type if proposal.type in CORRECTION_TYPES else classify(current, proposal.to_text)
                )
                pending[(segment_index, word_index)] = proposal.to_text
                edits[(segment_index, word_index)] = entry

        ledger.append(entry)

    segments: list[Segment] = []
    for segment_index, segment in enumerate(transcript.segments):
        words: list[Word] = []
        for word_index, word in enumerate(segment.words):
            edit = edits.get((segment_index, word_index))
            if edit is None:
                words.append(word)
                continue
            # Only the text moves. start / end / probability / id are carried over
            # untouched, which is what makes "validation cannot change the sync" a
            # property rather than a promise.
            words.append(
                Word(text=edit.to_text, start=word.start, end=word.end, probability=word.probability, id=word.id)
            )
        segments.append(
            Segment(
                start=segment.start,
                end=segment.end,
                words=words,
                text=segment.text,
                id=segment.id,
                no_speech_probability=segment.no_speech_probability,
            )
        )

    applied = [entry for entry in ledger if entry.applied]
    fresh = Transcript(
        segments=segments,
        language=transcript.language,
        duration=transcript.duration,
        source=dict(transcript.source),
        engine=dict(transcript.engine),
        alignment=dict(transcript.alignment) if transcript.alignment else None,
        validation=_summarise(transcript, ledger, applied, options, backend, provider, model),
        # The reference pass ran before this one and its record describes the word list
        # that this pass just re-spelled. It is carried through rather than rebuilt,
        # because dropping it would erase the one entry that says where the words came
        # from — and the artifact would then describe a transcript with no origin.
        reference=dict(transcript.reference) if transcript.reference else None,
        corrections=list(transcript.corrections),
        meta=dict(transcript.meta),
    )
    normalize_transcript(fresh)
    fresh.corrections = list(transcript.corrections) + [entry.to_dict() for entry in ledger]
    return fresh


def _summarise(
    transcript: Transcript,
    ledger: Sequence[Correction],
    applied: Sequence[Correction],
    options: ValidateOptions,
    backend: str,
    provider: Optional[str],
    model: Optional[str],
) -> dict:
    """One entry per validator run, appended to ``validation.passes``.

    A list rather than a flat record because the passes are meant to be run more
    than once (the offline rules before and after the model, say), and a report
    that overwrote itself would be the least auditable possible artifact.
    """
    outcomes: dict[str, int] = {}
    for entry in ledger:
        outcomes[entry.outcome] = outcomes.get(entry.outcome, 0) + 1

    record = {
        "validator": backend,
        "corrections": len(ledger),
        "applied": len(applied),
        "outcomes": outcomes,
        "minConfidence": options.min_confidence,
        "meanConfidence": round(sum(e.confidence for e in ledger) / len(ledger), 4) if ledger else 0.0,
    }
    if provider:
        record["provider"] = provider
    if model:
        record["model"] = model
    if applied:
        record["appliedWords"] = [
            {"from": entry.from_text, "to": entry.to_text, "index": entry.index} for entry in applied
        ]

    previous = dict(transcript.validation or {})
    return {**previous, "passes": list(previous.get("passes") or []) + [record]}


def _locate(
    proposal: Correction,
    flat: Sequence[tuple[int, int, Word]],
    by_id: dict[str, tuple[int, int]],
) -> Optional[tuple[int, int]]:
    if proposal.word_id and proposal.word_id in by_id:
        return by_id[proposal.word_id]
    if 0 <= proposal.index < len(flat):
        return flat[proposal.index][0], flat[proposal.index][1]
    return None


def _flat_index(flat: Sequence[tuple[int, int, Word]], segment_index: int, word_index: int) -> int:
    for position, (si, wi, _word) in enumerate(flat):
        if si == segment_index and wi == word_index:
            return position
    return -1


__all__ = [
    "CORRECTION_TYPES",
    "OUTCOMES",
    "Correction",
    "apply_corrections",
    "classify",
]
