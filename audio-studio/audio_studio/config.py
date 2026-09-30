"""
config.py — presets and defaults.

Tuned for the machine this was built on: **4 logical cores, ~16 GB RAM, no
GPU,** CPU-only. That single fact decides most of these numbers.

``distil-large-v3`` is the default because it is the accuracy/speed sweet spot
for English on CPU: near-``large`` accuracy at roughly 5-6x the speed, and at
int8 it fits in well under a gigabyte of RAM. Non-English audio switches to
``medium``, because distilled Whisper models are English-only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

APP_NAME = "audio-studio"

#: English-only distilled model: the accuracy pick that still finishes on CPU.
DEFAULT_MODEL_EN = "distil-large-v3"

#: Multilingual equivalent when no English-only model applies.
DEFAULT_MODEL_MULTILINGUAL = "medium"

DEFAULT_COMPUTE_TYPE = "int8"  # CTranslate2 int8 — the CPU quantization to use
DEFAULT_BEAM_SIZE = 5
DEFAULT_SAMPLE_RATE = 16000


@dataclass
class TranscribeOptions:
    """Everything that can change a transcription, in one place."""

    model: Optional[str] = None
    language: Optional[str] = None
    device: str = "cpu"
    compute_type: str = DEFAULT_COMPUTE_TYPE
    beam_size: int = DEFAULT_BEAM_SIZE
    vad_filter: bool = True
    word_timestamps: bool = True
    # Off by default: conditioning on previous text is what makes Whisper loop
    # and repeat a line across a long instrumental gap, and a music bed is
    # exactly the case this studio exists to handle.
    condition_on_previous_text: bool = False
    initial_prompt: Optional[str] = None
    cpu_threads: int = 0  # 0 = let CTranslate2 decide (it uses the core count)
    temperature: float = 0.0
    preset: Optional[str] = None
    extra: dict = field(default_factory=dict)

    def resolved_model(self) -> str:
        """Pick the model for this language when none was named explicitly."""
        if self.model:
            return self.model
        if self.language and not self.language.lower().startswith("en"):
            return DEFAULT_MODEL_MULTILINGUAL
        return DEFAULT_MODEL_EN


#: Named starting points. ``accurate`` is the default — the studio exists to fix
#: timing, so trading accuracy for speed by default would defeat it.
PRESETS: dict[str, dict] = {
    "accurate": {
        "model": None,  # language-dependent: distil-large-v3 / medium
        "beam_size": 5,
        "vad_filter": True,
    },
    "balanced": {"model": "small", "beam_size": 5, "vad_filter": True},
    "fast": {"model": "base", "beam_size": 1, "vad_filter": True},
}

DEFAULT_PRESET = "accurate"


def options_from_preset(preset: str = DEFAULT_PRESET, **overrides) -> TranscribeOptions:
    """Build options from a named preset, with explicit values winning."""
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}; expected one of {sorted(PRESETS)}")
    merged = dict(PRESETS[preset])
    for key, value in overrides.items():
        if value is not None:
            merged[key] = value
    return TranscribeOptions(preset=preset, **{k: v for k, v in merged.items() if k != "extra"})
