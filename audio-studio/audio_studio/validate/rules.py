"""
validate/rules.py — the offline, deterministic validator.

It reads the transcript and proposes nothing, or proposes only what it can name.
It never rewrites a word, and it needs no key, no network and no money — which is
what makes it the default: a pass that requires an API key before it can tell you
anything about a transcript is a pass nobody runs.

What it is genuinely for:

* **It finds the transcriber's own tells.** Whisper's characteristic failures are
  mechanical — a word repeated across a musical break, a token that is punctuation
  and nothing else, a word with no duration after an overlap was resolved. Those
  are detectable from the text and the timings alone, with no model at all.
* **It gives the ledger a second producer.** The correction ledger, its outcomes
  and the artifact's audit trail are exercised end to end with zero dependencies,
  so a change to the ledger shape cannot hide behind a network call.
* **It is the cheap second opinion.** Run it before and after the LLM pass: a
  repetition the model did not touch is worth knowing about whichever way the
  model went.
"""

from __future__ import annotations

from typing import Optional

from ..config import ValidateOptions
from ..model import Transcript
from .base import ProgressHook, Validator
from .ledger import Correction

#: A word shorter than this is not a word; it is debris from a collapse.
MIN_WORD_DURATION = 0.02

#: How close two identical neighbours have to be before the repeat looks like a
#: transcriber loop rather than a deliberate stutter.
REPEAT_WINDOW = 0.30


class RulesValidator(Validator):
    name = "rules"

    def available(self) -> tuple[bool, str]:
        return True, "built in (deterministic, no model, no network)"

    def review(
        self,
        transcript: Transcript,
        options: ValidateOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> list[Correction]:
        findings: list[Correction] = []
        index = -1

        def report(segment, word, confidence: float, kind: str, reason: str) -> None:
            # `segment_id` and `word_id` carry the *segment's* id and the *word's*
            # id, because a ledger entry that labels a word id as a segment id is
            # an audit trail that points at the wrong thing.
            findings.append(
                Correction(
                    index=index,
                    from_text=word.text,
                    confidence=confidence,
                    type=kind,
                    reason=reason,
                    source=self.name,
                    report_only=True,
                    segment_id=segment.id,
                    word_id=word.id,
                )
            )

        for segment in transcript.segments:
            previous: Optional[tuple[str, float]] = None
            for word in segment.words:
                index += 1

                if not word.text.strip():
                    report(segment, word, 1.0, "word", "empty word")
                elif not any(char.isalnum() for char in word.text):
                    report(segment, word, 0.5, "punctuation", "this token has no letters or digits in it")

                if word.duration < MIN_WORD_DURATION:
                    report(segment, word, 0.5, "word", f"zero-length timing ({word.duration:.3f}s)")

                key = word.text.strip().lower()
                if previous is not None and key and key == previous[0] and word.start - previous[1] <= REPEAT_WINDOW:
                    report(
                        segment,
                        word,
                        0.4,
                        "word",
                        f"repeats the previous word within {REPEAT_WINDOW:g}s "
                        "- a transcriber loop rather than a stutter, most likely",
                    )
                previous = (key, word.end)

        if on_progress:
            on_progress(1.0, f"{len(findings)} finding(s)")
        return findings


__all__ = ["MIN_WORD_DURATION", "REPEAT_WINDOW", "RulesValidator"]
