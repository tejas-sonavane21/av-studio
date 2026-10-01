"""
pipeline.py — the optional passes that turn a transcription into a finished artifact.

Transcribing is the first thing this studio does and not the last. Two passes
follow it, and they share enough shape — off by default, a named backend, a
progress hook, a refusal when the backend is unavailable — that giving each
caller its own copy of that wiring is how the CLI and the HTTP server would drift
apart. So the order lives here, once:

    transcribe ─▶ align (Phase C) ─▶ validate (Phase D) ─▶ emit

The order is not a preference. Alignment reads the audio and rewrites *when*
words happened; validation reads the words and rewrites *what* they say. Running
validation first would mean aligning a text that is about to change, and running
them in the other order would mean correcting text that has already been timed —
so each pass sees the finished output of the one before it, and neither can undo
the other's work.

Both are off unless asked for. A default that silently runs a 360 MB acoustic
model, or spends money, would be worse than no default at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .align import align_transcript, get_aligner
from .config import AlignOptions, ValidateOptions
from .media import Audio
from .model import Transcript
from .validate import get_validator, validate_transcript


class PassUnavailable(RuntimeError):
    """A pass was asked for that cannot run on this machine."""


@dataclass
class PipelineOptions:
    """Which optional passes to run, and how."""

    #: Alignment backend name (``wav2vec``, ``fake``), or ``None`` to skip.
    align: Optional[str] = None
    align_options: AlignOptions = field(default_factory=AlignOptions)
    #: Validation backend name (``rules``, ``llm``), or ``None`` to skip.
    validate: Optional[str] = None
    validate_options: ValidateOptions = field(default_factory=ValidateOptions)

    def enabled(self) -> list[str]:
        return [name for name, value in (("align", self.align), ("validate", self.validate)) if value]

    def to_dict(self) -> dict:
        return {
            "align": self.align,
            "alignOptions": {
                "model": self.align_options.model,
                "minConfidence": self.align_options.min_confidence,
                "windowPad": self.align_options.window_pad,
                "maxShift": self.align_options.max_shift,
            },
            "validate": self.validate,
            "validateOptions": {
                "provider": self.validate_options.provider,
                "model": self.validate_options.model,
                "minConfidence": self.validate_options.min_confidence,
            },
        }


def post_process(
    transcript: Transcript,
    audio: Optional[Audio] = None,
    options: Optional[PipelineOptions] = None,
    on_progress=None,
) -> Transcript:
    """
    Run the enabled passes, in order, and return the finished transcript.

    Raises :class:`PassUnavailable` when a pass was explicitly asked for and cannot
    run — a backend that is not installed is a request that cannot be served, not a
    transcript that should quietly come back unaligned.
    """
    options = options or PipelineOptions()

    if options.align:
        aligner = get_aligner(options.align)
        usable, reason = aligner.available()
        if not usable:
            raise PassUnavailable(f"aligner {options.align!r} is unavailable: {reason}")
        if audio is None or (aligner.requires_samples and audio.samples is None):
            raise PassUnavailable(
                f"aligner {options.align!r} listens to the audio and needs it decoded: "
                "run without --no-decode"
            )
        transcript = align_transcript(
            transcript, audio, options.align_options, options.align, _stage("align", on_progress)
        )

    if options.validate:
        validator = get_validator(options.validate)
        usable, reason = validator.available()
        if not usable:
            raise PassUnavailable(f"validator {options.validate!r} is unavailable: {reason}")
        transcript = validate_transcript(
            transcript, options.validate_options, options.validate, _stage("validate", on_progress)
        )

    return transcript


def _stage(stage: str, on_progress):
    if on_progress is None:
        return None
    return lambda fraction, message: on_progress(fraction, f"{stage}: {message}")


def summarise_passes(transcript: Transcript) -> list[str]:
    """Human-readable lines about what the passes did, for the CLI summary."""
    lines: list[str] = []

    alignment = transcript.alignment
    if alignment:
        segments = alignment.get("segments") or 0
        lines.append(
            "  alignment      {aligner}{model}: {aligned}/{segments} segments, "
            "{words} words, mean confidence {confidence}, mean shift {shift}s".format(
                aligner=alignment.get("aligner", "?"),
                model=f"/{alignment['model']}" if alignment.get("model") else "",
                aligned=alignment.get("segmentsAligned", 0),
                segments=segments,
                words=alignment.get("wordsAligned", 0),
                confidence=alignment.get("meanConfidence", 0),
                shift=alignment.get("meanShift", 0),
            )
        )

    passes = (transcript.validation or {}).get("passes") or []
    for record in passes:
        lines.append(
            "  validation     {validator}{provider}: {corrections} proposed, {applied} applied".format(
                validator=record.get("validator", "?"),
                provider=f"/{record['provider']}" if record.get("provider") else "",
                corrections=record.get("corrections", 0),
                applied=record.get("applied", 0),
            )
        )

    if transcript.corrections:
        lines.append(f"  corrections    {len(transcript.corrections)} ledger entries")

    return lines


__all__ = ["PassUnavailable", "PipelineOptions", "post_process", "summarise_passes"]
