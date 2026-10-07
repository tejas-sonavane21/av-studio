"""
pipeline.py — the optional passes that turn a transcription into a finished artifact.

Transcribing is the first thing this studio does and not the last. Two passes
follow it, and they share enough shape — off by default, a named backend, a
progress hook, a refusal when the backend is unavailable — that giving each
caller its own copy of that wiring is how the CLI and the HTTP server would drift
apart. So the order lives here, once:

    transcribe ─▶ reconcile (Phase E) ─▶ align (Phase C) ─▶ validate (Phase D) ─▶ emit

The order is not a preference, and it is the whole reason reference reconciliation
is a *pass* rather than another validation backend.

Reconcile rewrites *what* the words are, and it can add or delete them. Alignment
rewrites *when* they happened, and it listens to the audio. So reconcile has to run
first: the words it inserts arrive with an interpolated, made-up window, and
running the aligner afterwards is what replaces that window with a measured one. If
the order were reversed, inserted words would land after the aligner had finished
and keep a time nobody measured — and validation last, so that the model proofreads
the text that will actually be shipped rather than text an earlier pass is about to
replace.

Each pass therefore sees the finished output of the one before it, and none can
undo the work of another.

All three are off unless asked for. A default that silently runs a 360 MB acoustic
model, or spends money, would be worse than no default at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .align import align_transcript, get_aligner
from .config import AlignOptions, ReconcileOptions, ValidateOptions
from .media import Audio
from .model import Transcript
from .reconcile import reconcile
from .reference import Reference
from .validate import get_validator, validate_transcript


class PassUnavailable(RuntimeError):
    """A pass was asked for that cannot run on this machine."""


@dataclass
class PipelineOptions:
    """Which optional passes to run, and how."""

    #: Alignment backend name (``wav2vec``, ``fake``), or ``None`` to skip.
    #: The original lyrics, parsed. ``None`` when the user did not supply any, which
    #: is what keeps the pass off.
    reference: Optional[Reference] = None
    reference_options: ReconcileOptions = field(default_factory=ReconcileOptions)
    align: Optional[str] = None
    align_options: AlignOptions = field(default_factory=AlignOptions)
    #: Validation backend name (``rules``, ``llm``), or ``None`` to skip.
    validate: Optional[str] = None
    validate_options: ValidateOptions = field(default_factory=ValidateOptions)

    def enabled(self) -> list[str]:
        return [
            name
            for name, value in (
                ("reconcile", self.reference),
                ("align", self.align),
                ("validate", self.validate),
            )
            if value
        ]

    def to_dict(self) -> dict:
        return {
            "reference": self.reference.to_dict() if self.reference else None,
            "referenceOptions": {"minMatch": self.reference_options.min_match},
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

    if options.reference is not None:
        # No availability check: unlike an aligner or a validator there is no model to
        # load and no key to find, and a file that cannot be read raised when it was
        # parsed, before a job was ever queued.
        transcript = reconcile(
            transcript,
            options.reference,
            options.reference_options,
            _stage("reference", on_progress),
        )

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

    # Said last, and deliberately: `apply_corrections` rebuilds the transcript and
    # `normalize_transcript` recomputes `warnings` from the structure, so a warning
    # raised before the validation pass would be gone by the time anyone read it.
    if (
        options.validate
        and options.reference is not None
        and (transcript.reference or {}).get("outcome") == "applied"
    ):
        transcript.warnings.append(
            "the reference pass already took the words from the lyrics file, so the "
            f"{options.validate} validator is proofreading the file's own spelling: it has nothing "
            "left to guess, and a correction it proposes here is the one kind that can make the "
            "result worse"
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

    reference = transcript.reference
    if reference:
        counts = reference.get("counts") or {}
        lines.append(
            "  reference      {name}{rolling}: {outcome}, {rate:.0%} of the audio matched the file ".format(
                name=reference.get("name") or "lyrics",
                rolling=" (rolling)" if reference.get("rolling") else "",
                outcome=reference.get("outcome", "?"),
                rate=float(reference.get("matchRate") or 0.0),
            )
            + f"({counts.get('rewritten', 0)} rewritten, {counts.get('inserted', 0)} inserted, "
            f"{counts.get('deleted', 0)} deleted)"
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
