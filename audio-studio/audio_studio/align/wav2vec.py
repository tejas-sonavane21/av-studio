"""
align/wav2vec.py — the wav2vec2 forced-alignment backend.

Why a CTC acoustic model rather than more Whisper: Whisper is a *decoder* asked
two questions at once — what was said, and when — and it answers the second one
roughly. wav2vec2 is asked only the second question, about text we already have,
and it answers it at the 20 ms resolution of its own frames. That division is the
whole design: the transcriber supplies the words, the aligner supplies the clock.

The model is a character-level CTC checkpoint (``960h`` is English), so the target
sequence is not guessed — it is *transcribed* from the transcript's own words,
with a word-boundary token between them. Everything the vocabulary cannot spell
(digits, punctuation, any character outside the checkpoint's alphabet) is
dropped, counted, and reported; the words it leaves empty are interpolated by
``apply.py`` rather than given a made-up span.

One forward pass produces the emissions for the whole file; each segment is then
aligned inside its own window. Windows are not a compromise here — they are the
point, twice over:

* **Memory and speed.** One Viterbi path over three minutes of sung audio is
  25 million trellis cells; run per segment it is a few tens of thousands.
* **Blast radius.** A long path has thousands of chances to wander, and every
  wander is a word placed somewhere it was never sung. Per segment, a bad window
  can only damage its own segment — and the guards in ``apply.py`` still get to
  reject that one.

The window is ``apply.limits_for``: the segment the transcriber reported, plus as
much of the silence around it as exists. It is deliberately the *same* window
``apply.py`` enforces, because asking the model about a region it will not be
allowed to use is a lie in the other direction — the emissions would tempt the
path outside the segment and the clamp would then undo the model's best answer.
"""

from __future__ import annotations

import math
from array import array
from typing import Any, Optional, Sequence

from .. import fingerprint, modelstore
from ..config import DEFAULT_ALIGN_MODEL, ALIGN_FRAME_HOP, AlignOptions
from ..media import Audio
from ..models import cached_commit, revision_for, revision_unavailable
from ..model import Transcript
from .apply import limits_for
from .base import AlignmentResult, Aligner, ProgressHook, WordSpan
from .ctc import AlignmentError, forced_align, group_spans, log_softmax, merge_repeats

#: (model, device) → (model, vocab, blank, boundary, hop, sample_rate)
_MODEL_CACHE: dict[tuple, tuple] = {}

#: The same key → which weights the cached pair actually came from, and whether the pin held.
#: Kept beside the cache so the provenance a run writes describes the checkpoint it used, not
#: the one the catalogue asked for.
_LOAD_NOTES: dict[tuple, dict] = {}

#: ~66 minutes of audio at 20 ms frames. Beyond this the emission matrix stops
#: being a rounding error and the pass should be run per section instead.
MAX_FRAMES = 200_000


def clear_cache() -> None:
    _MODEL_CACHE.clear()
    _LOAD_NOTES.clear()


def load_note(model_name: str, device: str) -> dict:
    """Which weights the cached checkpoint came from, or ``{}`` before anything is loaded."""
    return dict(_LOAD_NOTES.get((model_name, device)) or {})


def _load_pair(model_name: str, revision: Optional[str], device: str):
    """
    The checkpoint and its tokenizer, at the pinned commit when the hub still has it.

    The pin is what makes a re-timing pass reproducible: a word moved by a *different* acoustic
    model is not an improvement, it is a different measurement. But a pin is a preference, not a
    promise that the hub keeps the commit, so one that is gone falls forward to the checkpoint's
    ``main`` - once, and only for a failure that is about the revision itself - and the caller is
    handed a note saying so. Everything else (no network, a checkpoint that does not exist) is
    raised as it was rather than retried into a second, more confusing error.

    Returns ``(tokenizer, model, note)``, with the note empty when the pin held or when there was
    never a pin to honour.
    """
    from transformers import AutoTokenizer, Wav2Vec2ForCTC  # type: ignore

    # The verified store, before the hub or the cache is consulted. Same rule as the
    # transcriber's: identical files on every machine, and a mismatch is an error rather than
    # a quiet fallback to a copy nobody verified. See `modelstore.py`.
    stored = modelstore.require(model_name)
    if stored is not None:
        tokenizer = AutoTokenizer.from_pretrained(str(stored), local_files_only=True)
        model = Wav2Vec2ForCTC.from_pretrained(str(stored), local_files_only=True).to(device)
        model.eval()
        return tokenizer, model, ""

    def fetch(pin: Optional[str]):
        kwargs = {"revision": pin} if pin else {}
        tokenizer = AutoTokenizer.from_pretrained(model_name, **kwargs)
        model = Wav2Vec2ForCTC.from_pretrained(model_name, **kwargs).to(device)
        model.eval()
        return tokenizer, model

    if not revision:
        tokenizer, model = fetch(None)
        return tokenizer, model, ""

    try:
        tokenizer, model = fetch(revision)
        return tokenizer, model, ""
    except Exception as exc:  # noqa: BLE001 - re-raised below unless the pin is the problem
        if not revision_unavailable(exc, revision):
            raise
        failure = exc

    note = (
        f"the pinned commit {revision[:8]} of {model_name} is not on the hub any more "
        f"({type(failure).__name__}) - aligning with the current main instead, which is not the "
        "checkpoint these timings were verified against"
    )
    tokenizer, model = fetch(None)
    return tokenizer, model, note


def _load(model_name: str, device: str):
    """
    Load (and cache) the acoustic model, its vocabulary, and its frame geometry.

    Conforming to ``transformers`` rather than hand-rolling a checkpoint loader
    buys one thing that matters: the vocabulary comes from the tokenizer, so a
    different checkpoint (a multilingual one, say) works by naming it.

    The default checkpoint is **pinned** to the commit its weights were verified at (see
    ``models.py``): a re-timing pass is only reproducible if the acoustic model that
    produced the timings is the same one, and the hub's ``main`` can move under a studio
    that was never changed. A checkpoint from outside the catalogue is passed through
    untouched — there is nothing verified to pin it to. A pin the hub no longer has falls
    forward to ``main`` rather than failing the pass (``_load_pair``), and which of the two
    happened is recorded beside the cached model for the provenance to report.
    """
    key = (model_name, device)
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    revision = revision_for(model_name)
    tokenizer, model, note = _load_pair(model_name, revision, device)
    # What the timings are actually made of: the pin when it held, and otherwise the commit
    # `main` resolved to - read off the refs the fetch just wrote, because provenance that says
    # "main" is provenance nobody can compare.
    _LOAD_NOTES[key] = {
        "revision": revision if not note else cached_commit(model_name),
        "pinned": revision,
        "note": note,
    }

    vocab = tokenizer.get_vocab()
    blank = int(vocab.get("<pad>", 0))
    boundary = vocab.get("|")

    stride = getattr(model.config, "conv_stride", None)
    hop = ALIGN_FRAME_HOP
    if stride:
        product = 1
        for step in stride:
            product *= int(step)
        hop = product or ALIGN_FRAME_HOP
    sample_rate = int(getattr(model.config, "sample_rate", 0) or 0) or 16000

    loaded = (model, vocab, blank, boundary, hop, sample_rate)
    _MODEL_CACHE[key] = loaded
    return loaded


class _Emissions:
    """
    The acoustic model's output for one file, as a flat array of logits.

    Flat and ``array('d')`` on purpose: a nested list of Python floats for an hour
    of audio is several hundred megabytes, and there is no reason for a
    measurement pass to need more memory than the audio it measures.
    """

    __slots__ = ("frames", "channels", "data")

    def __init__(self, frames: int, channels: int, data: array):
        self.frames = frames
        self.channels = channels
        self.data = data

    def window(self, first: int, last: int) -> list[list[float]]:
        """Log-softmaxed frames ``[first, last)``, as the CTC core wants them."""
        width = self.channels
        data = self.data
        return [
            log_softmax(data[frame * width : (frame + 1) * width])
            for frame in range(max(0, first), min(self.frames, last))
        ]


def compute_emissions(
    samples: Any,
    model: Any,
    device: str = "cpu",
) -> _Emissions:
    """
    Run the acoustic model over decoded mono samples.

    The zero-mean / unit-variance normalisation is applied here rather than taken
    from a feature extractor: it is three lines, it is the only preprocessing the
    checkpoint expects, and keeping it visible means a wrong input scale shows up
    as a number in a test instead of as a mystery in an accuracy figure.
    """
    import numpy as np  # type: ignore
    import torch  # type: ignore

    waveform = np.asarray(samples, dtype="float32")
    if waveform.size:
        mean = float(waveform.mean())
        variance = float(waveform.var())
        waveform = (waveform - mean) / math.sqrt(variance + 1e-7)

    with torch.inference_mode():
        tensor = torch.from_numpy(waveform).unsqueeze(0).to(device)
        logits = model(tensor).logits

    logits = logits[0].to("cpu")
    frames, channels = int(logits.shape[0]), int(logits.shape[1])
    data = array("d", logits.reshape(-1).tolist())
    return _Emissions(frames, channels, data)


def _torch_threads() -> Optional[int]:
    """What torch chose, not what was configured: the number that changes a matmul's order."""
    try:
        import torch  # type: ignore

        return int(torch.get_num_threads())
    except Exception:  # noqa: BLE001 - provenance must not be the thing that fails a run
        return None


def build_targets(
    words: Sequence[Any],
    vocab: dict,
    boundary: Optional[int],
    *,
    case: Any = str.upper,
    pad_boundaries: bool = False,
) -> tuple[list[int], list[list[int]], int, int]:
    """
    Spell the words into label indices, one group per word.

    ``case`` is how the checkpoint spells its alphabet: ``960h`` is an upper-case
    character model, ``w2v-bert`` is a lower-case one, and getting it backwards does
    not fail - it drops every character and aligns nothing - so it is a parameter
    rather than an assumption buried in the loop.

    ``pad_boundaries`` puts the word boundary token at both **ends** of the target
    sequence as well as between words, which is what a checkpoint trained with a
    filler token expects: the leading and trailing filler are frames the path may
    spend on an ad-lib, a breath or a drum fill instead of stretching them into the
    first and last word. They belong to no word, so no group covers them.

    :returns: ``(targets, groups, dropped, unplaceable)`` — ``groups[k]`` holds the
        *positions* in ``targets`` that belong to word ``k`` (empty when nothing in
        the word was spellable), ``dropped`` counts characters the vocabulary could
        not spell, and ``unplaceable`` counts words left with an empty group.
    """
    per_word: list[list[int]] = []
    dropped = 0
    for word in words:
        indices: list[int] = []
        for char in case(str(word.text)):
            index = vocab.get(char)
            if index is None:
                dropped += 1
                continue
            indices.append(int(index))
        per_word.append(indices)

    targets: list[int] = []
    groups: list[list[int]] = []
    unplaceable = 0
    for indices in per_word:
        if not indices:
            groups.append([])
            unplaceable += 1
            continue
        # A word-boundary token between words: without it the model would see
        # "the end" and "theend" as the same run of characters.
        if targets and boundary is not None:
            targets.append(int(boundary))
        start = len(targets)
        targets.extend(indices)
        groups.append(list(range(start, len(targets))))

    if pad_boundaries and boundary is not None and targets:
        # Outside every group, so the filler can absorb the edges of the window, and
        # so `group_spans` still sees exactly one group per word.
        targets.insert(0, int(boundary))
        for group in groups:
            group[:] = [index + 1 for index in group]
        targets.append(int(boundary))
    return targets, groups, dropped, unplaceable


def word_confidences(
    window: Sequence[Sequence[float]],
    path: Sequence[int],
    targets: Sequence[int],
    spans: Sequence[Optional[tuple[int, int]]],
    blank: int,
) -> list[float]:
    """
    Per-word posterior: the mean probability the path assigns to *its own* labels.

    This is not a goodness-of-fit statistic for the audio; it is the model's own
    certainty about the labels it chose for that word, which is exactly what the
    confidence guard in ``apply.py`` needs. A word over a drum fill scores near
    zero and gets its original timings back.
    """
    per_frame: list[float] = []
    for frame, state in enumerate(path):
        if state % 2 == 0:
            per_frame.append(math.exp(window[frame][blank]))
        else:
            probability = math.exp(window[frame][targets[state // 2]])
            per_frame.append(0.0 if probability != probability else probability)

    out: list[float] = []
    for span in spans:
        if span is None:
            out.append(0.0)
            continue
        first, last = span
        chunk = per_frame[first : last + 1]
        out.append(sum(chunk) / len(chunk) if chunk else 0.0)
    return out


class Wav2VecAligner(Aligner):
    name = "wav2vec2"

    #: How this checkpoint spells its alphabet, and whether it wants the word-boundary
    #: filler at the ends of the target sequence too. Both are overridden by a backend
    #: built on a different checkpoint - see `w2vbert.py`.
    #: ``staticmethod``: a bare ``str.upper`` as a class attribute is a descriptor and
    #: would arrive bound to the aligner, so ``self.case(text)`` would pass `self` as
    #: the string to upper-case.
    case = staticmethod(str.upper)
    pad_boundaries: bool = False

    def _load_checkpoint(self, model_name: str, device: str):
        """``(model, vocab, blank, boundary, hop, sample_rate)`` for one checkpoint."""
        return _load(model_name, device)

    def _emissions(self, samples: Any, model: Any, device: str) -> _Emissions:
        """The checkpoint's acoustic output for the whole file, one frame per label."""
        return compute_emissions(samples, model, device)

    def available(self) -> tuple[bool, str]:
        try:
            import torch  # type: ignore  # noqa: F401
            import transformers  # type: ignore  # noqa: F401
        except ImportError:
            return False, "torch and transformers are not installed (pip install -e '.[align]')"
        return True, f"torch {torch.__version__}, transformers {transformers.__version__}"

    def align(
        self,
        audio: Audio,
        transcript: Transcript,
        options: AlignOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> AlignmentResult:
        usable, reason = self.available()
        if not usable:
            raise RuntimeError(reason)
        if audio.samples is None:
            raise RuntimeError("alignment needs decoded audio: load it with load_audio(..., decode=True)")

        model_name = options.model or DEFAULT_ALIGN_MODEL
        model, vocab, blank, boundary, hop, sample_rate = self._load_checkpoint(model_name, options.device)
        # Which weights, in the artifact: two machines that re-time the same transcript
        # differently should be comparable without guessing at the checkpoint. Read from the load
        # rather than from the catalogue, so a run that had to fall forward reports the commit it
        # actually used.
        loaded = load_note(model_name, options.device)
        revision = loaded.get("revision")

        if audio.sample_rate != sample_rate:
            raise RuntimeError(
                f"{model_name} expects {sample_rate} Hz audio; got {audio.sample_rate} Hz. "
                "Re-decode at the model's rate (load_audio(sample_rate=...)) before aligning."
            )

        warnings: list[str] = []
        if on_progress:
            on_progress(0.05, f"acoustic features ({model_name})")

        emissions = self._emissions(audio.samples, model, options.device)
        if emissions.frames == 0:
            return AlignmentResult(provenance={"backend": self.name, "model": model_name, "frames": 0}, warnings=warnings)
        if emissions.frames > MAX_FRAMES:
            raise RuntimeError(
                f"this pass aligns {emissions.frames} frames (limit {MAX_FRAMES}); "
                "split the audio into sections and align each one"
            )

        seconds_per_frame = hop / sample_rate

        spans: list[list[Optional[WordSpan]]] = []
        dropped_total = 0
        unplaceable_total = 0
        failed = 0
        total = len(transcript.segments) or 1

        for index, segment in enumerate(transcript.segments):
            # The same window `apply.py` will enforce. Asking the model about a
            # region it is not allowed to use would be a lie in the other
            # direction: the emissions would tempt the path outside the segment,
            # and the clamp upstream would then have to undo the model's own
            # best answer.
            limits = limits_for(transcript, index, options)
            spans.append(
                self._align_segment(
                    segment,
                    limits,
                    emissions,
                    vocab,
                    blank,
                    boundary,
                    hop,
                    sample_rate,
                    warnings,
                )
            )
            dropped_total += _last_counts["dropped"]
            unplaceable_total += _last_counts["unplaceable"]
            failed += _last_counts["failed"]
            if on_progress:
                on_progress(0.05 + 0.9 * (index + 1) / total, f"{index + 1}/{total} segments")

        if dropped_total:
            warnings.append(
                f"{dropped_total} character(s) are not in {model_name}'s alphabet (digits, punctuation, "
                "accented letters) and were ignored while locating words"
            )
        if unplaceable_total:
            warnings.append(f"{unplaceable_total} word(s) had nothing alignable in them")
        if failed:
            warnings.append(f"{failed} segment(s) could not be aligned inside their window")
        if loaded.get("note"):
            # The timings are real, but they were not measured against the checkpoint this project
            # verified, so the run says so where the timings are, not only on a terminal.
            warnings.append(f"{loaded['note']} - these timings may not reproduce")

        if on_progress:
            on_progress(1.0, f"{len(transcript.segments)} segments aligned")

        return AlignmentResult(
            spans=spans,
            provenance={
                "backend": self.name,
                "model": model_name,
                "revision": revision,
                "revisionFallback": loaded.get("note") or None,
                "device": options.device,
                # The files that produced these emissions, and the kernel/thread count they ran
                # on. Two machines that disagree about a word's onset can compare these three
                # numbers before anyone blames the algorithm: a different hash is different
                # weights, a different capability is a different kernel, and a different thread
                # count *can* change the last bits of a matmul.
                "weightsSha256": (
                    fingerprint.weights_digest(model_name, revision=revision or None).get("sha256")
                ),
                "torchThreads": _torch_threads(),
                "cpuCapability": fingerprint.cpu_capability(),
                "frames": emissions.frames,
                "channels": emissions.channels,
                "frameHop": hop,
                "sampleRate": sample_rate,
                "secondsPerFrame": round(seconds_per_frame, 5),
                "wordsUnplaceable": unplaceable_total,
                "charactersDropped": dropped_total,
            },
            warnings=warnings,
        )

    def _align_segment(
        self,
        segment,
        limits: tuple[float, float],
        emissions: _Emissions,
        vocab: dict,
        blank: int,
        boundary: Optional[int],
        hop: int,
        sample_rate: int,
        warnings: list[str],
    ) -> list[Optional[WordSpan]]:
        """One segment, inside the window the transcriber allocated it. Never raises."""
        _last_counts["dropped"] = 0
        _last_counts["unplaceable"] = 0
        _last_counts["failed"] = 0

        words = segment.words
        if not words:
            return []

        targets, groups, dropped, unplaceable = build_targets(
            words, vocab, boundary, case=self.case, pad_boundaries=self.pad_boundaries
        )
        _last_counts["dropped"] = dropped
        _last_counts["unplaceable"] = unplaceable
        if not targets:
            return [None] * len(words)

        seconds_per_frame = hop / sample_rate
        left, right = limits
        first = max(0, int(left / seconds_per_frame))
        last = min(emissions.frames, int(right / seconds_per_frame) + 1)
        if last - first < 2:
            _last_counts["failed"] = 1
            return [None] * len(words)

        window = emissions.window(first, last)
        try:
            path, _score = forced_align(window, targets, blank)
            repeats = merge_repeats(path)
            frames = group_spans(repeats, groups, targets)
        except AlignmentError as exc:
            warnings.append(f"{segment.id or 'segment'}: {exc}")
            _last_counts["failed"] = 1
            return [None] * len(words)

        confidences = word_confidences(window, path, targets, frames, blank)

        out: list[Optional[WordSpan]] = []
        for span, confidence in zip(frames, confidences):
            if span is None:
                out.append(None)
                continue
            out.append(
                WordSpan(
                    # A label covering frames [a, b] occupies samples
                    # [a*hop, (b+1)*hop), so the word starts at the frame's own
                    # start and ends where the last frame ends. This is the
                    # convention the whole alignment is calibrated to.
                    start=round((first + span[0]) * seconds_per_frame, 6),
                    end=round((first + span[1] + 1) * seconds_per_frame, 6),
                    confidence=confidence,
                )
            )
        return out


#: Counters for the segment currently being aligned. A backend that returned them
#: alongside the spans would have to change the interface every time a statistic
#: was wanted, so they are collected here per call instead.
_last_counts: dict[str, int] = {"dropped": 0, "unplaceable": 0, "failed": 0}


__all__ = [
    "MAX_FRAMES",
    "Wav2VecAligner",
    "build_targets",
    "clear_cache",
    "compute_emissions",
    "word_confidences",
]
