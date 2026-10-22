"""
parity.py — one clip, every stage, one hash per stage.

The question this answers is the one a support thread cannot: *two machines, same
code, same song — where do they stop agreeing?* ``doctor`` describes a machine;
``parity`` runs a clip through it. The report is a chain:

    source ─▶ pcm ─▶ weights ─▶ transcript ─▶ emissions ─▶ alignment
    (bytes)   (what    (what      (what        (what the     (where the
              the       the        Whisper     aligner       words landed)
              decoder   loader     heard)      heard)
              made)     loaded)

Each stage is a hash of the thing the next stage consumes, so the **first**
stage that differs is the cause and everything after it is consequence. That
distinction is the whole value: "the aligner is worse on your laptop" is almost
never the aligner, and this report says so with a hash rather than an opinion.

Deliberate choices, because a digest tool that lies is worse than none:

* **The clip is fixed by the caller and truncated here**, not chosen by the tool.
  Twenty seconds of the same song on both machines is a comparison; a different
  song is two unrelated reports.
* **The PCM is hashed, not the file.** ``media.sha256`` hashes the container, and
  the container is not what the model sees.
* **The weights are hashed, not the revision.** A pin is what the loader asked
  for; the hash is what it got.
* **The emissions are rounded to 1e-4 nats before hashing.** Two CPUs are
  entitled to differ in the last bits of a matmul and that is not a bug worth
  reporting; a difference big enough to move a Viterbi path is.
* **A missing optional extra is a stage with an error in it, not a crashed run.**
  A machine without torch still gets a Whisper stage, which is exactly the
  comparison someone debugging an aligner needs.
"""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Any, Optional

from . import fingerprint
from .align.wav2vec import compute_emissions
from .config import DEFAULT_ALIGN_MODEL, DEFAULT_COMPUTE_TYPE, AlignOptions, TranscribeOptions
from .media import Audio, load_audio

#: Rounding applied to emissions before they are hashed. Far below the ~20 ms frame
#: resolution the alignment works at, and far above the float noise two kernels produce.
EMISSION_PLACES = 4


class ParityError(RuntimeError):
    """The comparison could not be made at all."""


def _digest(values: Any) -> str:
    return sha256(str(values).encode("utf-8")).hexdigest()


def _excerpt(audio: Audio, seconds: Optional[float]) -> Any:
    if audio.samples is None:
        raise ParityError("parity listens to the audio: decode it first (load_audio(..., decode=True))")
    if not seconds or seconds <= 0 or audio.duration <= seconds:
        return audio.samples
    return audio.samples[: int(round(seconds * audio.sample_rate))]


def _why(exc: BaseException) -> str:
    """
    What a failed stage should say about the exception, even when it says nothing.

    Some failures arrive bare — an ``OSError`` from a handle that closed, a mapping that
    failed — and ``str(exc)`` is then ``""``. A report line reading "could not run: " is
    the one thing worse than a wrong answer, so the type name is the floor here.
    """
    return str(exc) or type(exc).__name__


def run_parity(
    path: str | Path,
    *,
    seconds: Optional[float] = 30.0,
    model: Optional[str] = None,
    device: str = "cpu",
    compute_type: str = DEFAULT_COMPUTE_TYPE,
    cpu_threads: int = 0,
    align_model: str = DEFAULT_ALIGN_MODEL,
    on_progress=None,
) -> dict:
    """
    Run ``path``'s first ``seconds`` through the real pipeline and hash every stage.

    Raises :class:`ParityError` only when there is no clip to compare — an unreadable
    file, or audio that was never decoded. A stage that cannot run is reported as an
    error *inside* the report, because the whole point of running this on three
    machines is that some of them are missing an extra.
    """
    def step(fraction: float, message: str) -> None:
        if on_progress:
            on_progress(fraction, message)

    step(0.02, "decoding")
    audio = load_audio(path, decode=True)
    samples = _excerpt(audio, seconds)
    rate = audio.sample_rate
    clip_seconds = round(len(samples) / rate, 3) if len(samples) else 0.0
    clip = Audio(
        path=audio.path,
        samples=samples,
        sample_rate=rate,
        duration=clip_seconds,
        sha256=audio.sha256,
        source_sample_rate=audio.source_sample_rate,
        channels=audio.channels,
        decoded_by=audio.decoded_by,
    )

    options = TranscribeOptions(
        model=model,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )
    model_name = options.resolved_model()

    report: dict = {
        "audioStudio": _version(),
        "clipSeconds": clip_seconds,
        "computeType": compute_type,
        "cpuThreads": cpu_threads or None,
        "model": model_name,
        "alignModel": align_model,
        "environment": fingerprint.environment(),
        "source": {
            "file": Path(path).name,
            "sha256": audio.sha256,
            "bytes": Path(path).stat().st_size if Path(path).is_file() else 0,
            "decodedBy": audio.decoded_by or None,
            "sampleRate": audio.source_sample_rate,
            "channels": audio.channels,
        },
        "pcm": {
            **(fingerprint.samples_digest(samples) or {}),
            "sampleRate": rate,
        },
        "weights": fingerprint.weights_digest(model_name),
        "transcript": None,
        "emissions": None,
        "alignment": None,
        "warnings": [],
    }

    step(0.12, "transcribing")
    transcript = None
    try:
        from .engines import get_engine

        engine = get_engine("whisper")
        usable, reason = engine.available()
        if not usable:
            raise ParityError(reason)
        transcript = engine.transcribe(clip, options)
    except Exception as exc:  # noqa: BLE001 - a stage, not a crash
        report["warnings"].append(f"transcription stage could not run: {_why(exc)}")

    if transcript is not None:
        words = [(word.text, round(word.start, 3), round(word.end, 3)) for s in transcript.segments for word in s.words]
        report["transcript"] = {
            "segments": len(transcript.segments),
            "words": len(words),
            "sha256": _digest(words),
            "textSha256": _digest(" ".join(word[0] for word in words)),
            "first": " ".join(word[0] for word in words[:12]).strip(),
        }

    step(0.55, f"emissions ({align_model})")
    emissions = None
    try:
        from .align import wav2vec

        aligner_model, _vocab, _blank, _boundary, hop, sample_rate = wav2vec._load(align_model, "cpu")
        if rate != sample_rate:
            raise ParityError(f"{align_model} expects {sample_rate} Hz; the decoder gave {rate} Hz")
        emissions = compute_emissions(samples, aligner_model, "cpu")
    except Exception as exc:  # noqa: BLE001 - a stage, not a crash
        report["warnings"].append(f"emissions stage could not run: {_why(exc)}")

    if emissions is not None:
        rounded = [round(value, EMISSION_PLACES) for value in emissions.data]
        # A spot value is included so two machines that agree on the hash can still be
        # told apart from two machines that both produced zeros.
        report["emissions"] = {
            "sha256": _digest(rounded),
            "frames": emissions.frames,
            "channels": emissions.channels,
            "frameHop": hop,
            "first4": rounded[:4],
        }

    if transcript is not None:
        step(0.8, "alignment")
        try:
            from .align import align_transcript

            aligned = align_transcript(transcript, clip, AlignOptions(model=align_model), "wav2vec")
            spans = [
                (word.text, round(word.start, 3), round(word.end, 3))
                for segment in aligned.segments
                for word in segment.words
            ]
            provenance = aligned.alignment or {}
            report["alignment"] = {
                "sha256": _digest(spans),
                "words": len(spans),
                "segments": provenance.get("segments"),
                "segmentsAligned": provenance.get("segmentsAligned"),
                "segmentsKept": provenance.get("segmentsKept"),
                "meanConfidence": provenance.get("meanConfidence"),
                "meanShift": provenance.get("meanShift"),
                "weightsSha256": (provenance or {}).get("weightsSha256"),
            }
        except Exception as exc:  # noqa: BLE001 - a stage, not a crash
            report["warnings"].append(f"alignment stage could not run: {_why(exc)}")

    step(1.0, "done")
    return report


def _version() -> str:
    from . import __version__

    return __version__


__all__ = ["EMISSION_PLACES", "ParityError", "run_parity"]
