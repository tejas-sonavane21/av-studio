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
    assert "balanced" in body["presets"]
    assert set(body["emitKinds"]) == {"json", "veed", "srt", "vtt"}


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
