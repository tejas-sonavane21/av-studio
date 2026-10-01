"""
validate/ — the transcript-validation pass, and its audit trail.

    transcript ─▶ validator (rules | llm) ─▶ proposals ─▶ ledger.apply_corrections ─▶ transcript'

The validator proposes; ``ledger.py`` decides and records. That split is
deliberate: the component that talks to a language model has no write access to
the transcript, so the only way a text correction can reach the artifact is
through the rules in ``ledger.py`` — and every one of them leaves a ledger entry
behind.

    from audio_studio.validate import validate_transcript

    checked = validate_transcript(transcript, ValidateOptions(), "llm")
"""

from __future__ import annotations

from typing import Optional

from ..config import ValidateOptions
from ..model import Transcript
from .base import (
    DEFAULT_VALIDATOR,
    ProgressHook,
    Validator,
    available_validators,
    get_validator,
    register,
    validator_names,
)
from .ledger import CORRECTION_TYPES, OUTCOMES, Correction, apply_corrections, classify

__all__ = [
    "CORRECTION_TYPES",
    "DEFAULT_VALIDATOR",
    "OUTCOMES",
    "Correction",
    "ProgressHook",
    "Validator",
    "apply_corrections",
    "available_validators",
    "classify",
    "get_validator",
    "register",
    "validate_transcript",
    "validator_names",
]


def validate_transcript(
    transcript: Transcript,
    options: Optional[ValidateOptions] = None,
    backend: str = DEFAULT_VALIDATOR,
    on_progress: Optional[ProgressHook] = None,
) -> Transcript:
    """
    Review ``transcript`` with ``backend`` and return a new transcript.

    Raises when the backend is unusable — an unreachable model is a request that
    cannot be served, and silently returning the transcript unchanged would look
    exactly like a pass that found nothing to fix.
    """
    options = options or ValidateOptions()
    validator = get_validator(backend)
    usable, reason = validator.available()
    if not usable:
        raise RuntimeError(reason)

    proposals = validator.review(transcript, options, on_progress)

    # Record what actually answered, not just what was asked for. `auto` is a
    # legitimate request and a useless provenance record, and a model-name
    # fallback means the two can even differ for the same provider.
    resolved = getattr(validator, "used", None)
    resolved_provider = resolved.name if resolved else None
    resolved_model = resolved.model if resolved else options.model

    return apply_corrections(
        transcript,
        proposals,
        options,
        backend=backend,
        provider=resolved_provider,
        model=resolved_model,
    )
