"""
align/ — the application layer, the offline backend and the pipeline wiring.

Every decision ``apply_alignment`` makes is testable with hand-written spans, so
none of this needs a model, a download or a network. That is the point: the guards
are what stand between a confident-but-wrong acoustic path and a caption that
drifts, and a guard that is only exercised on real audio is a guard nobody
tests.
"""

from __future__ import annotations

import sys
import types

import pytest

from audio_studio import models as catalogue
from audio_studio import pipeline
from audio_studio.align import align_transcript, available_aligners, get_aligner
from audio_studio.align.apply import apply_alignment, limits_for
from audio_studio.align.base import AlignmentResult, WordSpan
from audio_studio.align.fake import apportion
from audio_studio.config import AlignOptions
from audio_studio.media import Audio
from audio_studio.model import Segment, Transcript, Word, validate
from audio_studio.pipeline import PassUnavailable, PipelineOptions, post_process, summarise_passes


def build(lines, *, t0: float = 0.0, word: float = 0.4, gap: float = 0.5) -> Transcript:
    """A transcript with contiguous words, one word per 0.4 s, one segment per line."""
    segments = []
    cursor = t0
    for tokens in lines:
        words = []
        for token in tokens:
            words.append(Word(text=token, start=round(cursor, 3), end=round(cursor + word, 3), probability=0.8))
            cursor += word
        if words:
            segments.append(Segment(start=words[0].start, end=words[-1].end, words=words))
        cursor += gap
    return Transcript.from_segments(segments, language="en", duration=round(cursor + 1.0, 3), engine={"name": "test"})


def timings(transcript: Transcript) -> list[tuple[float, float]]:
    return [(word.start, word.end) for word in transcript.iter_words()]


def texts(transcript: Transcript) -> list[str]:
    return [word.text for word in transcript.iter_words()]


def spans_for(transcript: Transcript, start: float, step: float, confidence: float = 0.9):
    """A span per word, laid out from ``start`` in even steps."""
    out = []
    for word in transcript.iter_words():
        out.append(WordSpan(start=round(start, 3), end=round(start + step, 3), confidence=confidence))
        start += step
    return out


def per_segment(transcript: Transcript, flat: list) -> list[list]:
    """Re-group a flat span list into one list per segment."""
    grouped, cursor = [], 0
    for segment in transcript.segments:
        grouped.append(flat[cursor : cursor + len(segment.words)])
        cursor += len(segment.words)
    return grouped


# --------------------------------------------------------------------------- #
# the invariant that matters: timing may move, text may not
# --------------------------------------------------------------------------- #


def test_alignment_only_ever_moves_timings():
    """
    The spelling authority and the timing authority are different things, and this
    is where they are kept apart. A pass that could reword a lyric would be worse
    than drift, because there would be nothing left to check it against.
    """
    original = build([["we", "rise", "before"], ["the", "light"]])
    result = AlignmentResult(spans=per_segment(original, spans_for(original, 1.0, 0.3)))
    aligned = apply_alignment(original, result)

    assert texts(aligned) == texts(original)
    assert [segment.text for segment in aligned.segments] == [segment.text for segment in original.segments]
    assert aligned.word_count == original.word_count
    assert timings(aligned) != timings(original)
    assert timings(aligned)[0] == (1.0, 1.3)


def test_the_input_transcript_is_not_modified():
    original = build([["a", "b", "c"]])
    before = timings(original)
    apply_alignment(original, AlignmentResult(spans=per_segment(original, spans_for(original, 5.0, 0.3))))
    assert timings(original) == before


def test_word_probabilities_survive_and_ids_stay_positional():
    original = build([["a", "b"]])
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, spans_for(original, 0.05, 0.3))))
    assert [word.probability for word in aligned.iter_words()] == [0.8, 0.8]
    assert [word.id for word in aligned.iter_words()] == ["w-0001-001", "w-0001-002"]


def test_alignment_keeps_the_record_of_where_the_words_came_from():
    """
    The pipeline runs reconcile *then* align, so alignment is the pass that emits the
    artifact — and it used to rebuild the transcript without the reference pass's record.
    The words were still the lyric sheet's, but the artifact said nothing about it: an
    emitted file was indistinguishable from one transcribed with no lyrics at all, and
    the caption editor's audit panel reported the run as if none had been given.
    """
    original = build([["one", "two"]])
    original.reference = {"pass": "reconcile", "name": "lyrics.srt", "outcome": "applied"}
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, spans_for(original, 0.1, 0.4))))

    assert aligned.reference == original.reference
    assert aligned.reference is not original.reference, "a copy, so a caller cannot edit ours"


def test_the_aligned_output_is_a_valid_document():
    original = build([["one", "two", "three"], ["four", "five"]])
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, spans_for(original, 0.7, 0.45))))
    report = validate(aligned)
    assert report["errors"] == []


def test_aligning_twice_with_the_same_spans_changes_nothing_further():
    """The pass is a refinement, not a drift: repeating it is a no-op."""
    original = build([["a", "b", "c"]])
    flat = [WordSpan(0.05, 0.35, 0.9), WordSpan(0.40, 0.75, 0.9), WordSpan(0.80, 1.10, 0.9)]
    spans = per_segment(original, flat)
    once = apply_alignment(original, AlignmentResult(spans=spans))
    twice = apply_alignment(once, AlignmentResult(spans=spans))
    assert timings(twice) == timings(once)


# --------------------------------------------------------------------------- #
# the window rule: alignment refines a segment, it never invades the next one
# --------------------------------------------------------------------------- #


def test_a_span_reaching_past_the_next_segment_is_clamped_and_counted():
    """
    Not a tidiness rule. A word that leaks into the next segment makes that one
    overlap, the overlap is slid forward, and every following segment slides with
    it — so a 0.3 s leak at the top of a song becomes a second of lag by the end.
    Measured on the real track before this rule existed: 1.25 s of mean drift.

    Fixture: two contiguous 0.8 s segments. The first segment's last word is
    claimed at 0.50-1.10, i.e. 0.30 s past the boundary the transcriber drew.
    """
    original = build([["a", "b"], ["c", "d"]], word=0.4, gap=0.0)
    flat = [WordSpan(0.0, 0.45, 0.9), WordSpan(0.5, 1.10, 0.9), WordSpan(0.85, 1.25, 0.9), WordSpan(1.3, 1.6, 0.9)]
    aligned = apply_alignment(
        original, AlignmentResult(spans=per_segment(original, flat)), AlignOptions(window_pad=0.3)
    )

    assert aligned.alignment["segmentsKept"] == 0
    assert aligned.alignment["wordsClamped"] == 1
    assert aligned.segments[0].words[-1].end == 0.8
    assert any("pulled back inside the space their segment owns" in warning for warning in aligned.warnings)
    # and therefore no segment was pushed later than the transcriber put it —
    # which is the difference between refining a timing and inventing a drift
    assert [segment.start for segment in aligned.segments] == [
        segment.start for segment in original.segments
    ]


def test_alignment_may_not_reach_past_the_end_of_the_recording():
    """
    The tail of a song is where a reverb, a choir or an outro gives a CTC path
    something plausible to latch onto, and a word placed past the last sample is a
    caption displayed after the music has stopped. The recording's own end is the
    one boundary the aligner may not cross.
    """
    original = build([["one", "two"]], word=0.4, gap=0.0)
    original.duration = 0.9
    flat = [WordSpan(0.0, 0.4, 0.9), WordSpan(0.5, 1.4, 0.9)]
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, flat)))

    assert aligned.segments[-1].words[-1].end <= original.duration
    assert any("may not reach past the end of the recording" in warning for warning in aligned.warnings)
    assert validate(aligned)["errors"] == []


def test_a_span_outside_the_window_lands_inside_it_and_keeps_a_window():
    """
    The two ends of the window used to be clamped independently, and that is not the
    same thing: a span lying wholly past the window's edge collapsed to a word of no
    length sitting at its own, out-of-window start — a word no editor can show, and one
    that in this fixture lands *after the recording has ended*, which is the report this
    whole change came from. The clamp has to move the word inside the window instead.

    Fixture: a one-word caption over the whole of a one-second recording, with the
    aligner hearing that word at 2.0 s — past the end of the audio.
    """
    original = build([["one"]], word=1.0, gap=0.0)
    original.duration = 1.0
    aligned = apply_alignment(original, AlignmentResult(spans=[[WordSpan(2.0, 2.4, 0.9)]]))
    word = aligned.segments[0].words[0]

    assert aligned.alignment["segmentsAligned"] == 1
    assert aligned.alignment["wordsClamped"] == 1
    assert word.end <= original.duration
    assert word.duration >= 0.02, f"collapsed to {word.duration}s"
    assert validate(aligned)["errors"] == []


def test_a_shift_the_transcriber_is_several_beats_out_by_still_aligns():
    """
    The max-shift guard has to admit a real correction, or it keeps the drift it was
    run to remove: a refused segment falls back to the *transcriber's* timing, not to
    the audio. Measured on this project's own 182 s fixture, the shipped 2.0 s limit
    refused the one segment that needed a 2.08 s correction; the default now lets it
    through.
    """
    original = build([["one", "two"]], word=0.5, gap=0.0)
    original.duration = 10.0
    # The aligner hears the first word 2.5 s later than the transcriber put it.
    spans = AlignmentResult(spans=per_segment(original, [WordSpan(2.5, 2.9, 0.9), WordSpan(3.0, 3.4, 0.9)]))

    strict = apply_alignment(original, spans, AlignOptions(window_pad=1.0, max_shift=2.0))
    shipped = apply_alignment(original, spans)

    # The 2.0 s limit refused the segment outright, and a refusal is not a fallback
    # to the audio — it is a fallback to the timings the pass was run to replace.
    assert strict.alignment["segmentsKept"] == 1
    assert shipped.alignment["segmentsKept"] == 0
    assert shipped.alignment["segmentsAligned"] == 1
    # ...and the correction stays inside the window the segment owns, so a wide
    # max-shift can never let one caption invade the next.
    assert all(0.0 <= start <= end <= 2.0 for start, end in timings(shipped))


def test_the_pad_is_only_available_where_there_is_a_gap():
    contiguous = build([["a"], ["b"]], gap=0.0)
    left, right = limits_for(contiguous, 0, AlignOptions(window_pad=0.3))
    assert (left, right) == (contiguous.segments[0].start, contiguous.segments[0].end)

    gapped = build([["a"], ["b"]], gap=1.5)
    left, right = limits_for(gapped, 0, AlignOptions(window_pad=0.3))
    assert right == gapped.segments[0].end + 0.3


def test_the_first_and_last_segments_may_use_the_silence_outside_the_song():
    transcript = build([["a"], ["b"]], gap=1.5)
    left, right = limits_for(transcript, 0, AlignOptions(window_pad=0.3))
    assert left == max(0.0, transcript.segments[0].start - 0.3)
    _left, last_right = limits_for(transcript, 1, AlignOptions(window_pad=0.3))
    assert last_right == transcript.segments[1].end + 0.3


# --------------------------------------------------------------------------- #
# the guards
# --------------------------------------------------------------------------- #


def test_a_segment_below_the_confidence_floor_keeps_its_timings():
    original = build([["a", "b", "c"]])
    result = AlignmentResult(spans=per_segment(original, spans_for(original, 1.0, 0.3, confidence=0.05)))
    aligned = apply_alignment(original, result)

    assert timings(aligned) == timings(original)
    assert aligned.alignment["segmentsAligned"] == 0
    assert aligned.alignment["segmentsKept"] == 1
    assert any("kept their original timings" in warning for warning in aligned.warnings)


def test_a_word_that_would_have_to_travel_too_far_refuses_its_whole_segment():
    original = build([["a", "b", "c"]])
    flat = spans_for(original, 0.0, 0.4)
    flat[-1] = WordSpan(start=20.0, end=20.4, confidence=0.9)
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, flat)))

    assert timings(aligned) == timings(original)
    assert aligned.alignment["segmentsKept"] == 1
    assert "shift 1" in " ".join(aligned.warnings)


def test_a_span_the_aligner_skipped_does_not_mispair_the_shift_guard():
    """
    Each span is compared with **its own** word. Packing the provided spans against
    the front of the word list — which is what ``zip([s for s in spans if s is not
    None], words)`` silently does — slides every span after a skipped word onto the
    wrong word, and the guard then measures a distance no word actually moved.

    Fixture: three words, the middle one unplaced, the last claimed 17.5 s from
    where the transcriber heard it. A 1 s guard has to refuse the whole segment.
    Before this was fixed the segment came back ``aligned`` with its last word
    dragged from 30.0 s to 12.5 s — a 17 s sync error, introduced by the pass
    whose entire job is to remove sync errors.
    """
    original = Transcript.from_segments(
        [
            Segment(
                start=10.0,
                end=30.0,
                words=[
                    Word(text="one", start=10.0, end=11.0),
                    Word(text="two", start=12.0, end=13.0),
                    Word(text="three", start=30.0, end=31.0),
                ],
            )
        ],
        duration=31.0,
    )
    result = AlignmentResult(spans=[[WordSpan(10.0, 11.0, 0.9), None, WordSpan(12.5, 13.0, 0.9)]])
    aligned = apply_alignment(original, result, AlignOptions(max_shift=1.0))

    assert timings(aligned) == timings(original)
    assert aligned.alignment["segmentsAligned"] == 0
    assert aligned.alignment["segmentsKept"] == 1
    assert "shift 1" in " ".join(aligned.warnings)


def test_the_shift_guard_measures_onsets_because_a_word_end_is_the_softest_number():
    """
    Where a word *starts* is the sync. How long a transcriber believes a word lasts
    is its weakest output — on the real track every Veed word span was exactly
    0.08 s, a marker rather than a duration — so the guard is onset-only, and a
    segment is not thrown away because the aligner stretched an end. Rejecting for
    that would discard good onsets to protect a number nothing else trusts.
    """
    original = build([["a", "b"]])  # words at 0.0-0.4 and 0.4-0.8
    flat = [WordSpan(0.0, 0.4, 0.9), WordSpan(0.4, 1.1, 0.9)]
    aligned = apply_alignment(
        original, AlignmentResult(spans=per_segment(original, flat)), AlignOptions(max_shift=0.05)
    )

    assert aligned.alignment["segmentsAligned"] == 1
    assert aligned.alignment["maxShift"] == 0.0
    assert aligned.segments[0].words[1].end == 1.1


def test_a_span_list_of_the_wrong_length_is_refused_rather_than_partly_applied():
    original = build([["a", "b", "c"]])
    aligned = apply_alignment(original, AlignmentResult(spans=[[WordSpan(0.0, 1.0)]]))
    assert timings(aligned) == timings(original)
    assert aligned.alignment["segmentsKept"] == 1
    assert "shape 1" in " ".join(aligned.warnings)


def test_a_word_the_aligner_had_nothing_to_say_about_is_interpolated():
    original = build([["a", "b", "c"]])
    flat = [WordSpan(0.0, 0.5, 0.9), None, WordSpan(1.0, 1.5, 0.9)]
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, flat)))

    middle = aligned.segments[0].words[1]
    assert (middle.start, middle.end) == (0.5, 1.0)
    assert aligned.alignment["wordsInterpolated"] == 1
    assert any("interpolated" in warning for warning in aligned.warnings)


def test_a_word_with_no_aligned_neighbour_keeps_its_own_window():
    original = build([["a", "b", "c"]])
    flat = [WordSpan(0.0, 0.5, 0.9), WordSpan(0.5, 1.0, 0.9), None]
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, flat)))
    last = aligned.segments[0].words[2]
    assert last.start >= aligned.segments[0].words[1].end


def test_an_empty_segment_is_left_alone():
    original = Transcript.from_segments([Segment(start=0.0, end=1.0, text="orphan")], duration=2.0)
    aligned = apply_alignment(original, AlignmentResult(spans=[[]]))
    assert [segment.text for segment in aligned.segments] == ["orphan"]


def test_the_new_envelope_always_contains_its_words():
    original = build([["a", "b"]])
    aligned = apply_alignment(original, AlignmentResult(spans=per_segment(original, spans_for(original, 2.0, 0.5))))
    segment = aligned.segments[0]
    assert segment.start <= segment.words[0].start
    assert segment.end >= segment.words[-1].end


# --------------------------------------------------------------------------- #
# the real backend, against a synthetic acoustic model
# --------------------------------------------------------------------------- #


class RevisionNotFoundError(Exception):
    """The hub's own name for "that commit is not there any more"."""


def _stub_transformers(monkeypatch, asked: list[dict], *, pin_missing: bool = False):
    """
    A ``transformers`` whose two entry points are ours, so the aligner's pin is testable.

    Both are imported inside ``_load_pair``, so a `sys.modules` entry is the only way to answer
    the import from a test - the same trick the transcriber's tests use for ``faster_whisper``.

    Every load is recorded as the kwargs it was asked for, which is what makes "at the pin, then
    at main, once" a readable assertion rather than a claim.
    """
    pin = catalogue.ALIGN_REVISION

    def refuse_if_the_pin_is_gone(name: str, kwargs: dict) -> None:
        if pin_missing and kwargs.get("revision"):
            raise RevisionNotFoundError(f"Revision {pin} not found in {name}")

    class Tokenizer:
        @classmethod
        def from_pretrained(cls, name, **kwargs):
            asked.append(kwargs)
            refuse_if_the_pin_is_gone(name, kwargs)
            return cls()

        def get_vocab(self):
            return {"<pad>": 0, "|": 1, "A": 2, "B": 3}

    class Model:
        config = types.SimpleNamespace(conv_stride=(4, 2, 2, 2, 2), sample_rate=16000)

        @classmethod
        def from_pretrained(cls, name, **kwargs):
            refuse_if_the_pin_is_gone(name, kwargs)
            return cls()

        def to(self, device):
            return self

        def eval(self):
            return self

    module = types.ModuleType("transformers")
    module.AutoTokenizer = Tokenizer  # type: ignore[attr-defined]
    module.Wav2Vec2ForCTC = Model  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", module)
    # The verified store answers before the hub, and on a machine that has filled it these
    # pin decisions would never be reached. `test_modelstore.py` tests the precedence itself.
    monkeypatch.setattr("audio_studio.align.wav2vec.modelstore.require", lambda *a, **k: None)


def test_the_aligner_is_handed_the_pinned_checkpoint(monkeypatch):
    """
    A re-timing pass is only reproducible if the acoustic model that produced the timings is the
    same one, so the pin is not decoration: it is what the timings mean.
    """
    from audio_studio.align import wav2vec

    asked: list[dict] = []
    _stub_transformers(monkeypatch, asked)
    wav2vec.clear_cache()

    wav2vec._load(catalogue.ALIGN_MODEL, "cpu")
    assert asked == [{"revision": catalogue.ALIGN_REVISION}]
    assert wav2vec.load_note(catalogue.ALIGN_MODEL, "cpu") == {
        "revision": catalogue.ALIGN_REVISION,
        "pinned": catalogue.ALIGN_REVISION,
        "note": "",
    }


def test_a_pin_the_hub_no_longer_has_aligns_at_main_instead_of_failing(monkeypatch):
    """
    The aligner moves the words, so failing forward silently would be the worst outcome: the
    timings would be real, and nobody would know which checkpoint measured them.
    """
    from audio_studio.align import wav2vec

    asked: list[dict] = []
    _stub_transformers(monkeypatch, asked, pin_missing=True)
    monkeypatch.setattr(wav2vec, "cached_commit", lambda repo, *args, **kwargs: "c" * 40)
    wav2vec.clear_cache()

    wav2vec._load(catalogue.ALIGN_MODEL, "cpu")
    assert ["revision" in kwargs for kwargs in asked] == [True, False], "the pin, then main - once"
    note = wav2vec.load_note(catalogue.ALIGN_MODEL, "cpu")
    assert note["revision"] == "c" * 40, "what the timings are made of, not what was asked for"
    assert catalogue.ALIGN_REVISION[:8] in note["note"]


def test_a_failure_that_is_not_about_the_pin_is_not_retried_here_either(monkeypatch):
    """No network fails the same way at ``main``: a retry would only add a second error."""
    from audio_studio.align import wav2vec

    attempted: list[dict] = []

    class Tokenizer:
        @classmethod
        def from_pretrained(cls, name, **kwargs):
            return cls()

        def get_vocab(self):
            return {"<pad>": 0, "|": 1, "A": 2}

    class Model:
        config = types.SimpleNamespace(conv_stride=(4, 2, 2, 2, 2), sample_rate=16000)

        @classmethod
        def from_pretrained(cls, name, **kwargs):
            attempted.append(kwargs)
            raise ConnectionError("HTTPSConnectionPool(host='huggingface.co'): Max retries exceeded")

    module = types.ModuleType("transformers")
    module.AutoTokenizer = Tokenizer  # type: ignore[attr-defined]
    module.Wav2Vec2ForCTC = Model  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", module)
    monkeypatch.setattr(wav2vec.modelstore, "require", lambda *a, **k: None)
    wav2vec.clear_cache()

    with pytest.raises(ConnectionError):
        wav2vec._load(catalogue.ALIGN_MODEL, "cpu")
    assert attempted == [{"revision": catalogue.ALIGN_REVISION}], "asked once, at the pin, and not again"


def test_the_backend_aligns_a_synthetic_model_and_builds_its_provenance(monkeypatch):
    """
    ``align()`` is the one method that needs torch, and an end-to-end run of it
    took four minutes and a 360 MB checkpoint to find a missing local variable.
    Stubbing the model and the emissions keeps every part that actually decides
    something — target spelling, the window, the trellis, the confidence, the
    frame-to-second conversion and the provenance dict — under the fast suite.
    """
    from array import array

    from audio_studio.align import wav2vec
    from audio_studio.align.ctc import log_softmax

    vocab = {"<pad>": 0, "|": 1, "A": 2, "B": 3}
    channels = 4
    frames = 150
    labels = [0] * 10 + [2] * 40 + [0] * 5 + [3] * 40 + [0] * 55
    assert len(labels) == frames

    data = array("d")
    for label in labels:
        row = [0.0] * channels
        row[label] = 8.0
        data.extend(log_softmax(row))
    emissions = wav2vec._Emissions(frames=frames, channels=channels, data=data)

    monkeypatch.setattr(wav2vec, "_load", lambda model, device: (None, vocab, 0, 1, 320, 16000))
    monkeypatch.setattr(wav2vec, "compute_emissions", lambda samples, model, device="cpu": emissions)
    monkeypatch.setattr(wav2vec.Wav2VecAligner, "available", lambda self: (True, "stub model"))

    transcript = Transcript.from_segments(
        [Segment(start=0.0, end=2.0, words=[Word(text="a", start=0.0, end=1.0), Word(text="b", start=1.0, end=2.0)])],
        language="en",
        duration=3.0,
    )
    audio = Audio(samples=[0.0] * 10, sample_rate=16000, duration=3.0)
    result = wav2vec.Wav2VecAligner().align(audio, transcript, AlignOptions())

    assert result.provenance["backend"] == "wav2vec2"
    assert result.provenance["frames"] == frames
    assert result.provenance["secondsPerFrame"] == 0.02
    assert result.provenance["charactersDropped"] == 0
    assert result.provenance["wordsUnplaceable"] == 0

    first, second = result.spans[0]
    assert (first.start, first.end) == pytest.approx((0.20, 1.00))
    assert (second.start, second.end) == pytest.approx((1.10, 1.90))
    assert first.confidence > 0.9 and second.confidence > 0.9


def test_the_backend_refuses_audio_at_the_wrong_sample_rate(monkeypatch):
    from audio_studio.align import wav2vec

    monkeypatch.setattr(wav2vec, "_load", lambda model, device: (None, {}, 0, 1, 320, 16000))
    monkeypatch.setattr(wav2vec.Wav2VecAligner, "available", lambda self: (True, "stub model"))

    transcript = build([["a"]])
    with pytest.raises(RuntimeError, match="16000 Hz"):
        wav2vec.Wav2VecAligner().align(
            Audio(samples=[0.0], sample_rate=44100, duration=1.0), transcript, AlignOptions()
        )


def test_target_spelling_drops_what_the_alphabet_cannot_spell():
    from audio_studio.align.wav2vec import build_targets

    words = [Word(text="Don't", start=0.0, end=1.0), Word(text="1975!", start=1.0, end=2.0)]
    # A deliberately absurd three-label alphabet, so the drop counts are exact.
    targets, groups, dropped, unplaceable = build_targets(words, {"1": 2}, boundary=None)

    assert targets == [2]
    assert groups == [[], [0]]
    assert dropped == 9  # all five of DON'T, and four of 1975!
    assert unplaceable == 1


def test_a_word_boundary_token_separates_adjacent_words():
    from audio_studio.align.wav2vec import build_targets

    words = [Word(text="ab", start=0.0, end=1.0), Word(text="cd", start=1.0, end=2.0)]
    vocab = {"<": 0, "|": 1, "A": 2, "B": 3, "C": 4, "D": 5}
    targets, groups, _dropped, _unplaceable = build_targets(words, vocab, boundary=1)

    # without the separator the model would see 'abcd' as one run of characters
    assert targets == [2, 3, 1, 4, 5]
    assert groups == [[0, 1], [3, 4]]


# --------------------------------------------------------------------------- #
# provenance
# --------------------------------------------------------------------------- #


def test_provenance_records_the_backend_the_guards_and_what_moved():
    original = build([["a", "b"]])
    result = AlignmentResult(
        spans=per_segment(original, spans_for(original, 0.2, 0.4)),
        provenance={"backend": "example", "model": "x"},
    )
    aligned = apply_alignment(original, result)
    alignment = aligned.alignment

    assert alignment["backend"] == "example"
    assert alignment["model"] == "x"
    assert alignment["segments"] == 1
    assert alignment["segmentsAligned"] == 1
    assert alignment["wordsAligned"] == 2
    assert alignment["minConfidence"] == AlignOptions().min_confidence
    assert alignment["maxShiftLimit"] == AlignOptions().max_shift
    assert alignment["meanShift"] == pytest.approx(0.2, abs=1e-6)


def test_a_backend_warning_reaches_the_artifact():
    original = build([["a"]])
    result = AlignmentResult(
        spans=per_segment(original, spans_for(original, 0.0, 0.4)), warnings=["the audio was quiet"]
    )
    assert "the audio was quiet" in apply_alignment(original, result).warnings


# --------------------------------------------------------------------------- #
# the offline backend and its registry
# --------------------------------------------------------------------------- #


def test_the_fake_aligner_declares_that_it_needs_no_samples():
    aligner = get_aligner("fake")
    assert aligner.requires_samples is False
    assert aligner.available() == (True, "built in (deterministic, no model)")


def test_the_fake_aligner_never_claims_to_have_listened():
    original = build([["we", "rise", "before", "the", "light"]])
    aligned = align_transcript(original, Audio(duration=10.0), backend="fake")

    assert aligned.alignment["aligner"] == "fake"
    assert aligned.alignment["synthetic"] is True
    assert any("synthetic" in warning for warning in aligned.warnings)
    assert texts(aligned) == texts(original)


def test_align_transcript_records_the_registry_name_as_well_as_the_backend_name():
    original = build([["a", "b"]])
    aligned = align_transcript(original, Audio(duration=4.0), backend="fake")
    assert set(aligned.alignment) >= {"aligner", "backend", "synthetic"}


def test_available_aligners_reports_every_registered_name():
    report = {entry["name"]: entry for entry in available_aligners()}
    assert set(report) == {"fake", "wav2vec"}
    assert report["fake"]["available"] is True
    for entry in report.values():
        assert set(entry) >= {"name", "backend", "available", "reason"}


def test_an_unknown_aligner_names_the_valid_ones():
    with pytest.raises(ValueError, match="fake"):
        get_aligner("does-not-exist")


def test_fake_apportion_slots_are_contiguous_and_round_from_one_cursor():
    slots = apportion(1.0, 4.0, [1, 1, 1])
    assert slots[0][1] == slots[1][0]
    assert slots[1][1] == slots[2][0]
    assert slots[0][0] == 1.0 and slots[-1][1] == 4.0


# --------------------------------------------------------------------------- #
# the pipeline
# --------------------------------------------------------------------------- #


def test_the_pipeline_refuses_a_real_aligner_without_decoded_audio(monkeypatch):
    class Listener:
        name = "listener"
        requires_samples = True

        def available(self):
            return True, "stub"

        def align(self, *args, **kwargs):
            raise AssertionError("it must not run at all")

    monkeypatch.setattr(pipeline, "get_aligner", lambda name: Listener())
    with pytest.raises(PassUnavailable, match="decoded"):
        post_process(build([["a"]]), Audio(duration=2.0), PipelineOptions(align="listener"))


def test_the_pipeline_refuses_an_unavailable_aligner(monkeypatch):
    class Missing:
        name = "missing"
        requires_samples = True

        def available(self):
            return False, "not installed"

        def align(self, *args, **kwargs):
            raise AssertionError("it must not run at all")

    monkeypatch.setattr(pipeline, "get_aligner", lambda name: Missing())
    with pytest.raises(PassUnavailable, match="not installed"):
        post_process(build([["a"]]), Audio(samples=[0.0], duration=2.0), PipelineOptions(align="missing"))


def test_the_pipeline_runs_alignment_before_validation(monkeypatch):
    """
    Alignment reads the audio and rewrites *when*; validation reads the words and
    rewrites *what*. The other order would mean aligning text that is about to
    change, so the order is a contract rather than a preference.
    """
    seen = {}

    def spy(transcript, options=None, backend="rules", on_progress=None):
        seen["alignment"] = transcript.alignment
        seen["words"] = timings(transcript)
        return transcript

    monkeypatch.setattr(pipeline, "validate_transcript", spy)
    # Deliberately uneven words: the fake aligner re-divides a segment by word
    # length, so even ones would come back unchanged and prove nothing.
    original = build([["alphabet", "b"]])
    out = post_process(original, Audio(duration=4.0), PipelineOptions(align="fake", validate="rules"))

    assert seen["alignment"] is not None and seen["alignment"]["aligner"] == "fake"
    assert seen["words"] != timings(original)
    assert out.alignment is not None


def test_a_pipeline_with_no_passes_enabled_does_nothing():
    original = build([["a", "b"]])
    assert post_process(original, None, PipelineOptions()).to_dict() == original.to_dict()


def test_enabled_names_the_passes_in_the_order_they_run():
    assert PipelineOptions(align="fake", validate="rules").enabled() == ["align", "validate"]
    assert PipelineOptions(validate="rules").enabled() == ["validate"]
    assert PipelineOptions().enabled() == []


def test_the_summary_names_the_backend_and_the_guards():
    original = build([["a", "b"]])
    aligned = align_transcript(original, Audio(duration=4.0), backend="fake")
    line = "\n".join(summarise_passes(aligned))
    assert "fake" in line and "mean confidence" in line
