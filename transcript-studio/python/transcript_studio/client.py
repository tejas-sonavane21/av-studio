"""
transcript_studio.client — the local studio, from Python.

Why this talks to `127.0.0.1` and not to aifreeforever.com
----------------------------------------------------------

Because the site's endpoint cannot be called by an HTTP library. It is behind a
Cloudflare managed challenge and it requires a `x-turnstile-token` header that
only a browser holding that challenge can produce. That is not a guess; it is
measured:

    requests, full Chrome header set      GET  page -> 403  cf-mitigated: challenge
    curl_cffi, impersonate="chrome"       GET  page -> 403  cf-mitigated: challenge
    curl_cffi, impersonate="firefox"      GET  page -> 403  cf-mitigated: challenge

The 403 is Cloudflare's challenge page, not the tool's HTML. No amount of
headers or TLS impersonation gets past it, and the remaining options - solving
the site's CAPTCHA for it, or reaching the origin behind Cloudflare - are not
things this project does.

So the browser stays in exactly one place: the local `transcript-studio` server,
which drives the page the way a person would. **This module is the programmatic
interface to that server** and depends only on `requests`. From Python's side
there is no Chrome, no window and no automation: one HTTP call in, files out.

Start the server first (it launches Chrome itself, once):

    cd transcript-studio
    npm start                      # http://127.0.0.1:8757
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

import requests

DEFAULT_URL = os.environ.get("TRANSCRIPT_STUDIO_URL", "http://127.0.0.1:8757")
DEFAULT_TIMEOUT = 900.0

ProgressHook = Callable[[dict], None]


class TranscriptStudioError(RuntimeError):
    """Anything this client could not do, with a hint when there is one."""

    def __init__(self, message: str, *, hint: str = "", status: int = 0) -> None:
        super().__init__(message)
        self.hint = hint
        self.status = status

    def __str__(self) -> str:
        return f"{super().__str__()} - {self.hint}" if self.hint else super().__str__()


class Client:
    """A thin, explicit client for the local studio's HTTP API."""

    def __init__(self, base_url: str = DEFAULT_URL, *, session: Optional[requests.Session] = None, timeout: float = 30.0) -> None:
        self.base_url = str(base_url).rstrip("/")
        self.session = session or requests.Session()
        self.timeout = timeout

    # -- plumbing --------------------------------------------------------- #

    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = f"{self.base_url}{path}"
        try:
            response = self.session.request(method, url, timeout=self.timeout, **kwargs)
        except requests.exceptions.ConnectionError as exc:
            raise TranscriptStudioError(
                f"cannot reach transcript-studio at {self.base_url}",
                hint="start it with:  cd transcript-studio && npm start   (or: node src/server.js)",
            ) from exc
        except requests.exceptions.Timeout as exc:
            raise TranscriptStudioError(
                f"transcript-studio at {self.base_url} did not answer in {self.timeout:.0f}s",
                hint="it may be busy with a job; the studio handles one at a time",
            ) from exc
        if response.status_code >= 400:
            try:
                detail = response.json()
            except ValueError:
                detail = {}
            raise TranscriptStudioError(
                detail.get("error") or f"the server answered {response.status_code}",
                hint=detail.get("hint") or "",
                status=response.status_code,
            )
        return response

    # -- API -------------------------------------------------------------- #

    def health(self) -> dict:
        """What the studio is, and the limits it will enforce for us."""
        return self._request("GET", "/health").json()

    def transcribe(
        self,
        audio: "str | Path",
        *,
        language: str = "auto",
        emit: "Iterable[str] | str | None" = None,
        stem: Optional[str] = None,
    ) -> dict:
        """
        Upload a file and return the created job.

        Returns as soon as the server has the bytes; the transcription itself is
        `wait()`. Split deliberately - a caller that wants to poll with its own
        UI can, and one that does not can use `transcribe_to()`.
        """
        path = Path(audio)
        if not path.is_file():
            raise TranscriptStudioError(f"no such audio file: {path}", hint="it must be an MP3, WAV or FLAC")
        params: dict[str, str] = {"name": path.name, "language": language}
        if emit is not None:
            params["emit"] = ",".join(emit) if not isinstance(emit, str) else emit
        if stem:
            params["stem"] = stem

        try:
            response = self.session.post(
                f"{self.base_url}/transcribe",
                params=params,
                data=path.read_bytes(),
                headers={"Content-Type": "application/octet-stream"},
                timeout=max(self.timeout, 120.0),
            )
        except requests.exceptions.ConnectionError as exc:
            raise TranscriptStudioError(
                f"cannot reach transcript-studio at {self.base_url}",
                hint="start it with:  cd transcript-studio && npm start",
            ) from exc
        if response.status_code >= 400:
            try:
                detail = response.json()
            except ValueError:
                detail = {}
            raise TranscriptStudioError(
                detail.get("error") or f"the server answered {response.status_code}",
                hint=detail.get("hint") or "",
                status=response.status_code,
            )
        return response.json()

    def job(self, job_id: str) -> dict:
        return self._request("GET", f"/jobs/{job_id}").json()

    def wait(
        self,
        job_id: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        interval: float = 0.7,
        on_progress: Optional[ProgressHook] = None,
    ) -> dict:
        """Poll until the job is done, or raise with the job's own error and hint."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            job = self.job(job_id)
            if on_progress and (job.get("phase"), job.get("detail")) != last:
                last = (job.get("phase"), job.get("detail"))
                on_progress(job)
            if job.get("status") == "done":
                return job
            if job.get("status") == "error":
                raise TranscriptStudioError(job.get("error") or "the job failed", hint=job.get("hint") or "")
            time.sleep(interval)
        raise TranscriptStudioError(
            f"job {job_id} did not finish in {timeout:.0f}s",
            hint="the free site's queue can be slow; check the Chrome window or raise --timeout",
        )

    def download(self, job_id: str, kind: str) -> bytes:
        return self._request("GET", f"/jobs/{job_id}/files/{kind}").content

    def transcribe_to(
        self,
        audio: "str | Path",
        *,
        out_dir: "str | Path" = "out",
        language: str = "auto",
        emit: "Iterable[str] | str | None" = None,
        stem: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        on_progress: Optional[ProgressHook] = None,
    ) -> dict:
        """
        The whole job: upload, wait, write every artifact to `out_dir`.

        Returns the finished job plus `written`, a list of `{kind, path}`.
        """
        job = self.transcribe(audio, language=language, emit=emit, stem=stem)
        finished = self.wait(job["jobId"], timeout=timeout, on_progress=on_progress)
        target = Path(out_dir)
        target.mkdir(parents=True, exist_ok=True)
        written = []
        for entry in finished.get("files", []):
            body = self.download(finished["id"], entry["kind"])
            path = target / entry["filename"]
            path.write_bytes(body)
            written.append({"kind": entry["kind"], "path": str(path)})
        finished["written"] = written
        return finished


def format_progress(job: dict) -> str:
    phase = job.get("phase") or "working"
    detail = job.get("detail") or ""
    percent = int(round(float(job.get("progress") or 0) * 100))
    return f"  {phase}: {detail}".rstrip(": ") + f"  [{percent}%]" if detail else f"  {phase}  [{percent}%]"


def main(argv: Optional[list] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m transcript_studio",
        description="Transcribe a song through the local transcript-studio server (which drives the free site).",
    )
    parser.add_argument("audio", help="MP3, WAV or FLAC, 1 s to 5 min, at most 25 MB")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"local studio URL (default: {DEFAULT_URL})")
    parser.add_argument("--out", default="out", help="where the artifacts go (default: out)")
    parser.add_argument("--language", default="auto", help="a code from the site's list (default: auto)")
    parser.add_argument("--emit", default=None, help="comma list: json,srt,vtt,txt,speech,veed")
    parser.add_argument("--stem", default=None, help="file-name stem (default: the audio's own)")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="seconds to wait for the job")
    parser.add_argument("--json", action="store_true", help="machine-readable summary on stdout")
    parser.add_argument("--quiet", "-q", action="store_true", help="no progress output")
    args = parser.parse_args(argv)

    quiet = args.quiet or args.json
    client = Client(args.url)
    try:
        health = client.health()
    except TranscriptStudioError as exc:
        print(f"transcript-studio: {exc}", file=sys.stderr)
        return 1

    if not quiet:
        print(f"transcript-studio {health.get('version')} at {args.url} ({health.get('provider')})")

    def progress(job: dict) -> None:
        if not quiet:
            print(format_progress(job), file=sys.stderr)

    try:
        job = client.transcribe_to(
            args.audio,
            out_dir=args.out,
            language=args.language,
            emit=args.emit,
            stem=args.stem,
            timeout=args.timeout,
            on_progress=progress,
        )
    except TranscriptStudioError as exc:
        print(f"transcript-studio: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({"ok": True, "job": job["id"], "summary": job.get("summary"), "files": job["written"]}, indent=2))
        return 0

    for entry in job["written"]:
        print(entry["path"])
    return 0


__all__ = ["Client", "TranscriptStudioError", "DEFAULT_URL", "format_progress", "main"]
