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
or use the ``best`` preset (see ``QUALITY_MODEL_EN``), which is near-``large``
accuracy but not viable on CPU here.

What each model *is* — its hub repository, how large it is, and whether this
machine already has it downloaded — lives in ``models.py``, not here: this module
holds the options the engine consumes, and a model's name in the UI is a
different question from the numbers a run needs.


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


#: Named starting points, ordered quickest → best. ``balanced`` (``small``) is the
#: default because it is the cheapest model measured to produce correct lyrics on this
#: hardware; trading that away by default would defeat the studio's purpose.
#:
#: ``best`` exists because the machine is not always a 4-core laptop: on a GPU, the
#: distilled large model is the accuracy of ``large`` for a little over a third of its
#: weights, and leaving it off the menu made the studio look like it had no answer for
#: anyone with the hardware to run it. It is last in the order on purpose — it is the one
#: choice here that can take minutes on the machine this was tuned for.
PRESETS: dict[str, dict] = {
    "fast": {"model": "base", "beam_size": 1, "vad_filter": False},
    "balanced": {"model": "small", "beam_size": 5, "vad_filter": False},
    "accurate": {"model": "medium", "beam_size": 5, "vad_filter": False},
    "best": {"model": "distil-large-v3", "beam_size": 5, "vad_filter": False},
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
    #:
    #: **One second, not 0.3.** The window is not a safety margin, it is the reach
    #: available to a model that is *measuring* — and on a sung line a transcriber's
    #: boundary is routinely a second out, because a phrase starts on the beat while
    #: the voice arrives on the vowel. With 0.3 s the aligner simply could not see the
    #: onset it was asked to find, so it agreed with the drift it was meant to fix:
    #: on this project's own 182 s fixture the mean shift was 0.06 s — the aligner
    #: confirming Whisper, not correcting it. The window is still bounded by the
    #: neighbouring segments, so a wider pad costs nothing where there is no silence
    #: to spend and cannot make one caption reach into the next.
    window_pad: float = 1.0
    #: No word's **onset** may move further than this from where the transcriber
    #: put it. A word that has to travel seconds to fit the audio was not heard there.
    #: Starts only: a transcriber's word *ends* are the softest thing it reports, and
    #: rejecting a segment because the aligner stretched one would throw away good
    #: onsets to protect a number nobody trusts.
    #:
    #: **3.5 s, not 2.0.** A guard that rejects a segment does not fall back to the
    #: audio, it falls back to the *transcriber* — so a limit that is too tight keeps
    #: exactly the timings the pass was run to replace. At 2.0 s this project's own
    #: fixture refused the one segment that needed a 2.08 s correction, and that
    #: refusal is the segment a person hears as "the caption is a beat late":
    #: measured against the same fixture, 3.5 s aligned 31 of 31 segments where 2.0 s
    #: aligned 30, with the line inside the refused segment arriving a full second
    #: closer to where it is actually sung.
    max_shift: float = 3.5
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
    "google": "gemini-3.5-flash-lite",
    "openrouter": "google/gemini-flash-latest",
}

#: Tried, in order, when a provider says the named model does not exist any more.
#: Not a retry (a retired model will not come back) but a hedge against exactly the
#: rot above, so an installed studio keeps working without an upgrade.
LLM_MODEL_FALLBACKS = {
    "google": ("gemini-3.1-flash-lite",),
    "openrouter": ("google/gemini-3.8-flash",),
}

# Where a key is read from is `env.py`'s business, not this module's: a real
# environment variable, then `.env` (see `.env.example` for the shape). Nothing here
# holds a path, so nothing here can go stale when a key moves.


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


# --------------------------------------------------------------------------- #
# Phase E — reference reconciliation
# --------------------------------------------------------------------------- #


@dataclass
class ReconcileOptions:
    """
    Knobs for the reference pass.

    ``min_match`` is the only one that really matters, and it is the difference
    between *use these words* and *these words are for another song*. Everything
    else about the pass is deterministic.
    """

    #: The share of words on which the audio and the lyric sheet must agree before
    #: the sheet is trusted to rewrite the transcript. Measured on this project's own
    #: fixture, ``small``'s transcript agrees with the real lyric sheet on ~88% of
    #: words, so a half is a floor with a lot of room under it: what it catches is a
    #: wrong file, not a hard recording.
    min_match: float = 0.5
    extra: dict = field(default_factory=dict)
