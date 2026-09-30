"""
engines/whisper.py — the local Whisper backend, on faster-whisper / CTranslate2.

Why this backend first: no PyTorch, int8 quantization, and the best
throughput-per-core of the CPU-capable options — which is the whole ballgame on
a 4-core, GPU-less machine.

Two behaviours are worth knowing, because both exist to protect *timing*:

``vad_filter``
    Voice-activity gating, so a long instrumental stretch is silence rather than
    hallucinated lyrics. Whisper invents text over music; VAD is the cheapest
    way to stop it.

``condition_on_previous_text=False``
    Whisper conditions each window on the previous window's text by default,
    which is what makes it emit a repeated/looping line across a musical break.
    Since this studio exists to make captions line up with a spoken track that
    may sit over a music bed, looped text is a correctness bug, not a nuisance.

Model instances are cached: constructing one reparses hundreds of MB of weights,
and a job queue will ask for the same model repeatedly.
"""

from __future__ import annotations

from typing import Any, Optional

from ..config import TranscribeOptions
from ..media import Audio
from ..model import Segment, Transcript, Word
from .base import Engine, ProgressHook

#: (model, device, compute_type, cpu_threads) → WhisperModel
_MODEL_CACHE: dict[tuple, Any] = {}


def clear_cache() -> None:
    _MODEL_CACHE.clear()


def _load_model(options: TranscribeOptions):
    from faster_whisper import WhisperModel  # type: ignore

    model_name = options.resolved_model()
    key = (model_name, options.device, options.compute_type, options.cpu_threads)
    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        return cached

    model_kwargs: dict = {"device": options.device, "compute_type": options.compute_type}
    if options.cpu_threads:
        model_kwargs["cpu_threads"] = options.cpu_threads

    model = WhisperModel(model_name, **model_kwargs)
    _MODEL_CACHE[key] = model
    return model


class WhisperEngine(Engine):
    name = "faster-whisper"

    def available(self) -> tuple[bool, str]:
        try:
            import faster_whisper  # type: ignore
        except ImportError:
            return False, "faster-whisper is not installed (pip install -e '.[asr]')"
        return True, f"faster-whisper {getattr(faster_whisper, '__version__', '?')}"

    def transcribe(
        self,
        audio: Audio,
        options: TranscribeOptions,
        on_progress: Optional[ProgressHook] = None,
    ) -> Transcript:
        usable, reason = self.available()
        if not usable:
            raise RuntimeError(reason)

        model = _load_model(options)
        model_name = options.resolved_model()
        total = audio.duration or 0.0

        if on_progress:
            on_progress(0.05, f"loaded {model_name}")

        # Prefer the decoded buffer when we have one: it is already 16 kHz mono,
        # so decoding a video twice (once for the hash, once for the model) is
        # an easy waste to avoid.
        source = audio.samples if audio.samples is not None else str(audio.path or "")

        segment_iter, info = model.transcribe(
            source,
            language=options.language,
            beam_size=options.beam_size,
            vad_filter=options.vad_filter,
            word_timestamps=options.word_timestamps,
            condition_on_previous_text=options.condition_on_previous_text,
            initial_prompt=options.initial_prompt,
            temperature=options.temperature,
        )

        segments: list[Segment] = []
        for raw in segment_iter:
            words = [
                Word(
                    text=str(getattr(w, "word", "")),
                    start=float(getattr(w, "start", 0.0) or 0.0),
                    end=float(getattr(w, "end", 0.0) or 0.0),
                    probability=getattr(w, "probability", None),
                )
                for w in (getattr(raw, "words", None) or [])
            ]
            segments.append(
                Segment(
                    start=float(getattr(raw, "start", 0.0) or 0.0),
                    end=float(getattr(raw, "end", 0.0) or 0.0),
                    words=words,
                    text=str(getattr(raw, "text", "") or ""),
                    no_speech_probability=getattr(raw, "no_speech_prob", None),
                )
            )
            if on_progress and total > 0:
                fraction = min(0.95, max(0.05, float(raw.end) / total))
                on_progress(fraction, f"{len(segments)} segments")

        transcript = Transcript.from_segments(
            segments,
            language=getattr(info, "language", options.language),
            duration=float(getattr(info, "duration", 0.0) or audio.duration or 0.0),
            source=audio.to_dict(),
            engine={
                "name": self.name,
                "model": model_name,
                "device": options.device,
                "computeType": options.compute_type,
                "beamSize": options.beam_size,
                "vadFilter": options.vad_filter,
                "wordTimestamps": options.word_timestamps,
                "conditionOnPreviousText": options.condition_on_previous_text,
                "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
                "preset": options.preset,
            },
        )

        if not options.word_timestamps:
            transcript.warnings.append(
                "word timestamps are disabled: per-word editing and split/join will not be available"
            )
        if not segments:
            transcript.warnings.append("no speech detected in this audio")

        if on_progress:
            on_progress(1.0, f"{transcript.word_count} words")
        return transcript
