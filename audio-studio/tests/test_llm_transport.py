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
from audio_studio.validate import llm, validate_transcript  # noqa: E402
from audio_studio.validate.llm import (  # noqa: E402
    LLM_MODEL_FALLBACKS,
    QuotaError,
    quota_error,
    resolve_provider,
)

#: A free-tier quota refusal, carrying both the fields the studio reads out of it:
#: the provider's own name for the limit, and its retry delay.
QUOTA_REFUSAL = (
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":['
    '{"@type":"type.googleapis.com/google.rpc.QuotaFailure",'
    '"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},'
    '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"27s"}]}}'
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


def test_a_busy_model_moves_to_the_next_candidate(stand_in, llm_clock):
    """
    A 503 means "try another model", which is the difference between a pass that
    works on a bad day and one that does not. Google's free tier answered 503 to
    everything on the day this was written, so the path is not hypothetical.

    The named model gets one short wait first, so a spike that clears in ten
    seconds is answered by the model that was asked for rather than by the
    fallback — and a spike that does not clear costs ten seconds, not minutes.
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
    assert llm_clock.sleeps == [llm.BUSY_HOP_DELAY]
    # and the ledger names the model that actually answered, not the one asked for
    record = checked.validation["passes"][0]
    assert record["model"] == LLM_MODEL_FALLBACKS["google"][0] != DEFAULT_LLM_MODELS["google"]


def test_an_exhausted_quota_is_explained_and_not_retried(stand_in):
    """
    A 429 is the failure the free tier actually produces, and it must not look
    like a busy model: there is nothing wrong with the key, the request or the
    model name, so the next candidate must not be tried behind the caller's back.
    """
    server = stand_in([{"status": 429, "message": "Resource has been exhausted", "body": QUOTA_REFUSAL}])
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


# --------------------------------------------------------------------------- #
# the free-tier cool-down
#
# What is under test here is the *schedule*: which wait the pass asks for, in
# which order, and how many requests come out of one refusal. The clock in
# ``conftest`` records every wait instead of taking it, so the whole policy is
# checked in milliseconds — and checking it by really waiting would also mean
# nobody ever ran these tests.
# --------------------------------------------------------------------------- #

#: 503 with the free tier's own wording, which is what a spike actually returns.
BUSY_503 = {"status": 503, "message": "This model is currently experiencing high demand."}


def test_a_busy_fallback_waits_fifteen_seconds_before_its_one_retry(stand_in, llm_clock, monkeypatch):
    """
    An unarmed fallback is not worth minutes: one short retry and then the pass
    fails, saying which models it tried. Four rungs of waiting have to be earned.
    """
    monkeypatch.setattr(llm, "MIN_REQUEST_SPACING", 0.0)  # isolate the cool-down from the pacing
    server = stand_in([BUSY_503, BUSY_503, BUSY_503])
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})

    with pytest.raises(RuntimeError, match="no configured model"):
        validate_transcript(build([["hello"]]), options, "llm")

    # the named model once, then the fallback twice: a retry, and then no more
    assert len(server.requests) == 3
    assert llm_clock.sleeps == [llm.BUSY_HOP_DELAY, llm.BUSY_LADDER[0]]


def test_the_cool_down_numbers_are_the_agreed_policy():
    """
    Pinned, because these five numbers are a product decision rather than a detail
    of the implementation: the spec is "10 s to switch, 15/30/60/120 to keep
    waiting, one rung until it is earned by two exhausted quotas, and 6 s between
    requests". The tests below use the constants, so this is where they are held to
    the numbers they are supposed to be.
    """
    assert llm.BUSY_HOP_DELAY == 10.0
    assert llm.BUSY_LADDER == (15.0, 30.0, 60.0, 120.0)
    assert llm.LADDER_DEPTH_UNARMED == 1
    assert llm.QUOTA_STRIKES_TO_ARM == 2
    assert llm.MIN_REQUEST_SPACING == 6.0


def test_the_long_rungs_open_only_after_the_fallback_is_exhausted_twice(stand_in, llm_clock, monkeypatch):
    """
    ``RESOURCE_EXHAUSTED`` is the one signal that tells saturation apart from a
    spike, so it is what unlocks the exponential part of the cool-down — and it is
    counted *per model*, so the fallback being saturated must not slow down a
    model that is answering fine.

    Both sides of the boundary are checked, which is the point: a ladder that is
    open before the quota failures have been earned is as wrong as one that never
    opens, and only asserting the armed side would pass for either.
    """
    monkeypatch.setattr(llm, "MIN_REQUEST_SPACING", 0.0)
    fallback = LLM_MODEL_FALLBACKS["google"][0]
    refused = {"status": 429, "message": "Resource has been exhausted", "body": QUOTA_REFUSAL}

    def exhaust_the_fallback():
        """One run ending in an exhausted quota for the model tried in place of the named one."""
        server = stand_in([BUSY_503, refused])
        options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})
        with pytest.raises(QuotaError) as caught:
            validate_transcript(build([["hello"]]), options, "llm")
        assert len(server.requests) == 2
        return caught.value

    def busy_fallback(expected_waits):
        """One 503 per available rung. The waits the pass asked for are the assertion."""
        llm_clock.sleeps.clear()
        server = stand_in([BUSY_503] * (len(expected_waits) + 1))
        options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})
        with pytest.raises(RuntimeError, match="no configured model"):
            validate_transcript(build([["hello"]]), options, "llm")
        assert len(server.requests) == len(expected_waits) + 1
        assert llm_clock.sleeps == expected_waits

    # one strike short, the long rungs are still shut
    for _ in range(llm.QUOTA_STRIKES_TO_ARM - 1):
        exhaust_the_fallback()
    assert llm.quota_strikes("google", fallback) == llm.QUOTA_STRIKES_TO_ARM - 1
    busy_fallback([llm.BUSY_HOP_DELAY, llm.BUSY_LADDER[0]])

    # the strike that arms it says so, in the error the caller is already reading
    raised = exhaust_the_fallback()
    assert llm.quota_strikes("google", fallback) == llm.QUOTA_STRIKES_TO_ARM
    assert llm.quota_strikes("google", DEFAULT_LLM_MODELS["google"]) == 0  # per model, not per provider
    assert "cool-down" in str(raised)

    busy_fallback([llm.BUSY_HOP_DELAY, *llm.BUSY_LADDER])


def test_successful_requests_are_spaced_apart(stand_in, llm_clock):
    """
    A three-minute song is a handful of batches, so the pass can walk into the
    per-minute limit on its own. It paces itself instead of discovering the limit.
    """
    server = stand_in([{"text": '{"corrections":[]}'}, {"text": '{"corrections":[]}'}])
    transcript = build([["a", "b", "c", "d", "e"]])
    options = ValidateOptions(provider="google", api_key="k", batch_words=3, extra={"base_url": server.base_url})

    validate_transcript(transcript, options, "llm")

    assert len(server.requests) == 2
    # the first request waits for nothing: there is nothing yet to be spaced from
    assert llm_clock.sleeps == [llm.MIN_REQUEST_SPACING]


def test_a_retired_model_is_swapped_without_waiting_for_it(stand_in, llm_clock, monkeypatch):
    """A name that is gone is not coming back, so it is the one refusal not worth a second of waiting."""
    monkeypatch.setattr(llm, "MIN_REQUEST_SPACING", 0.0)
    server = stand_in([{"status": 404, "message": "This model is no longer available"}, {"text": '{"corrections":[]}'}])
    options = ValidateOptions(provider="google", api_key="k", extra={"base_url": server.base_url})

    validate_transcript(build([["hello"]]), options, "llm")

    assert len(server.requests) == 2
    assert llm_clock.sleeps == []
