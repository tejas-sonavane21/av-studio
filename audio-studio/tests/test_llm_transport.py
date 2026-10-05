"""
validate/llm.py — the real request, over real HTTP, against a local stand-in.

The stubbed tests in ``test_validate.py`` cover what this studio *decides*: how it
batches, how it shifts indices, how it reads a reply, what the ledger does with a
proposal. What they cannot cover is the part between the decision and the network:
whether the SDK actually accepts the config we hand it, whether the reply arrives
where we look for it, and whether a real HTTP failure lands on the fallback path
instead of escaping as a traceback.

So this starts an HTTP server that speaks the provider's response shape, and points
the pass at it with ``extra={"base_url": ...}``. Google's own capacity is not part
of the test — which matters, because when this was written the entire free tier was
answering 503 to everything.

Skipped, not failed, when the ``[llm]`` extra is absent: the base install must still
run the whole suite.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytest.importorskip("google.genai", reason="needs the [llm] extra")

from audio_studio.config import DEFAULT_LLM_MODELS, ValidateOptions  # noqa: E402
from audio_studio.model import Segment, Transcript, Word  # noqa: E402
from audio_studio.validate import validate_transcript  # noqa: E402
from audio_studio.validate.llm import (  # noqa: E402
    LLM_MODEL_FALLBACKS,
    QuotaError,
    quota_error,
    resolve_provider,
)


def build(lines) -> Transcript:
    segments, cursor = [], 0.0
    for tokens in lines:
        words = []
        for token in tokens:
            words.append(Word(text=token, start=round(cursor, 3), end=round(cursor + 0.4, 3), probability=0.9))
            cursor += 0.4
        segments.append(Segment(start=words[0].start, end=words[-1].end, words=words))
        cursor += 0.5
    return Transcript.from_segments(segments, language="en", duration=round(cursor + 1.0, 3))


class StandIn:
    """
    A provider's wire shape, without the provider.

    It answers with whatever ``replies`` yields, one per request, so a test can
    script "the first call fails with 503, the second succeeds" and watch what the
    studio does about it.
    """

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
                pass

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8", "replace")
                outer.requests.append({"path": self.path, "body": body})

                reply = outer.replies.pop(0) if outer.replies else {"text": '{"corrections":[]}'}
                if reply.get("body"):
                    payload = str(reply["body"]).encode("utf-8")
                elif "status" in reply:
                    payload = json.dumps(
                        {"error": {"code": reply["status"], "message": reply.get("message", ""), "status": "X"}}
                    ).encode("utf-8")
                else:
                    payload = json.dumps(
                        {
                            "candidates": [
                                {
                                    "content": {"role": "model", "parts": [{"text": reply["text"]}]},
                                    "finishReason": "STOP",
                                }
                            ],
                            "modelVersion": "stand-in",
                        }
                    ).encode("utf-8")

                self.send_response(reply.get("status", 200))
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@pytest.fixture()
def stand_in():
    servers = []

    def factory(replies):
        server = StandIn(replies)
        servers.append(server)
        return server

    yield factory
    for server in servers:
        server.close()


# --------------------------------------------------------------------------- #
# the happy path: a real SDK call, a real reply, a real ledger
# --------------------------------------------------------------------------- #


def test_a_reply_off_the_wire_reaches_the_transcript(stand_in):
    server = stand_in([{"text": '{"corrections":[{"index":2,"from":"wrold","to":"world","confidence":0.95,"reason":"typo"}]}'}])
    transcript = build([["hello", "brave", "wrold"]])
    options = ValidateOptions(provider="google", api_key="test-key", extra={"base_url": server.base_url})

    checked = validate_transcript(transcript, options, "llm")

    assert [word.text for word in checked.iter_words()] == ["hello", "brave", "world"]
    assert checked.corrections[0]["outcome"] == "applied"
    assert checked.corrections[0]["reason"] == "typo"
    # the request really was an HTTP POST, and it really carried our prompt
    assert server.requests and "wrold" in server.requests[0]["body"]
    record = checked.validation["passes"][0]
    assert record["provider"] == "google" and record["applied"] == 1


def test_the_timing_is_untouched_by_a_correction_that_crossed_the_network(stand_in):
    server = stand_in([{"text": '{"corrections":[{"index":0,"from":"light","to":"night","confidence":1}]}'}])
    transcript = build([["light", "the", "dark"]])
    before = [(w.start, w.end, w.id, w.probability) for w in transcript.iter_words()]
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})

    checked = validate_transcript(transcript, options, "llm")

    assert [(w.start, w.end, w.id, w.probability) for w in checked.iter_words()] == before


def test_every_batch_goes_out_and_the_indices_come_back_shifted(stand_in):
    server = stand_in(
        [
            {"text": '{"corrections":[{"index":0,"from":"a","to":"A","confidence":1}]}'},
            # local index 0 of the second batch, i.e. the fourth word overall
            {"text": '{"corrections":[{"index":0,"from":"d","to":"D","confidence":1}]}'},
        ]
    )
    transcript = build([["a", "b", "c", "d", "e"]])
    options = ValidateOptions(
        provider="google", api_key="k", batch_words=3, extra={"base_url": server.base_url}
    )

    checked = validate_transcript(transcript, options, "llm")

    assert len(server.requests) == 2
    assert [word.text for word in checked.iter_words()] == ["A", "b", "c", "D", "e"]
    assert checked.corrections[1]["index"] == 3  # local 0 of batch 2, shifted back


def test_a_prose_wrapped_reply_still_lands(stand_in):
    server = stand_in([{"text": 'Here you go:\n```json\n{"corrections":[{"index":0,"from":"wrold","to":"world","confidence":1}]}\n```\n'}])
    transcript = build([["wrold"]])
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})
    assert [w.text for w in validate_transcript(transcript, options, "llm").iter_words()] == ["world"]


# --------------------------------------------------------------------------- #
# the unhappy paths
# --------------------------------------------------------------------------- #


def test_a_transient_failure_is_not_mistaken_for_a_ledger_entry(stand_in):
    server = stand_in([{"status": 500, "message": "internal error"}])
    transcript = build([["hello"]])
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})

    with pytest.raises(Exception) as caught:
        validate_transcript(transcript, options, "llm")
    assert "no configured model" not in str(caught.value)  # 500 is not a model problem
    assert len(server.requests) == 1


def test_a_rejected_key_is_reported_and_not_retried(stand_in):
    server = stand_in([{"status": 403, "message": "API key not valid"}])
    transcript = build([["hello"]])
    options = ValidateOptions(provider="google", api_key="bad", extra={"base_url": server.base_url})

    with pytest.raises(Exception):
        validate_transcript(transcript, options, "llm")
    assert len(server.requests) == 1  # the fallback must not paper over a bad key


def test_a_busy_model_moves_to_the_next_candidate(stand_in):
    """
    A 503 means "try another model", which is the difference between a pass that
    works on a bad day and one that does not. Google's free tier answered 503 to
    everything on the day this was written, so the path is not hypothetical.
    """
    server = stand_in(
        [
            {"status": 503, "message": "This model is currently experiencing high demand."},
            {"text": '{"corrections":[{"index":0,"from":"wrold","to":"world","confidence":1}]}'},
        ]
    )
    transcript = build([["wrold"]])
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})

    checked = validate_transcript(transcript, options, "llm")

    assert len(server.requests) == 2
    assert [w.text for w in checked.iter_words()] == ["world"]
    # and the ledger names the model that actually answered, not the one asked for
    record = checked.validation["passes"][0]
    assert record["model"] == LLM_MODEL_FALLBACKS["google"][0] != DEFAULT_LLM_MODELS["google"]


def test_an_exhausted_quota_is_explained_and_not_retried(stand_in):
    """
    A 429 is the failure the free tier actually produces, and it must not look
    like a busy model: there is nothing wrong with the key, the request or the
    model name, so the next candidate must not be tried behind the caller's back.
    """
    server = stand_in(
        [
            {
                "status": 429,
                "message": "Resource has been exhausted",
                "body": '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":['
                '{"@type":"type.googleapis.com/google.rpc.QuotaFailure",'
                '"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},'
                '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"27s"}]}}',
            }
        ]
    )
    transcript = build([["hello"]])
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})

    with pytest.raises(QuotaError) as caught:
        validate_transcript(transcript, options, "llm")

    text = str(caught.value)
    assert "429" in text and "no audio" in text.lower()
    assert caught.value.quota_id == "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
    assert caught.value.retry_after == 27.0
    assert len(server.requests) == 1  # the fallback must not mask an exhausted quota


def test_quota_error_only_fires_for_quota_shaped_failures():
    provider = resolve_provider(ValidateOptions(provider="google", api_key="k"))
    assert quota_error(Exception("boom: 500 server error"), provider) is None
    assert quota_error(Exception("403 API key not valid"), provider) is None
    exhausted = quota_error(
        Exception('429 RESOURCE_EXHAUSTED: {"retryDelay":"9s","quotaId":"Q"}'), provider, "gemini-x"
    )
    assert isinstance(exhausted, QuotaError)
    assert exhausted.retry_after == 9.0 and exhausted.model == "gemini-x"


def test_the_provider_points_at_the_base_url_it_was_given():
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": "http://127.0.0.1:9/v1"})
    assert resolve_provider(options).base_url == "http://127.0.0.1:9/v1"
    assert resolve_provider(ValidateOptions(provider="google", api_key="k")).base_url is None
