"""
server.py — the local HTTP server that lets ``caption-studio`` ask for a job.

The sibling studio is a browser app; a browser cannot spawn a Python process, so
the studio it wants to hand audio to has to answer over HTTP. This is that door,
and it is deliberately the *only* network surface in the suite:

* **It binds to ``127.0.0.1`` by default.** Nothing here is designed to be
  exposed, and the default should not tempt anyone to try.
* **It is stdlib-only.** ``http.server`` and a thread, no Flask. The base
  install must stay instant, and a local job runner is not worth a framework.
* **One worker, one job at a time.** Transcription saturates the four cores this
  machine has; running two jobs in parallel would finish both later than running
  them in sequence. Jobs therefore queue.

The workflow mirrors how the browser already thinks: POST a job, poll it, then
fetch the artifact. A job's artifacts are the same files the CLI writes, so
``caption-studio`` can load the Veed-shaped one exactly as it would a file from
disk — the server is a transport, not a second implementation.

    POST /transcribe  {path, engine?, preset?, model?, language?, emit?, emphasis?,
                       align?, validate?, alignModel?, llmProvider?, llmModel?}
                      → 202 {jobId}
    POST /transcribe/upload?name=<file>
                      the file itself as the request body → 202 {jobId}
    GET  /jobs/{id}   → the job's status, progress and (when done) file list
    GET  /jobs/{id}/{kind}
                      → the artifact bytes: kind is json | veed | srt | vtt
    GET  /jobs        → every job, newest first
    DELETE /jobs/{id} → forget a job (does not delete its files)
    GET  /health      → version, usable engines, aligners, validators, presets

The second POST is not a convenience. A browser cannot read a file's path off the
user's disk — deliberately — so a page that only accepted ``{path}`` would make its
user type an absolute path from memory. Uploading the bytes it already has is the
honest way for the two studios to meet, and the cap plus the extension allow-list
below is what keeps a loopback endpoint from becoming an open write to disk.
"""

from __future__ import annotations

import json
import queue
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from . import __version__
from .align import aligner_names, available_aligners
from .config import DEFAULT_ALIGN_MODEL, DEFAULT_PRESET, PRESETS, AlignOptions, ValidateOptions, options_from_preset
from .emit import DEFAULT_KINDS, filename, kinds, write_bundle
from .engines import available_engines, engine_names, get_engine
from .media import AUDIO_EXTENSIONS, MediaError, load_audio
from .pipeline import PipelineOptions, post_process
from .validate import available_validators, validator_names

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8756

#: Content type per emit kind, so the browser can tell a JSON body from a cue file.
CONTENT_TYPES = {
    "json": "application/json; charset=utf-8",
    "veed": "application/json; charset=utf-8",
    "srt": "text/plain; charset=utf-8",
    "vtt": "text/vtt; charset=utf-8",
}

MAX_BODY = 1 << 20  # a JSON job request is a few hundred bytes; refuse the rest

#: An uploaded source file, by contrast, is the media itself. Half a gigabyte
#: covers a long session recording and still bounds what a stray client can write.
MAX_UPLOAD = 512 << 20

UPLOAD_CHUNK = 1 << 20


#: The last built ``/health`` payload. See :func:`health_report`.
_HEALTH: Optional[dict] = None
_HEALTH_LOCK = threading.Lock()


class JobError(RuntimeError):
    """A request that cannot be turned into a job."""


@dataclass
class Job:
    """One transcription request and everything known about it."""

    id: str
    source: str
    engine: str
    preset: str
    model: Optional[str] = None
    language: Optional[str] = None
    emit: list[str] = field(default_factory=lambda: list(DEFAULT_KINDS))
    emphasis: str = "none"
    word_level: bool = False
    align: Optional[str] = None
    validate: Optional[str] = None
    align_model: Optional[str] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    created: float = field(default_factory=time.time)
    started: Optional[float] = None
    finished: Optional[float] = None
    stem: str = ""
    outdir: Path = field(default=Path("."), repr=False)
    files: dict[str, str] = field(default_factory=dict)
    summary: Optional[dict] = None

    def to_dict(self) -> dict:
        data = {
            "jobId": self.id,
            "status": self.status,
            "progress": round(self.progress, 4),
            "message": self.message,
            "source": self.source,
            "engine": self.engine,
            "preset": self.preset,
            "model": self.model,
            "language": self.language,
            "emit": list(self.emit),
            "align": self.align,
            "validate": self.validate,
            "created": round(self.created, 3),
            "started": round(self.started, 3) if self.started else None,
            "finished": round(self.finished, 3) if self.finished else None,
            "files": {kind: path for kind, path in self.files.items()},
            "urls": {kind: f"/jobs/{self.id}/{kind}" for kind in self.files},
        }
        if self.finished and self.started:
            data["seconds"] = round(self.finished - self.started, 3)
        if self.error:
            data["error"] = self.error
        if self.summary:
            data["summary"] = self.summary
        return data


class Jobs:
    """
    The job store and its single worker.

    State is in memory and intentionally not persisted: a finished job is a set
    of files on disk, and the process that made them is the process that knows
    about them. Restarting the server means re-submitting, not rehydrating.
    """

    def __init__(self, outdir: str | Path = "jobs", engine: str = "whisper", preset: str = DEFAULT_PRESET):
        self.root = Path(outdir)
        self.default_engine = engine
        self.default_preset = preset
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._lock = threading.Lock()
        self._queue: queue.Queue[str] = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # -- lifecycle ---------------------------------------------------------- #

    def start(self) -> None:
        if self._worker is not None:
            return
        self._worker = threading.Thread(target=self._work, name="audio-studio-worker", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        self._queue.put("")  # wake the worker so it can notice the stop flag
        if self._worker is not None:
            self._worker.join(timeout=5)

    # -- store -------------------------------------------------------------- #

    def submit(self, payload: dict, *, job_id: Optional[str] = None, path: Optional[str] = None) -> Job:
        """Validate a request and queue it. ``path`` and ``job_id`` are for uploads."""
        source = path or payload.get("path")
        if not source or not isinstance(source, str):
            raise JobError("a 'path' to an audio or video file is required")
        if not Path(source).exists():
            raise JobError(f"no such file: {source}")

        engine = payload.get("engine") or self.default_engine
        if engine not in engine_names():
            raise JobError(f"unknown engine {engine!r}; expected one of {engine_names()}")

        preset = payload.get("preset") or self.default_preset
        if preset not in PRESETS:
            raise JobError(f"unknown preset {preset!r}; expected one of {sorted(PRESETS)}")

        align = payload.get("align") or None
        if align is not None and align not in aligner_names():
            raise JobError(f"unknown aligner {align!r}; expected one of {aligner_names()}")

        validate = payload.get("validate") or None
        if validate is not None and validate not in validator_names():
            raise JobError(f"unknown validator {validate!r}; expected one of {validator_names()}")

        selected = payload.get("emit") or list(DEFAULT_KINDS)
        if isinstance(selected, str):
            selected = [part.strip() for part in selected.split(",") if part.strip()]
        unknown = [k for k in selected if k not in kinds()]
        if unknown:
            raise JobError(f"unknown emit kind(s) {unknown}; expected one of {kinds()}")

        job = Job(
            id=job_id or uuid.uuid4().hex[:12],
            source=source,
            engine=engine,
            preset=preset,
            model=payload.get("model"),
            language=payload.get("language"),
            emit=list(selected),
            emphasis=payload.get("emphasis") or "none",
            word_level=bool(payload.get("wordLevel") or payload.get("word_level")),
            align=align,
            validate=validate,
            align_model=payload.get("alignModel"),
            llm_provider=payload.get("llmProvider"),
            llm_model=payload.get("llmModel"),
            stem=Path(source).stem,
        )
        job.outdir = self.root / job.id

        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)

        self.start()
        self._queue.put(job.id)
        return job

    def upload(
        self,
        filename: str,
        stream,
        length: int,
        payload: Optional[dict] = None,
    ) -> Job:
        """
        Take a source file off the wire and queue it.

        The file lands in the job's own directory, so a job is one folder and
        deleting the job's files is deleting one folder. The extension is checked
        against the media allow-list before a single byte is written: this is a
        loopback endpoint, not an invitation to use somebody's disk as scratch
        space.
        """
        payload = dict(payload or {})
        name = Path(str(filename or "upload")).name
        suffix = Path(name).suffix.lower()
        if suffix and suffix not in AUDIO_EXTENSIONS:
            raise JobError(f"{suffix} is not an audio or video extension we accept")
        if length <= 0:
            raise JobError("the upload is empty")
        if length > MAX_UPLOAD:
            raise JobError(f"the upload is larger than the {MAX_UPLOAD >> 20} MB limit")

        job_id = uuid.uuid4().hex[:12]
        directory = self.root / job_id
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"source{suffix or '.bin'}"

        written = 0
        remaining = length
        with open(target, "wb") as handle:
            while remaining > 0:
                block = stream.read(min(UPLOAD_CHUNK, remaining))
                if not block:
                    break
                handle.write(block)
                written += len(block)
                remaining -= len(block)
        if written != length:
            raise JobError(f"the upload was truncated: {written} of {length} bytes arrived")

        payload.pop("path", None)
        return self.submit(payload, job_id=job_id, path=str(target))

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return [self._jobs[jid] for jid in reversed(self._order)]

    def delete(self, job_id: str) -> bool:
        with self._lock:
            existed = self._jobs.pop(job_id, None) is not None
            if existed:
                self._order.remove(job_id)
            return existed

    # -- worker ------------------------------------------------------------- #

    def _work(self) -> None:
        while not self._stop.is_set():
            job_id = self._queue.get()
            if self._stop.is_set() or not job_id:
                continue
            job = self.get(job_id)
            if job is None:
                continue
            self._run(job)

    def _run(self, job: Job) -> None:
        job.status, job.started, job.error = "running", time.time(), None
        try:
            audio = load_audio(job.source)
            engine = get_engine(job.engine)
            usable, reason = engine.available()
            if not usable:
                raise RuntimeError(reason)

            options = options_from_preset(
                job.preset,
                model=job.model,
                language=job.language,
            )

            def on_progress(fraction: float, message: str) -> None:
                job.progress = fraction
                job.message = message

            # A pass the client asked for but that is not installed fails the job
            # with the reason, rather than quietly returning a transcript that was
            # never aligned. `PassUnavailable` is already a RuntimeError, so the
            # handler below catches it like any other failure.
            passes = PipelineOptions(
                align=job.align,
                align_options=AlignOptions(model=job.align_model or DEFAULT_ALIGN_MODEL),
                validate=job.validate,
                validate_options=ValidateOptions(
                    provider=job.llm_provider or "auto",
                    model=job.llm_model,
                ),
            )

            job.outdir.mkdir(parents=True, exist_ok=True)
            transcript = engine.transcribe(audio, options, on_progress)
            if passes.enabled():
                transcript = post_process(transcript, audio, passes, on_progress)
            write_bundle(
                transcript,
                job.outdir,
                stem=job.stem,
                kinds_selected=job.emit,
                word_level=job.word_level,
                emphasis=job.emphasis,
            )

            job.files = {kind: str(job.outdir / filename(kind, job.stem)) for kind in job.emit}
            job.summary = {
                "segments": len(transcript.segments),
                "words": transcript.word_count,
                "duration": round(transcript.duration, 3),
                "speechDuration": round(transcript.speech_duration, 3),
                "language": transcript.language,
                "warnings": list(transcript.warnings),
                "engine": transcript.engine,
                "alignment": transcript.alignment,
                "validation": transcript.validation,
                "corrections": len(transcript.corrections),
            }
            job.progress, job.message, job.status = 1.0, "done", "done"
        except Exception as exc:  # noqa: BLE001 - a failed job must not kill the worker
            job.error, job.status, job.message = str(exc), "error", "failed"
        finally:
            job.finished = time.time()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


def build_health_report() -> dict:
    """
    Probe every registry and describe what can actually run here.

    Expensive on a cold process, and *only* on a cold process: asking each backend
    whether it is available means importing its dependencies, and ``import torch``
    plus ``import transformers`` measured **6.3 s** on this machine. That is why
    this is computed once, off the request path, instead of per request.
    """
    return {
        "ok": True,
        "version": __version__,
        "engines": available_engines(),
        "aligners": available_aligners(),
        "validators": available_validators(),
        "presets": sorted(PRESETS),
        "defaultPreset": DEFAULT_PRESET,
        "emitKinds": kinds(),
    }


def health_report(*, refresh: bool = False) -> dict:
    """
    The cached health payload.

    Nothing it reports can change while the process runs — a package cannot be
    installed into a running interpreter — so computing it more than once buys
    nothing and costs seconds. Memoised under a lock, so two simultaneous first
    requests cannot both pay for it.
    """
    global _HEALTH
    with _HEALTH_LOCK:
        if _HEALTH is None or refresh:
            _HEALTH = build_health_report()
        return _HEALTH


def warm_health() -> None:
    """Pre-resolve the health report. Never raises: warming must not stop the server."""
    try:
        health_report()
    except Exception as exc:  # noqa: BLE001 - a failed warm-up is not a failed server
        print(f"[audio-studio] could not pre-load the backend probes: {exc}", file=sys.stderr)


def start_health_warmup() -> threading.Thread:
    """
    Resolve the health report in the background while the server starts.

    Without this the first ``GET /health`` costs ~6 s on a cold process, because
    answering it means importing torch and transformers. A browser waits four
    seconds and then hangs up — so the one request whose entire purpose is to say
    "I am here" was the one that failed, and it failed in a way that looked
    exactly like the server not running. Measured, not theorised: the client
    aborted, and the discarded response then surfaced as a ConnectionAbortedError
    traceback on the server's console.
    """
    thread = threading.Thread(target=warm_health, name="audio-studio-warmup", daemon=True)
    thread.start()
    return thread


def make_handler(store: Jobs):
    """Build a ``BaseHTTPRequestHandler`` bound to one job store."""

    class Handler(BaseHTTPRequestHandler):
        server_version = f"audio-studio/{__version__}"
        protocol_version = "HTTP/1.1"

        # -- plumbing ------------------------------------------------------- #

        def log_message(self, fmt: str, *args: Any) -> None:  # pragma: no cover
            # Default logs go to stderr; keep them but make them greppable.
            print(f"[audio-studio] {self.address_string()} {fmt % args}", file=sys.stderr)

        def _cors(self) -> None:
            # The caller is a browser app on a different port, so the browser
            # will preflight and then refuse the response without these.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _write(self, body: bytes) -> None:
            """
            Write the body, tolerating a caller that hung up first.

            A browser abandons a request when its own deadline passes or the page
            navigates away, so the socket can be gone before the response is
            ready. That is not a server fault, and letting it reach
            ``socketserver``'s default handler prints a 25-line traceback for it —
            which is what happened the one time this server was slow enough to be
            abandoned, and it read as a crash.
            """
            try:
                self.wfile.write(body)
            except ConnectionError:
                # BrokenPipeError, ConnectionResetError and ConnectionAbortedError
                # (WinError 10053) all land here: the caller is gone, not broken.
                self.close_connection = True

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            if self.command != "HEAD":
                self._write(body)

        def _json(self, status: int, payload: dict) -> None:
            self._send(status, json.dumps(payload, indent=2).encode("utf-8"), CONTENT_TYPES["json"])

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            if length > MAX_BODY:
                raise JobError("request body is too large")
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise JobError(f"body is not valid JSON: {exc}") from exc
            if not isinstance(data, dict):
                raise JobError("body must be a JSON object")
            return data

        # -- routes --------------------------------------------------------- #

        def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib naming
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            parts = [p for p in parsed.path.split("/") if p]

            if parsed.path == "/health" or parsed.path == "/":
                return self._json(200, health_report())

            if parsed.path == "/jobs":
                return self._json(200, {"jobs": [job.to_dict() for job in store.list()]})

            if len(parts) == 2 and parts[0] == "jobs":
                job = store.get(parts[1])
                if job is None:
                    return self._json(404, {"error": f"no such job: {parts[1]}"})
                return self._json(200, job.to_dict())

            if len(parts) == 3 and parts[0] == "jobs":
                return self._artifact(parts[1], parts[2], parse_qs(parsed.query))

            return self._json(404, {"error": f"no route for {parsed.path}"})

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/transcribe/upload":
                return self._upload(parse_qs(parsed.query))
            if parsed.path != "/transcribe":
                return self._json(404, {"error": f"no route for {parsed.path}"})
            try:
                payload = self._read_json()
                job = store.submit(payload)
            except JobError as exc:
                return self._json(400, {"error": str(exc)})
            return self._json(202, job.to_dict())

        def _upload(self, query: dict) -> None:
            """
            A source file in the body, with its options in the query string.

            The body is the media, so it cannot also be the request JSON — hence
            ``?name=song.mp3&preset=balanced&align=wav2vec`` rather than a multipart
            form. The options are the same names ``POST /transcribe`` uses, and the
            same validator accepts them, so there is one place a job is defined.
            """
            length = int(self.headers.get("Content-Length") or 0)
            name = (query.get("name") or ["upload"])[0]
            payload = {key: _coerce(values[0]) for key, values in query.items() if key != "name" and values}
            try:
                job = store.upload(name, self.rfile, length, payload)
            except JobError as exc:
                return self._json(400, {"error": str(exc)})
            return self._json(202, job.to_dict())

        def do_DELETE(self) -> None:  # noqa: N802
            parts = [p for p in urlparse(self.path).path.split("/") if p]
            if len(parts) == 2 and parts[0] == "jobs":
                if store.delete(parts[1]):
                    return self._json(200, {"deleted": parts[1]})
                return self._json(404, {"error": f"no such job: {parts[1]}"})
            return self._json(404, {"error": f"no route for {urlparse(self.path).path}"})

        # -- helpers -------------------------------------------------------- #

        def _artifact(self, job_id: str, kind: str, query: dict) -> None:
            job = store.get(job_id)
            if job is None:
                return self._json(404, {"error": f"no such job: {job_id}"})
            if kind not in kinds():
                return self._json(404, {"error": f"unknown artifact kind {kind!r}; expected one of {kinds()}"})
            if job.status == "error":
                return self._json(409, {"error": job.error or "job failed"})
            if job.status != "done":
                return self._json(409, {"error": f"job is {job.status}", "progress": round(job.progress, 4)})

            path = Path(job.files.get(kind, job.outdir / filename(kind, job.stem)))
            if not path.exists():
                return self._json(404, {"error": f"this job did not emit {kind!r}; it emitted {sorted(job.files)}"})

            if query.get("download"):
                self.send_response(200)
                self.send_header("Content-Type", CONTENT_TYPES.get(kind, "application/octet-stream"))
                self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
                body = path.read_bytes()
                self.send_header("Content-Length", str(len(body)))
                self._cors()
                self.end_headers()
                self._write(body)
                return None

            return self._send(200, path.read_bytes(), CONTENT_TYPES.get(kind, "application/octet-stream"))

    return Handler


def _coerce(value: str):
    """Query strings carry text; turn the two obvious booleans back into booleans."""
    lowered = value.strip().lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    return value


def create_server(
    store: Jobs,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
) -> ThreadingHTTPServer:
    """Build (but do not start) the HTTP server, so tests can bind port 0."""
    httpd = ThreadingHTTPServer((host, port), make_handler(store))
    httpd.daemon_threads = True
    return httpd


def serve(args) -> int:
    """Run until interrupted. ``args`` is the parsed ``serve`` subcommand."""
    store = Jobs(outdir=args.out, engine=args.engine, preset=args.preset)
    store.start()
    # Before anything asks: resolving which backends are installed means importing
    # their dependencies, which is seconds, so it must not happen on the first
    # request's clock.
    start_health_warmup()

    httpd = create_server(store, args.host, args.port)
    host, port = httpd.server_address[:2]
    shown = args.host if host in ("0.0.0.0", "127.0.0.1") else host

    print(f"audio-studio {__version__} serving on http://{shown}:{port}", file=sys.stderr)
    print(f"  engine {args.engine}, preset {args.preset}, jobs in {Path(args.out)}", file=sys.stderr)
    print("  POST /transcribe {path, ...}   GET /jobs/{id}   GET /health", file=sys.stderr)
    print("  probing installed backends in the background (a few seconds)", file=sys.stderr)
    print("  Ctrl-C to stop", file=sys.stderr)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - interactive
        print("\naudio-studio: stopping", file=sys.stderr)
    finally:
        httpd.shutdown()
        httpd.server_close()
        store.stop()
    return 0


__all__ = [
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "Job",
    "JobError",
    "Jobs",
    "build_health_report",
    "create_server",
    "health_report",
    "make_handler",
    "serve",
    "start_health_warmup",
    "warm_health",
]
