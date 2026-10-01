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


# --------------------------------------------------------------------------- #
# Phase C — forced alignment
# --------------------------------------------------------------------------- #

#: The acoustic model the alignment pass runs on. It is a *character*-level CTC
#: model, which is the whole point: it re-locates words we already have, it never
#: guesses what was said. ``960h`` is English; pass another checkpoint (a
#: multilingual one, e.g. ``facebook/wav2vec2-large-xlsr-53``) for other languages.
DEFAULT_ALIGN_MODEL = "facebook/wav2vec2-base-960h"

#: wav2vec2 emits one frame per 320 input samples at 16 kHz, i.e. every 20 ms.
#: That is the resolution ceiling of the alignment, and it is what makes it
#: roughly ten times finer than the timings it replaces.
ALIGN_FRAME_HOP = 320


@dataclass
class AlignOptions:
    """
    Knobs for the alignment pass.

    The three guards exist because a CTC path is confident even when it is wrong,
    and a wrongly-confident onset is the drift this studio exists to remove.
    """

    model: str = DEFAULT_ALIGN_MODEL
    device: str = "cpu"
    #: A segment whose mean per-word posterior is below this keeps its original
    #: timings. Alignment is an improvement, not a replacement: a segment that
    #: does not clearly improve is left exactly as it was.
    min_confidence: float = 0.35
    #: Seconds of acoustic context either side of a segment, available **only
    #: where there is silence to spend**. Two contiguous segments have nothing
    #: between them, so neither may reach into the other: that is what stops a
    #: small per-segment error from compounding into a lag down the whole file.
    #: Where there is a gap, a word that really does start early can use it.
    window_pad: float = 0.30
    #: No word's **onset** may move further than this from where the transcriber
    #: put it. A word that has to travel half a second to fit the audio was not
    #: heard there. Starts only: a transcriber's word *ends* are the softest thing
    #: it reports, and rejecting a segment because the aligner stretched one would
    #: throw away good onsets to protect a number nobody trusts.
    max_shift: float = 2.0
    extra: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Phase D — transcript validation
# --------------------------------------------------------------------------- #

#: The default validator is the offline, deterministic one: it needs no key, no
#: network and no money, so it is always safe to run.
DEFAULT_VALIDATOR = "rules"

#: Default hosted model per provider, when the caller does not name one.
#:
#: The ``-latest`` aliases are chosen deliberately over dated names. A dated
#: model name rots: this studio's first default, ``gemini-2.0-flash``, answered
#: with a 404 telling us it is "no longer available" and to use a newer one — a
#: broken run for anyone who installed the studio a few months after it was
#: written, with nothing in the code to blame.
DEFAULT_LLM_MODELS = {
    "google": "gemini-flash-latest",
    "openrouter": "google/gemini-flash-latest",
}

#: Tried, in order, when a provider says the named model does not exist any more.
#: Not a retry (a retired model will not come back) but a hedge against exactly the
#: rot above, so an installed studio keeps working without an upgrade.
LLM_MODEL_FALLBACKS = {
    "google": ("gemini-3.8-flash",),
    "openrouter": ("google/gemini-3.8-flash",),
}

#: A file holding the key, if the environment variable is not set. It lives at the
#: repository root and is gitignored.
API_KEY_FILENAME = "gemini_api_key.txt"


@dataclass
class ValidateOptions:
    """Knobs for the validation pass. Timings never depend on any of this."""

    provider: str = "auto"  # auto | google | openrouter
    model: Optional[str] = None
    api_key: Optional[str] = None
    #: A correction below this confidence is reported but not applied. A language
    #: model asked to fix a lyric will always volunteer something; the threshold
    #: is what stops it from volunteering it into the file.
    min_confidence: float = 0.6
    #: Words per request. Keeps a long transcript inside one context window and
    #: makes the model's answer cheap to check against the input.
    batch_words: int = 220
    extra: dict = field(default_factory=dict)
