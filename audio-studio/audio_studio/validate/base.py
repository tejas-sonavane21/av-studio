"""
validate/base.py — the transcript-validation interface.

A validator does not edit anything. It **proposes**, as a list of
``ledger.Correction`` values, and ``ledger.apply_corrections`` decides what is safe
to apply and records the rest. That split is the reason this layer cannot corrupt
a transcript: the thing that talks to a language model has no write access.

Same registry shape as ``engines/base.py`` and ``align/base.py`` — lazy imports,
``doctor``-friendly ``available()``, a name on the command line.
"""

from __future__ import annotations

import importlib
from abc import ABC, abstractmethod
from typing import Callable, Optional

from ..config import ValidateOptions
from ..model import Transcript

#: name → "module:ClassName". Imported on demand by :func:`get_validator`.
_REGISTRY: dict[str, str] = {
    "rules": "audio_studio.validate.rules:RulesValidator",
    "llm": "audio_studio.validate.llm:LLMValidator",
}

DEFAULT_VALIDATOR = "rules"

ProgressHook = Callable[[float, str], None]


class Validator(ABC):
    """A source of proposed text corrections."""

    name: str = "validator"

    @abstractmethod
    def available(self) -> tuple[bool, str]:
        """``(usable, reason)`` — never raises, so ``doctor`` can always report."""

    @abstractmethod
    def review(
        self,
        transcript: Transcript,
        options: ValidateOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> list:
        """Propose corrections. Must not modify ``transcript``."""

    def describe(self) -> dict:
        usable, reason = self.available()
        return {"name": self.name, "available": usable, "reason": reason}


def register(name: str, target: str) -> None:
    _REGISTRY[name] = target


def validator_names() -> list[str]:
    return sorted(_REGISTRY)


def get_validator(name: str = DEFAULT_VALIDATOR) -> Validator:
    try:
        target = _REGISTRY[name]
    except KeyError:
        raise ValueError(f"unknown validator {name!r}; expected one of {validator_names()}") from None

    module_name, separator, class_name = target.partition(":")
    if not separator:
        raise ValueError(f"registry entry for {name!r} must be 'module:ClassName', got {target!r}")
    module = importlib.import_module(module_name)
    return getattr(module, class_name)()


def available_validators() -> list[dict]:
    out: list[dict] = []
    for name in validator_names():
        try:
            validator = get_validator(name)
            info = validator.describe()
            info["name"] = name
            info["backend"] = validator.name
        except Exception as exc:
            info = {"name": name, "backend": None, "available": False, "reason": f"import failed: {exc}"}
        out.append(info)
    return out


__all__ = [
    "DEFAULT_VALIDATOR",
    "ProgressHook",
    "Validator",
    "available_validators",
    "get_validator",
    "register",
    "validator_names",
]
