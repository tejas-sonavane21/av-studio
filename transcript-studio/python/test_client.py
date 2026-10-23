"""The Python client, against a stand-in for the local studio.

No Chrome, no network, no transcript-studio process: the API this client speaks is
four routes, so the stub is four routes. That is the same reason the Node server's
own tests inject a fake provider.
"""

from __future__ import annotations

import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from transcript_studio import Client, TranscriptStudioError

FILES = {
    "json": '{"schemaVersion":1}',
    "srt": "1\n00:00:00,480 --> 00:00:02,000\nJust an ordinary boy\n\n",
}

STATE = {"fail": False}


class StubStudio(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _text(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True, "version": "0.1.0", "provider": "aifreeforever"})
        if path == "/jobs/job1":
            if STATE["fail"]:
                return self._json(
                    200,
                    {
                        "id": "job1",
                        "status": "error",
                        "error": "the site security check did not clear",
                        "hint": "it needs a real, visible Chrome",
                    },
                )
            return self._json(
                200,
                {
                    "id": "job1",
                    "status": "done",
                    "phase": "done",
                    "detail": "",
                    "progress": 1,
                    "summary": {"chunks": 1, "words": 4, "duration": 2.0, "warnings": []},
                    "files": [
                        {"kind": "json", "label": "transcript JSON", "filename": "song.transcript.json"},
                        {"kind": "srt", "label": "SubRip", "filename": "song.srt"},
                    ],
                },
            )
        if path.startswith("/jobs/job1/files/"):
            kind = path.rsplit("/", 1)[-1]
            return self._text(200, FILES[kind].encode())
        return self._json(404, {"error": f"no route for {path}"})

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            return self._json(404, {"error": "nope"})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        query = parse_qs(parsed.query)
        STATE["last"] = {
            "name": query.get("name", [""])[0],
            "language": query.get("language", [""])[0],
            "emit": query.get("emit", [""])[0],
            "bytes": len(body),
        }
        if STATE.get("reject"):
            return self._json(400, {"error": '"song.ogg" is not an MP3, WAV or FLAC file', "hint": "MP3, WAV or FLAC only"})
        return self._json(202, {"jobId": "job1", "id": "job1", "status": "queued"})


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), StubStudio)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        STATE.clear()
        STATE["fail"] = False
        self.client = Client(self.url)

    def audio(self, name="song.mp3", body=b"not really an mp3"):
        directory = tempfile.mkdtemp(prefix="transcript-studio-py-")
        path = Path(directory) / name
        path.write_bytes(body)
        return path

    def test_health_is_the_server_s_own_answer(self):
        health = self.client.health()
        self.assertTrue(health["ok"])
        self.assertEqual(health["provider"], "aifreeforever")

    def test_transcribe_uploads_the_file_with_its_own_name(self):
        path = self.audio(body=b"1234567890")
        job = self.client.transcribe(path, language="en", emit=["json", "srt"])
        self.assertEqual(job["jobId"], "job1")
        self.assertEqual(STATE["last"], {"name": "song.mp3", "language": "en", "emit": "json,srt", "bytes": 10})

    def test_transcribe_to_writes_every_artifact(self):
        path = self.audio()
        with tempfile.TemporaryDirectory() as out:
            job = self.client.transcribe_to(path, out_dir=out)
            written = {entry["kind"]: Path(entry["path"]) for entry in job["written"]}
            self.assertEqual(set(written), {"json", "srt"})
            self.assertEqual(written["srt"].read_text(encoding="utf-8"), FILES["srt"])
            self.assertEqual(written["srt"].parent, Path(out))

    def test_a_failed_job_raises_with_the_job_s_hint(self):
        STATE["fail"] = True
        path = self.audio()
        with self.assertRaises(TranscriptStudioError) as caught:
            self.client.transcribe_to(path, out_dir=tempfile.mkdtemp())
        self.assertIn("security check", str(caught.exception))
        self.assertIn("visible Chrome", str(caught.exception))

    def test_a_refused_upload_keeps_the_server_s_wording(self):
        STATE["reject"] = True
        try:
            with self.assertRaises(TranscriptStudioError) as caught:
                self.client.transcribe(self.audio(name="song.ogg"))
            self.assertIn("MP3, WAV or FLAC", str(caught.exception))
        finally:
            STATE.pop("reject", None)

    def test_a_missing_file_is_caught_before_uploading(self):
        with self.assertRaises(TranscriptStudioError) as caught:
            self.client.transcribe("definitely-missing.mp3")
        self.assertIn("no such audio file", str(caught.exception))

    def test_a_server_that_is_not_running_says_how_to_start_it(self):
        client = Client("http://127.0.0.1:9", timeout=2)
        with self.assertRaises(TranscriptStudioError) as caught:
            client.health()
        self.assertIn("npm start", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
