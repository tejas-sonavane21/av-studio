"""server.py — the local HTTP surface caption-studio calls, over loopback only.

These run the real server on an ephemeral port with the deterministic ``fake``
engine, so the whole request→job→artifact path is exercised without a model.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from audio_studio import __version__
from audio_studio.server import Jobs, create_server


def request(url: str, method: str = "GET", payload: dict | None = None) -> tuple[int, dict | str]:
    """Call the server and return (status, parsed-json-or-text). Never raises on 4xx."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        status = exc.code
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, body


@pytest.fixture()
def server(tmp_path):
    store = Jobs(outdir=tmp_path / "jobs", engine="fake")
    httpd = create_server(store, "127.0.0.1", 0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        yield base, store
    finally:
        httpd.shutdown()
        httpd.server_close()
        store.stop()
        thread.join(timeout=5)


def wait_for(base: str, job_id: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, job = request(f"{base}/jobs/{job_id}")
        assert isinstance(job, dict)
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish within {timeout}s")


# --------------------------------------------------------------------------- #
# health and routing
# --------------------------------------------------------------------------- #


def test_health_reports_version_and_usable_engines(server):
    base, _ = server
    status, body = request(f"{base}/health")
    assert status == 200
    assert body["ok"] is True
    assert body["version"] == __version__
    assert {e["name"] for e in body["engines"]} == {"fake", "whisper"}
    assert {a["name"] for a in body["aligners"]} == {"fake", "w2v-bert", "wav2vec"}
    assert {v["name"] for v in body["validators"]} == {"rules", "llm"}
    assert "balanced" in body["presets"]
    assert set(body["emitKinds"]) == {"json", "veed", "srt", "vtt"}


# --------------------------------------------------------------------------- #
# the health probe: expensive once, and never on a request's clock
# --------------------------------------------------------------------------- #


def test_health_is_memoised_so_the_registries_are_probed_at_most_once(monkeypatch):
    """
    Answering /health means asking each backend whether it is installed, which means
    importing its dependencies — and on this machine a cold ``import torch`` plus
    ``import transformers`` measured **6.3 s**, against a browser that gives up at 4.
    So it is resolved once and reused, not rebuilt per request.
    """
    from audio_studio import server as server_module

    calls: list[int] = []
    real = server_module.build_health_report

    def counted():
        calls.append(1)
        return real()

    monkeypatch.setattr(server_module, "build_health_report", counted)
    monkeypatch.setattr(server_module, "_HEALTH", None)

    first = server_module.health_report()
    second = server_module.health_report()

    assert len(calls) == 1
    assert first is second, "the cached payload should be returned, not rebuilt"
    assert first["ok"] is True


def test_a_health_request_never_probes_the_registries_itself(monkeypatch, server):
    """However cold the process is, the route must not be able to do the slow thing."""
    from audio_studio import server as server_module

    base, _ = server
    status, warm = request(f"{base}/health")
    assert status == 200

    def explode():
        raise AssertionError("a request must never probe the registries")

    monkeypatch.setattr(server_module, "build_health_report", explode)
    status, again = request(f"{base}/health")
    assert status == 200
    assert again == warm


def test_starting_the_server_warms_the_probe_in_the_background(monkeypatch):
    from audio_studio import server as server_module

    monkeypatch.setattr(server_module, "_HEALTH", None)
    thread = server_module.start_health_warmup()
    thread.join(timeout=30)

    assert not thread.is_alive()
    assert server_module._HEALTH is not None


def test_a_failed_warmup_leaves_the_server_working(monkeypatch):
    """A probe that explodes must not take the process down, and must not cache a lie."""
    from audio_studio import server as server_module

    def explode():
        raise RuntimeError("torch is having a bad day")

    monkeypatch.setattr(server_module, "_HEALTH", None)
    monkeypatch.setattr(server_module, "build_health_report", explode)

    server_module.warm_health()  # must not raise
    assert server_module._HEALTH is None


# --------------------------------------------------------------------------- #
# a caller that hangs up is not a fault
# --------------------------------------------------------------------------- #


class _DeadSocket:
    """A socket whose peer has gone: every write fails the way Windows reports it."""

    def write(self, body: bytes) -> None:
        raise ConnectionAbortedError("[WinError 10053] An established connection was aborted")


class _BrokenDisk:
    """A *real* problem, which must still be loud."""

    def write(self, body: bytes) -> None:
        raise OSError(28, "No space left on device")


def test_a_client_that_hangs_up_is_swallowed_and_anything_else_is_not():
    """
    A browser abandons a request when its deadline passes, so the socket can be gone
    before the response is ready. Letting that reach ``socketserver``'s default
    handler prints a 25-line traceback for it — which is what happened the one time
    this server was slow enough to be abandoned, and it read as a crash.

    Only a disconnect is tolerated. Anything else still propagates, so this cannot
    become a place where real faults go to die.
    """
    from audio_studio.server import Jobs, make_handler

    instance = object.__new__(make_handler(Jobs(outdir="unused")))  # no socket, no request

    instance.wfile = _DeadSocket()
    instance.close_connection = False
    instance._write(b"a response nobody is waiting for")
    assert instance.close_connection is True, "the handler should stop trying to reuse it"

    instance.wfile = _BrokenDisk()
    with pytest.raises(OSError):
        instance._write(b"a response that genuinely could not be sent")


def test_an_abandoned_request_leaves_the_server_serving(server):
    """
    Hold the probe lock so the answer is withheld, tear the connection down with an
    RST, then let the handler try to write into the void. The next request must be
    unaffected — and the one already made must not have crashed anything.
    """
    import socket as socketlib
    import struct

    from audio_studio import server as server_module

    base, _ = server
    request(f"{base}/health")  # warm, so the payload is cached
    port = int(base.rsplit(":", 1)[1])

    with server_module._HEALTH_LOCK:
        sock = socketlib.create_connection(("127.0.0.1", port), timeout=5)
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        sock.setsockopt(socketlib.SOL_SOCKET, socketlib.SO_LINGER, struct.pack("ii", 1, 0))
        sock.close()  # abortive close: an RST, not a polite FIN

    time.sleep(0.3)  # let the blocked handler reach its write and find out
    assert request(f"{base}/health")[0] == 200


# --------------------------------------------------------------------------- #
# uploading the file itself
# --------------------------------------------------------------------------- #


def upload(url: str, name: str, data: bytes) -> tuple[int, dict | str]:
    """POST a file's bytes as the body, with the options in the query string."""
    req = urllib.request.Request(f"{url}?name={name}", data=data, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body, status = response.read().decode("utf-8"), response.status
    except urllib.error.HTTPError as exc:
        body, status = exc.read().decode("utf-8"), exc.code
    try:
        return status, json.loads(body)
    except json.JSONDecodeError:
        return status, body


def test_the_browser_can_send_the_file_instead_of_a_path(server, wav_file):
    """
    A page cannot read a path off the user's disk, so the endpoint that takes the
    bytes is the one caption-studio can actually use.
    """
    base, store = server
    status, job = upload(f"{base}/transcribe/upload", "clip.wav", wav_file.read_bytes())
    assert status == 202
    job_id = job["jobId"]
    done = wait_for(base, job_id)
    assert done["status"] == "done", done.get("error")
    assert done["summary"]["words"] > 0
    # the uploaded file lives inside the job's own directory
    assert (store.root / job_id / "source.wav").exists()
    assert done["source"].endswith("source.wav")


def test_upload_options_ride_in_the_query_string(server, wav_file):
    base, _ = server
    req = urllib.request.Request(
        f"{base}/transcribe/upload?name=clip.wav&preset=fast&align=fake&emit=veed",
        data=wav_file.read_bytes(),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        job = json.loads(response.read().decode("utf-8"))
    done = wait_for(base, job["jobId"])
    assert done["status"] == "done", done.get("error")
    assert done["preset"] == "fast"
    assert done["align"] == "fake"
    assert set(done["files"]) == {"veed"}


def test_an_upload_of_a_file_type_we_do_not_read_is_refused(server):
    base, _ = server
    status, body = upload(f"{base}/transcribe/upload", "payload.exe", b"MZ" + b"\x00" * 64)
    assert status == 400
    assert ".exe" in body["error"]


def test_an_empty_upload_is_refused(server):
    base, _ = server
    status, body = upload(f"{base}/transcribe/upload", "clip.wav", b"")
    assert status == 400
    assert "empty" in body["error"]


def test_the_root_and_health_are_the_same_thing(server):
    base, _ = server
    assert request(f"{base}/")[0] == 200


def test_an_unknown_route_is_404(server):
    base, _ = server
    status, body = request(f"{base}/nope")
    assert status == 404
    assert "no route" in body["error"]


def test_preflight_advertises_cors(server):
    """caption-studio is a different origin, so the browser preflights."""
    base, _ = server
    req = urllib.request.Request(f"{base}/transcribe", method="OPTIONS")
    with urllib.request.urlopen(req, timeout=10) as response:
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == "*"
        assert "POST" in response.headers["Access-Control-Allow-Methods"]


# --------------------------------------------------------------------------- #
# the job lifecycle
# --------------------------------------------------------------------------- #


def test_a_job_runs_end_to_end_and_serves_its_artifact(server, wav_file):
    base, store = server
    status, job = request(f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake"})
    assert status == 202
    job_id = job["jobId"]

    done = wait_for(base, job_id)
    assert done["status"] == "done", done.get("error")
    assert done["summary"]["words"] > 0
    assert set(done["urls"]) == {"json", "veed", "srt", "vtt"}
    assert (store.root / job_id / "clip.speech.json").exists()

    status, veed = request(f"{base}/jobs/{job_id}/veed")
    assert status == 200
    assert veed["canvas"] and veed["subtitles"]
    assert veed["subtitles"][0]["words"][0]["text"]

    status, srt = request(f"{base}/jobs/{job_id}/srt")
    assert status == 200
    assert "-->" in srt


def test_the_job_list_is_newest_first(server, wav_file):
    base, _ = server
    first = request(f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake"})[1]["jobId"]
    second = request(f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake"})[1]["jobId"]
    wait_for(base, first)
    wait_for(base, second)

    _, body = request(f"{base}/jobs")
    ids = [job["jobId"] for job in body["jobs"]]
    assert ids.index(second) < ids.index(first)


def test_a_job_can_ask_for_the_optional_passes(server, wav_file):
    """The alignment and validation passes are per-job, and the artifact says so."""
    base, _ = server
    status, job = request(
        f"{base}/transcribe",
        "POST",
        {"path": str(wav_file), "engine": "fake", "align": "fake", "validate": "rules"},
    )
    assert status == 202
    assert job["align"] == "fake"
    done = wait_for(base, job["jobId"])
    assert done["status"] == "done", done.get("error")
    assert done["summary"]["alignment"]["aligner"] == "fake"
    assert done["summary"]["validation"]["passes"][0]["validator"] == "rules"


def test_the_lyrics_can_be_posted_with_the_job(server, wav_file):
    """
    The browser route: caption-studio reads the user's lyric file and posts its text,
    because a page cannot read a path off the user's disk. The job must record which
    file it was and what the pass did with it.
    """
    base, _ = server
    lyrics = "We rise before the morning light,\nAnd carry every promise that we made along the long way home,\nThe road taught us how to wait\nforever\n"
    status, job = request(
        f"{base}/transcribe",
        "POST",
        {
            "path": str(wav_file),
            "engine": "fake",
            "referenceText": lyrics,
            "referenceName": "spidy.srt",
        },
    )
    assert status == 202
    assert job["reference"] == {"name": "spidy.srt", "minMatch": 0.5}

    done = wait_for(base, job["jobId"])
    assert done["status"] == "done", done.get("error")
    reference = done["summary"]["reference"]
    assert reference["outcome"] == "applied"
    assert reference["counts"]["inserted"] == 1
    assert done["summary"]["words"] == 6 + 13 + 6 + 1


def test_the_match_floor_is_the_client_s_decision(server, wav_file):
    """
    The same unrelated lyric file, twice: refused at the default floor and applied
    when the client lowers it to zero. The floor is the one thing standing between a
    wrong file and a rewritten transcript, so both sides of it are worth pinning.
    """
    base, _ = server
    for floor, outcome, words in ((None, "refused", 25), (0.0, "applied", 3)):
        payload = {
            "path": str(wav_file),
            "engine": "fake",
            "referenceText": "kangaroo wallaby wombat",
        }
        if floor is not None:
            payload["referenceMinMatch"] = floor
        status, job = request(f"{base}/transcribe", "POST", payload)
        assert status == 202
        if floor is not None:
            assert job["reference"]["minMatch"] == floor

        done = wait_for(base, job["jobId"])
        assert done["status"] == "done", done.get("error")
        assert done["summary"]["reference"]["outcome"] == outcome
        assert done["summary"]["words"] == words


def test_a_job_without_lyrics_carries_no_reference_block(server, wav_file):
    base, _ = server
    _, job = request(f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake"})
    assert job.get("reference") is None
    done = wait_for(base, job["jobId"])
    assert done["summary"]["reference"] is None


def test_an_unknown_aligner_or_validator_is_refused_by_name(server, wav_file):
    base, _ = server
    status, body = request(
        f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake", "align": "nope"}
    )
    assert status == 400
    assert "nope" in body["error"]

    status, body = request(
        f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake", "validate": "nope"}
    )
    assert status == 400
    assert "nope" in body["error"]


def test_a_pass_that_cannot_run_fails_the_job_with_the_reason(server, wav_file, monkeypatch):
    """A missing backend must not quietly return a transcript that was never aligned."""
    from audio_studio import server as server_module
    from audio_studio.pipeline import PassUnavailable

    def refuse(*args, **kwargs):
        raise PassUnavailable("the aligner is not installed")

    monkeypatch.setattr(server_module, "post_process", refuse)
    base, _ = server
    job_id = request(
        f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake", "align": "fake"}
    )[1]["jobId"]
    done = wait_for(base, job_id)
    assert done["status"] == "error"
    assert "not installed" in done["error"]


def test_a_finished_job_can_be_deleted(server, wav_file):
    base, _ = server
    job_id = request(f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake"})[1]["jobId"]
    wait_for(base, job_id)

    assert request(f"{base}/jobs/{job_id}", "DELETE")[0] == 200
    assert request(f"{base}/jobs/{job_id}")[0] == 404


# --------------------------------------------------------------------------- #
# rejections
# --------------------------------------------------------------------------- #


def test_a_missing_file_is_rejected_before_a_job_exists(server, tmp_path):
    base, store = server
    status, body = request(f"{base}/transcribe", "POST", {"path": str(tmp_path / "nope.mp3")})
    assert status == 400
    assert "no such file" in body["error"]
    assert store.list() == []


@pytest.mark.parametrize(
    "payload, fragment",
    [
        ({}, "required"),
        ({"path": "x.mp3", "engine": "nope"}, "unknown engine"),
        ({"path": "x.mp3", "preset": "nope"}, "unknown preset"),
        # A lyric file that cannot be read is rejected at submit time, not minutes
        # later by a job that has already transcribed the audio.
        ({"path": "x.mp3", "reference": "no/such/lyrics.srt"}, "could not read"),
        ({"path": "x.mp3", "referenceText": "   \n \n"}, "contains no words"),
        ({"path": "x.mp3", "reference": "a.srt", "referenceText": "hi"}, "not both"),
        ({"path": "x.mp3", "referenceText": "hi", "referenceMinMatch": "nope"}, "between 0 and 1"),
        ({"path": "x.mp3", "referenceText": "hi", "referenceMinMatch": 2}, "between 0 and 1"),
        ({"path": "x.mp3", "reference": [1, 2]}, "must be a path"),
    ],
)
def test_bad_requests_are_400(server, tmp_path, payload, fragment):
    base, _ = server
    if payload.get("path") == "x.mp3":
        payload = {**payload, "path": str(tmp_path / "x.mp3")}
        (tmp_path / "x.mp3").write_bytes(b"")
    status, body = request(f"{base}/transcribe", "POST", payload)
    assert status == 400
    assert fragment in body["error"]


def test_an_artifact_before_the_job_finishes_is_409(server, wav_file):
    """A job still in the queue must say 'not ready', not 'no such file'."""
    base, store = server
    store.start = lambda: None  # type: ignore[assignment]  # freeze the worker
    status, job = request(f"{base}/transcribe", "POST", {"path": str(wav_file), "engine": "fake"})
    assert status == 202
    assert store.get(job["jobId"]).status == "queued"

    status, body = request(f"{base}/jobs/{job['jobId']}/srt")
    assert status == 409
    assert "queued" in body["error"]
