"""
align/w2vbert.py — forced alignment with a w2v-bert lyrics checkpoint.

The wav2vec2 backend asks a model trained on *read speech* to time words that are
*sung over a band*. It works, and its errors are mostly the ones ``apply.py``
already guards against — but a model that has never heard a chorus treats a drum
fill as evidence about a vowel. This backend is the same CTC Viterbi pass over a
model that was fine-tuned on full music mixes, so the emissions under a word
belong to the thing a listener is following.

Three differences from ``wav2vec.py``, and all three are the checkpoint's
requirements rather than preferences:

* **Features, not samples.** w2v-bert consumes 80-bin log-mel filterbanks, stacked
  in pairs to one frame per 20 ms. ``SeamlessM4TFeatureExtractor`` (the checkpoint's
  own ``preprocessor_config.json``) computes them, with per-mel-bin mean/variance
  normalisation; handing it a waveform would be an error the shape check catches
  immediately but the numbers would not show.
* **Lower case.** The vocabulary is 921 lower-case characters plus ``|``; the
  ``960h`` backend upper-cases, which here would drop every character in the file.
* **Filler at the edges.** The card's instruction for alignment is ``|`` between
  words *and at both ends of the target sequence*, which is what lets the path
  spend the intro and the outro on the filler instead of stretching them into the
  first and last word.

Windowing. The checkpoint was trained on windows of at most 30 s, so the whole
file is not one forward pass: it is 20 s centres with 2 s of context either side,
and only the centre of each window is kept. That is the recipe on the model card,
and it costs about 13% more compute than a single pass — the price of asking the
model the question it was trained to answer.

The model is 2.3 GB in float32 with 24 layers, so ``DTYPE`` is a real decision on
a CPU: ``float32`` is what it was exported in, ``bfloat16`` halves the resident
set. The benchmark in ``out/eval/aligner-bench.py`` is what measured which of the
two is worth it here; the default is the one that won.
"""

from __future__ import annotations

import math
from array import array
from typing import Any, Optional

from .. import modelstore
from ..config import ALIGN_FRAME_HOP
from .wav2vec import _Emissions, Wav2VecAligner

#: The checkpoint this backend is for. A wav2vec2 checkpoint is rejected with the
#: reason rather than loaded and left to fail somewhere deeper.
DEFAULT_CHECKPOINT = "mrfakename/w2v-bert-2.0-music-lyrics-ctc"

#: Seconds of audio per forward pass, and of context either side of the part kept.
#: The card's recipe is 30 s, which is what the checkpoint was trained on, and it
#: cost 181 s of emissions on a 60 s clip where 20 s cost 115 s for the same word
#: onsets. Attention is quadratic in the window, so the shorter one is cheap, and
#: 10 s (134 s) pays more in 2 s contexts than it saves. See the alignment table in
#: the README for the full sweep on a 178 s song.
WINDOW_SECONDS = 20.0
CONTEXT_SECONDS = 2.0

#: ``float32``, ``int8`` (dynamic quantization of the linear layers) or
#: ``bfloat16``. Read at call time, so the benchmark can set it without reloading
#: this module. ``int8`` is the one that makes the checkpoint fit on a machine with
#: 4 GB free; ``bfloat16`` weights do not run on CPU in torch 2.14 for this graph
#: (``layer_norm`` refuses the mixed dtype), which is why it is not the default.
DTYPE = "float32"

#: One model frame is 20 ms at 16 kHz, the same geometry as ``960h``: 10 ms
#: filterbank hop, stacked in pairs by the feature extractor's ``stride=2``.
FRAME_HOP = ALIGN_FRAME_HOP

#: (model, device, dtype) -> (bundle, vocab, blank, boundary, hop, sample_rate)
_CACHE: dict[tuple, tuple] = {}


class _Bundle:
    """
    The checkpoint, its feature extractor, and the windowed pass over a file.

    A small object rather than a bare ``nn.Module`` because the emissions need the
    feature extractor too, and ``Wav2VecAligner`` only ever hands the model back to
    its ``_emissions`` hook.
    """

    def __init__(self, processor: Any, model: Any, dtype: str, device: str):
        self.processor = processor
        self.model = model
        self.dtype = dtype
        # `nn.Module` has no `.device`, so the device the caller asked for is the one
        # recorded: it is also the one the weights were moved to in `_load_checkpoint`.
        self.device = device
        self.channels = int(model.config.vocab_size)

    def _logits(self, samples: Any) -> Any:
        import torch  # type: ignore

        inputs = self.processor(samples, sampling_rate=16000, return_tensors="pt")
        features = inputs["input_features"]
        mask = inputs.get("attention_mask")
        with torch.inference_mode():
            return self.model(
                input_features=features.to(self.device),
                attention_mask=(mask.to(self.device) if mask is not None else None),
            ).logits

    def encode(self, samples: Any) -> _Emissions:
        """
        Logits for the whole file, windowed, as one flat ``_Emissions``.

        The output is preallocated at the file's own length, so a word's frame index
        is ``time * 16`` regardless of which window happened to produce it — the
        per-segment alignment in ``wav2vec.py`` indexes into it by time, and a
        concatenation of windows would slide with every boundary.
        """
        import numpy as np  # type: ignore

        total_samples = len(samples)
        frames = int(math.ceil(total_samples / FRAME_HOP))
        out = np.zeros((frames, self.channels), dtype=np.float32)
        covered = np.zeros(frames, dtype=bool)

        window = max(1, int(round(WINDOW_SECONDS * 16000 / FRAME_HOP)))
        context = max(0, int(round(CONTEXT_SECONDS * 16000 / FRAME_HOP)))

        for first in range(0, frames, window):
            last = min(frames, first + window)
            keep_from = max(0, first - context)
            keep_to = min(frames, last + context)
            chunk = np.asarray(samples[keep_from * FRAME_HOP : keep_to * FRAME_HOP], dtype="float32")
            if chunk.size == 0:
                continue
            logits = self._logits(chunk)[0].float().cpu().numpy()
            # The window's first frame is the chunk's first frame: features and model
            # frames are both 20 ms, so the crop is an index offset, not a resample.
            offset_from = first - keep_from
            offset_to = offset_from + (last - first)
            if logits.shape[0] < offset_to:
                # A short window (the last one, usually) can come back a frame short;
                # keeping what arrived is better than discarding the window.
                offset_to = logits.shape[0]
                last = keep_from + offset_to
                if last <= first:
                    continue
            out[first:last] = logits[offset_from:offset_to]
            covered[first:last] = True

        if not covered.all():
            # A file shorter than one hop, or a window that returned nothing: leave the
            # gap at a low, uniform logit rather than at zero, which is the logit of a
            # *confident* label and would attract the path.
            out[~covered] = -30.0

        return _Emissions(frames, self.channels, array("f", out.reshape(-1).tobytes()))


def _load_checkpoint(model_name: str, device: str):
    """``(bundle, vocab, blank, boundary, hop, sample_rate)`` for one checkpoint."""
    key = (model_name, device, DTYPE)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached

    import torch  # type: ignore
    from transformers import AutoConfig, AutoTokenizer, Wav2Vec2BertForCTC  # type: ignore
    from transformers import SeamlessM4TFeatureExtractor  # type: ignore

    stored = modelstore.require(model_name)
    source = str(stored) if stored is not None else model_name
    local = stored is not None

    config = AutoConfig.from_pretrained(source, local_files_only=local)
    if getattr(config, "model_type", "") != "wav2vec2-bert":
        raise RuntimeError(
            f"{model_name} is a {getattr(config, 'model_type', 'unknown')} checkpoint; the w2v-bert "
            f"backend needs a wav2vec2-bert one (default: {DEFAULT_CHECKPOINT})"
        )

    if DTYPE not in ("float32", "bfloat16", "int8"):
        raise RuntimeError(f"unknown dtype {DTYPE!r}; expected float32, bfloat16 or int8")

    tokenizer = AutoTokenizer.from_pretrained(source, local_files_only=local)
    processor = SeamlessM4TFeatureExtractor.from_pretrained(source, local_files_only=local)
    dtype = torch.bfloat16 if DTYPE == "bfloat16" else torch.float32
    model = Wav2Vec2BertForCTC.from_pretrained(source, dtype=dtype, local_files_only=local)
    model = model.to(device).eval()
    if DTYPE == "int8":
        # Only the linear layers: they are 22 of the 24 blocks' weight, and the conv
        # feature projection and the CTC head are small enough to leave in float.
        model = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
        model.eval()

    vocab = tokenizer.get_vocab()
    blank = tokenizer.pad_token_id
    if blank is None:
        blank = vocab.get("<blank>", vocab.get("<pad>", 0))
    boundary = vocab.get("|")

    loaded = (
        _Bundle(processor, model, DTYPE, device),
        vocab,
        int(blank),
        boundary,
        FRAME_HOP,
        int(getattr(processor, "sampling_rate", 0) or 16000),
    )
    _CACHE[key] = loaded
    return loaded


def clear_cache() -> None:
    _CACHE.clear()


class Wav2VecBertAligner(Wav2VecAligner):
    """The same CTC pass as ``wav2vec2``, over a model trained on sung mixes."""

    name = "w2v-bert"

    #: The checkpoint's alphabet is lower-case and its ``|`` doubles as the filler for
    #: everything that is not a lyric - so the target sequence gets one at each end.
    case = staticmethod(str.lower)
    pad_boundaries = True

    def _load_checkpoint(self, model_name: str, device: str):
        return _load_checkpoint(model_name, device)

    def _emissions(self, samples: Any, model: Any, device: str) -> _Emissions:
        return model.encode(samples)


__all__ = [
    "CONTEXT_SECONDS",
    "DEFAULT_CHECKPOINT",
    "DTYPE",
    "FRAME_HOP",
    "WINDOW_SECONDS",
    "Wav2VecBertAligner",
    "clear_cache",
]
