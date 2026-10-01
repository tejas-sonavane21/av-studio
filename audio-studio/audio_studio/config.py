"""
config.py — presets and defaults.

Tuned for the machine this was built on: **4 logical cores, ~16 GB RAM, no
GPU,** CPU-only. That single fact decides most of these numbers, and every
number below was measured on the real fixture
(``referece_material/The_Crimson_Burden.mp3``, a 182.5 s sung track) rather than
copied from a benchmark table:

    model            wall time     throughput     lyric accuracy
    base             ~25 s         ~7.3x          garbled
    small            ~78 s         ~2.3x          correct
    distil-large-v3  >400 s/30 s   <0.1x          n/a (too slow to finish)

So ``small`` is the default: on four cores it is the smallest model whose text
is actually usable, and it still finishes a three-minute song in about a
minute. Systems with a GPU or many cores can pass ``--model distil-large-v3``
(see ``QUALITY_MODEL_EN``), which is near-``large`` accuracy but not viable on
CPU here.

``vad_filter`` is **off by default**, which is the opposite of most Whisper
recipes, and on purpose. Voice-activity detection is tuned for *speech*, and a
sung vocal is not speech to it: on the fixture above, VAD found 0.74 s of
"speech" in 182 s (2 words out of 224), silently discarding the entire song.
This studio exists to caption sung tracks, so VAD is opt-in (``--vad``), for
spoken-word files with long instrumental stretches where hallucination on the
music is the bigger risk.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

APP_NAME = "audio-studio"

#: The default English model on a CPU-only box: the smallest model measured to
#: transcribe a sung track correctly.
DEFAULT_MODEL = "small"

#: Multilingual equivalent when no English-only model applies. ``medium`` is
#: also a safe accuracy pick for English.
DEFAULT_MODEL_MULTILINGUAL = "medium"

#: Near-``large`` accuracy, but only worth it with a GPU or many CPU cores:
#: measured below 0.1x realtime on this 4-core machine.
QUALITY_MODEL_EN = "distil-large-v3"

DEFAULT_COMPUTE_TYPE = "int8"  # CTranslate2 int8 — the CPU quantization to use
DEFAULT_BEAM_SIZE = 5
DEFAULT_SAMPLE_RATE = 16000

#: Off: VAD cannot "hear" a sung vocal and deletes the whole track. See module
#: docstring for the measurement.
DEFAULT_VAD_FILTER = False


@dataclass
class TranscribeOptions:
    """Everything that can change a transcription, in one place."""

    model: Optional[str] = None
    language: Optional[str] = None
    device: str = "cpu"
    compute_type: str = DEFAULT_COMPUTE_TYPE
    beam_size: int = DEFAULT_BEAM_SIZE
    vad_filter: bool = DEFAULT_VAD_FILTER
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
        return DEFAULT_MODEL


#: Named starting points. ``balanced`` (``small``) is the default because it is
#: the cheapest model measured to produce correct lyrics on this hardware;
#: trading that away by default would defeat the studio's purpose.
PRESETS: dict[str, dict] = {
    "fast": {"model": "base", "beam_size": 1, "vad_filter": False},
    "balanced": {"model": "small", "beam_size": 5, "vad_filter": False},
    "accurate": {"model": "medium", "beam_size": 5, "vad_filter": False},
}

DEFAULT_PRESET = "balanced"


def options_from_preset(preset: str = DEFAULT_PRESET, **overrides) -> TranscribeOptions:
    """Build options from a named preset, with explicit values winning."""
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r}; expected one of {sorted(PRESETS)}")
    merged = dict(PRESETS[preset])
    for key, value in overrides.items():
        if value is not None:
            merged[key] = value
    return TranscribeOptions(preset=preset, **{k: v for k, v in merged.items() if k != "extra"})
