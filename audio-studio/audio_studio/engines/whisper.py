"""
engines/whisper.py — the local Whisper backend, on faster-whisper / CTranslate2.

Why this backend first: no PyTorch, int8 quantization, and the best
throughput-per-core of the CPU-capable options — which is the whole ballgame on
a 4-core, GPU-less machine.

Two behaviours are worth knowing, because both exist to protect *timing*:

``vad_filter``
    Off unless asked for. Voice-activity gating is tuned for speech, not for a
    *sung* vocal, which it does not classify as voice: on the real fixture it
    cut 224 words down to 2. Enable it only for spoken-word audio with long
    instrumental stretches, where hallucinating over the music is the larger
    risk. (Whisper does invent text over music, which is the trade-off; see
    ``config.DEFAULT_VAD_FILTER``.)

``condition_on_previous_text=False``
    Whisper conditions each window on the previous window's text by default,
    which is what makes it emit a repeated/looping line across a musical break.
    Since this studio exists to make captions line up with a spoken track that
    may sit over a music bed, looped text is a correctness bug, not a nuisance.

Model instances are cached: constructing one reparses hundreds of MB of weights,
and a job queue will ask for the same model repeatedly. The *weights* are cached
too, by the Hugging Face hub, and this module says so out loud — a run whose wait
is a disk read reports that, rather than looking like an unexpected download. See
``load_plan()``.

The weights are also **pinned**. A short name like ``small`` resolves to whatever its
repository's ``main`` points at on the day it is fetched, so two machines installing a
month apart can transcribe the same recording differently with nothing in the output to
say why. ``models.py`` records the commit each model was verified at and this module
passes it to the loader, so the revision is part of the run rather than a fact about
the afternoon it happened. An unpinned model (a local path, a hub id we do not
catalogue) is passed through untouched, because there is nothing verified to pin it to.

A pin is a preference, not a promise. The hub can force a commit away, and a studio that
refused to run when it did would be broken for a reason nobody could act on - so a pin
that is no longer there falls forward to ``main`` once, says so in its own output, and
records the commit it actually loaded in the artifact. See ``_load_with_pin`` and
``models.revision_unavailable``.
"""

from __future__ import annotations

from typing import Any, Optional

from .. import models
from ..config import TranscribeOptions
from ..media import Audio
from ..model import Segment, Transcript, Word
from .base import Engine, ProgressHook

#: (model, device, compute_type, cpu_threads) → WhisperModel
_MODEL_CACHE: dict[tuple, Any] = {}

#: The same key → how that model got here. Kept beside the cache so a second run can say
#: "already loaded in this server" instead of re-reporting a load it is not doing.
_MODEL_NOTES: dict[tuple, dict] = {}


def clear_cache() -> None:
    _MODEL_CACHE.clear()
    _MODEL_NOTES.clear()


def load_plan(
    model_name: str,
    *,
    root: Any = None,
    env: Any = None,
) -> dict:
    """
    How a model will be obtained, as data — the answer to "is this downloading again?".

    Pure, and free of imports: the catalogue in ``models.py`` already knows whether the
    snapshot is on this machine, and that one fact decides both what happens next and what
    a person should be told while it happens.

    The three cases are genuinely different waits and are not collapsed into one message:

    * ``downloaded is True`` — the weights are here, so the load is a disk read and the
      hub is not contacted at all (``localOnly``). Measured on this machine: resolving the
      cached snapshot over the network cost 1.16 s against 0.27 s offline, per model, per
      process — small, but it is the part that touches the network on every run.
    * ``downloaded is False`` — a first run genuinely fetches the weights, which is the
      multi-hundred-megabyte wait people mistake for the model being rebuilt each time.
    * ``downloaded is None`` — a name we do not catalogue (a local path, or any hub id the
      library understands). Nothing is assumed about it and nothing is passed to it.

    ``revision`` is the commit the weights are pinned to, or ``None`` for a model nothing
    here has verified. It is returned rather than looked up again at load time so the plan
    and the load cannot disagree about which weights this run is about.
    """
    info = models.describe(model_name, root=root, env=env)
    downloaded = info.get("downloaded")
    family = str(info.get("family") or model_name)
    repo = str(info.get("repo") or model_name)
    params = str(info.get("params") or "")
    size = f", {params}" if params else ""

    if downloaded is True:
        message = f"{family} is already on this machine — reading it from the cache, no download"
    elif downloaded is False:
        message = (
            f"{family} is not on this machine yet — fetching {repo}{size} once; "
            "every later run reads it from the cache"
        )
    else:
        message = f"loading {repo}{size}"

    return {
        "name": str(model_name),
        "family": family,
        "repo": repo,
        "params": params,
        "downloaded": downloaded,
        "localOnly": downloaded is True,
        "revision": info.get("revision"),
        "message": message,
    }


def loaded_state() -> list[dict]:
    """Every model this process is holding, and what it cost to get it here."""
    return [dict(note) for note in _MODEL_NOTES.values()]


def _load_with_pin(model_name: str, model_kwargs: dict, plan: dict) -> tuple[Any, str]:
    """
    Construct the model at its pinned commit, falling forward to the hub's ``main`` if that
    commit is not there any more. Returns ``(model, note)``, the note empty when the pin held.

    The pin is a preference for the weights this project measured, not a promise that the hub
    keeps them. A commit that was force-pushed away used to turn a working install into a
    failed run - and, worse, a hub error that named neither the preset nor the reason. Here it
    costs one retry.

    One retry, not a loop, and only for a failure that is *about the revision*
    (:func:`models.revision_unavailable`): loading other weights changes what the run means,
    so the caller is told in the returned note rather than left to notice. Everything else -
    no network, a repository that is gone, a file named wrong - is raised as it was, because a
    second attempt at ``main`` would fail the same way and bury the first error.
    """
    from faster_whisper import WhisperModel  # type: ignore

    pin = str(model_kwargs.get("revision") or "")
    try:
        return WhisperModel(model_name, **model_kwargs), ""
    except Exception as exc:  # noqa: BLE001 - re-raised below unless the pin is the problem
        if not pin or not models.revision_unavailable(exc, pin):
            raise
        failure = exc

    latest = {name: value for name, value in model_kwargs.items() if name != "revision"}
    note = (
        f"the pinned commit {pin[:8]} of {plan.get('repo') or model_name} is not on the hub any more "
        f"({type(failure).__name__}) - loading the current main instead, which is not the set of weights "
        "this project measured"
    )
    return WhisperModel(model_name, **latest), note


def _load_model(options: TranscribeOptions, on_progress: Optional[ProgressHook] = None):
    """
    Construct (or reuse) the model for these options.

    The cache is the whole point: constructing a model reparses hundreds of megabytes of
    weights and this server answers a queue of jobs from one process, so the second run of
    the same preset must not pay for the first run's load. What is *not* cached is
    reported honestly — a run that loads a model from disk emits a message saying so
    before it starts, because "model loaded" arriving a minute later with no explanation is
    indistinguishable from an unexpected download.
    """
    import time

    from faster_whisper import WhisperModel  # type: ignore

    model_name = options.resolved_model()
    key = (model_name, options.device, options.compute_type, options.cpu_threads)

    cached = _MODEL_CACHE.get(key)
    if cached is not None:
        note = _MODEL_NOTES.get(key) or {}
        if on_progress:
            on_progress(0.02, f"{note.get('family', model_name)} is already loaded in this server")
        return cached

    plan = load_plan(model_name)
    if on_progress:
        on_progress(0.02, plan["message"])

    model_kwargs: dict = {"device": options.device, "compute_type": options.compute_type}
    if options.cpu_threads:
        model_kwargs["cpu_threads"] = options.cpu_threads
    if plan["revision"]:
        # The verified commit, not whatever the hub serves today. A short name is not a
        # version, and a transcript that cannot be reproduced is a transcript nobody can
        # check — see `models.py`.
        model_kwargs["revision"] = plan["revision"]

    started = time.perf_counter()
    source = "download" if plan["downloaded"] is False else "disk"
    if plan["localOnly"]:
        # Cached weights, and the hub is not asked about them: the model is already here,
        # so a network round-trip can only add a wait or fail a run that would have worked
        # offline. A snapshot that turns out to be incomplete falls back to the network
        # below, once, rather than failing the job.
        try:
            model = WhisperModel(model_name, local_files_only=True, **model_kwargs)
            note = ""
        except Exception as exc:  # noqa: BLE001 - only to retry with the hub reachable
            if on_progress:
                on_progress(0.02, f"{plan['family']}: the cached copy is incomplete ({exc}); fetching it")
            source = "download"
            model, note = _load_with_pin(model_name, model_kwargs, plan)
    else:
        model, note = _load_with_pin(model_name, model_kwargs, plan)

    # Which weights, in the artifact. The pin when the pin held; and when it did not, the commit
    # the hub's `main` resolved to - read off the `refs/main` the fetch just wrote, because
    # "main, whatever it was that afternoon" is not something two machines can be compared with.
    revision = plan["revision"]
    if note:
        revision = models.cached_commit(plan["repo"])
        if on_progress:
            on_progress(0.02, note)

    seconds = time.perf_counter() - started
    _MODEL_CACHE[key] = model
    _MODEL_NOTES[key] = {
        "model": model_name,
        "family": plan["family"],
        "repo": plan["repo"],
        "device": options.device,
        "computeType": options.compute_type,
        "revision": revision,
        "revisionNote": note,
        "source": source,
        "seconds": round(seconds, 2),
    }
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

        model = _load_model(options, on_progress)
        model_name = options.resolved_model()
        key = (model_name, options.device, options.compute_type, options.cpu_threads)
        load_note = dict(_MODEL_NOTES.get(key) or {})
        total = audio.duration or 0.0

        if on_progress:
            where = {
                "disk": "from the cache",
                "download": "just fetched from the hub",
            }.get(load_note.get("source"), "")
            took = f" in {load_note['seconds']}s" if load_note.get("seconds") else ""
            # The pin, shortened, on the line that says a model was loaded: "which weights"
            # is the question a second machine's different transcript raises, and this is
            # the one place it is answerable without reading the artifact.
            pin = f" @{load_note['revision'][:8]}" if load_note.get("revision") else ""
            on_progress(0.05, f"loaded {model_name}{pin}{took} {where}".rstrip())

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
                # Where the weights came from this run: `disk` means the cache was reused
                # and the hub was never asked, `download` means this machine did not have
                # them yet. A run that fetched 756 MB should say so in its own artifact.
                "modelSource": load_note.get("source"),
                "modelLoadSeconds": load_note.get("seconds"),
                # The exact commit these words came out of, or `null` for a model nothing
                # here has verified. Recorded in the artifact so two machines can be
                # compared without guessing at the weights - see `models.py`. When the pin
                # was gone and `main` was loaded instead, this is the commit `main` resolved
                # to, and `modelRevisionFallback` says what happened.
                "modelRevision": load_note.get("revision"),
                "modelRevisionFallback": load_note.get("revisionNote") or None,
            },
        )

        if not options.word_timestamps:
            transcript.warnings.append(
                "word timestamps are disabled: per-word editing and split/join will not be available"
            )
        if load_note.get("revisionNote"):
            # A warning rather than a log line: these words did not come out of the weights this
            # project measured, which is exactly the kind of thing a transcript should carry with
            # it rather than something only the terminal of the run that made it saw.
            transcript.warnings.append(
                f"{load_note['revisionNote']} - this transcript may not reproduce on a machine that "
                "still has the pinned commit"
            )
        if not segments:
            transcript.warnings.append("no speech detected in this audio")

        if on_progress:
            on_progress(1.0, f"{transcript.word_count} words")
        return transcript
