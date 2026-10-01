"""model.py — the invariants the rest of the suite depends on."""

from __future__ import annotations

from audio_studio.model import (
    Gap,
    Segment,
    Transcript,
    Word,
    find_gaps,
    normalize_transcript,
    validate,
)


def make(segments, **meta) -> Transcript:
    return normalize_transcript(Transcript(segments=list(segments), **meta))


def line(start, end, words) -> Segment:
    return Segment(start=start, end=end, words=[Word(t, s, e) for t, s, e in words])


# --------------------------------------------------------------------------- #
# the invariant shared with caption-studio
# --------------------------------------------------------------------------- #


def test_text_is_derived_from_words_never_the_other_way_round():
    """
    caption-studio's Veed importer rebuilds a block's text as
    ``words.map(w => w.text).join(' ')``. If our text disagreed, importing our
    file would silently change the caption's words.
    """
    seg = Segment(start=0.0, end=2.0, text="STALE TEXT", words=[Word("hello", 0.0, 1.0), Word("world", 1.0, 2.0)])
    out = normalize_transcript(Transcript(segments=[seg]))
    assert out.segments[0].text == "hello world"


def test_words_are_stripped_and_empty_ones_dropped():
    seg = Segment(
        start=0.0,
        end=2.0,
        words=[Word("  hello  ", 0.0, 1.0), Word("   ", 1.0, 1.2), Word("world", 1.2, 2.0)],
    )
    out = normalize_transcript(Transcript(segments=[seg]))
    assert [w.text for w in out.segments[0].words] == ["hello", "world"]
    assert out.segments[0].text == "hello world"


def test_a_segment_with_words_but_no_text_still_gets_text():
    seg = Segment(start=0.0, end=1.0, words=[Word("solo", 0.0, 1.0)])
    out = normalize_transcript(Transcript(segments=[seg]))
    assert out.segments[0].text == "solo"


def test_segment_envelope_tracks_its_words():
    """A word can never fall outside its own segment's window."""
    seg = Segment(start=1.0, end=1.5, words=[Word("early", 0.5, 0.9), Word("late", 1.6, 2.2)])
    out = normalize_transcript(Transcript(segments=[seg]))
    only = out.segments[0]
    assert only.start == 0.5 and only.end == 2.2
    assert all(only.start <= w.start and w.end <= only.end for w in only.words)


# --------------------------------------------------------------------------- #
# ordering / non-overlap
# --------------------------------------------------------------------------- #


def test_segments_are_sorted_by_start():
    a, b = line(5.0, 6.0, [("b", 5.0, 6.0)]), line(1.0, 2.0, [("a", 1.0, 2.0)])
    out = normalize_transcript(Transcript(segments=[a, b]))
    assert [s.text for s in out.segments] == ["a", "b"]


def test_overlapping_segments_are_slid_forward_and_keep_their_duration():
    """
    Sliding preserves duration; clamping would quietly shorten a caption. The
    same choice is made in caption-studio/src/align/aligner.js.
    """
    first = line(0.0, 2.0, [("one", 0.0, 2.0)])
    second = line(1.0, 3.0, [("two", 1.0, 3.0)])
    out = normalize_transcript(Transcript(segments=[first, second]))
    assert out.segments[1].start == 2.0
    assert out.segments[1].duration == second.duration
    assert out.segments[1].words[0].start == 2.0


def test_a_slide_is_reported_rather_than_done_quietly():
    """
    The overlap safety net moves a caption in time, so it has to say so. The
    structural warnings are computed *after* the repair, so on their own they
    would find nothing wrong and a segment could end up a second later than the
    transcriber put it with no explanation at all — which is the silent guessing
    this module refuses everywhere else.
    """
    first = line(0.0, 2.0, [("one", 0.0, 2.0)])
    second = line(1.0, 3.0, [("two", 1.0, 3.0)])
    out = normalize_transcript(Transcript(segments=[first, second]))

    assert out.meta["slides"] == [{"segment": "seg-0002", "delta": 1.0}]
    assert any("slid forward 1.000s" in warning for warning in out.warnings)
    # and the report survives the round trip, so a reader of the artifact sees it
    assert Transcript.from_dict(out.to_dict()).meta["slides"] == out.meta["slides"]


def test_words_inside_a_segment_are_made_monotonic():
    seg = Segment(
        start=0.0,
        end=3.0,
        words=[Word("a", 0.0, 1.0), Word("b", 0.5, 1.4), Word("c", 2.0, 3.0)],
    )
    out = normalize_transcript(Transcript(segments=[seg]))
    ends = [w.end for w in out.segments[0].words]
    starts = [w.start for w in out.segments[0].words]
    assert starts == sorted(starts)
    assert all(s <= e for s, e in zip(starts, ends))
    assert starts[1] >= ends[0]


def test_empty_segments_are_dropped():
    out = normalize_transcript(Transcript(segments=[Segment(start=1.0, end=1.0), line(0.0, 1.0, [("x", 0.0, 1.0)])]))
    assert len(out.segments) == 1


# --------------------------------------------------------------------------- #
# hostile input
# --------------------------------------------------------------------------- #


def test_nan_and_negative_times_are_sanitized():
    seg = Segment(start=-3.0, end=float("nan"), words=[Word("x", float("inf"), -1.0)])
    out = normalize_transcript(Transcript(segments=[seg]))
    for s in out.segments:
        assert s.start == s.start and s.end == s.end
        assert s.start >= 0.0 and s.end >= s.start
    report = validate(out)
    assert report["errors"] == []


def test_validate_catches_a_text_that_disagrees_with_its_words():
    broken = Transcript(segments=[Segment(start=0.0, end=1.0, text="one two", words=[Word("one", 0.0, 1.0)])])
    errors = validate(broken)["errors"]
    assert any("does not match its words" in e for e in errors)


def test_validate_catches_overlap():
    broken = Transcript(
        segments=[
            Segment(start=0.0, end=2.0, words=[Word("a", 0.0, 2.0)]),
            Segment(start=1.0, end=3.0, words=[Word("b", 1.0, 3.0)]),
        ]
    )
    assert any("overlaps" in e for e in validate(broken)["errors"])


def test_validate_is_clean_after_normalize():
    messy = Transcript(
        segments=[
            Segment(start=1.0, end=3.0, words=[Word("two", 1.0, 3.0)]),
            Segment(start=0.5, end=2.0, words=[Word("one", 0.5, 2.0)]),
        ]
    )
    report = validate(normalize_transcript(messy))
    assert report["errors"] == []


# --------------------------------------------------------------------------- #
# ids, gaps, determinism
# --------------------------------------------------------------------------- #


def test_ids_are_positional_so_two_runs_agree():
    transcript = make([line(0.0, 1.0, [("a", 0.0, 0.5), ("b", 0.5, 1.0)]), line(2.0, 3.0, [("c", 2.0, 3.0)])])
    assert [s.id for s in transcript.segments] == ["seg-0001", "seg-0002"]
    assert [w.id for w in transcript.segments[0].words] == ["w-0001-001", "w-0001-002"]


def test_normalize_is_idempotent_at_the_byte_level():
    once = make([line(0.0, 1.0, [("a", 0.0, 1.0)]), line(0.5, 2.0, [("b", 0.5, 2.0)])])
    twice = normalize_transcript(Transcript.from_dict(once.to_dict()))
    assert twice.to_dict() == once.to_dict()


def test_gaps_cover_lead_in_tail_and_interior_silence():
    transcript = make(
        [
            line(3.0, 4.0, [("a", 3.0, 4.0)]),
            line(20.0, 21.0, [("b", 20.0, 21.0)]),
        ],
        duration=30.0,
    )
    gaps = find_gaps(transcript, min_duration=1.0)
    assert [(g.start, g.end) for g in gaps] == [(0.0, 3.0), (4.0, 20.0), (21.0, 30.0)]


def test_a_long_gap_is_warned_about():
    """Veed's reference pair has a 22-second instrumental hole; it must be reported."""
    transcript = make([line(0.0, 1.0, [("a", 0.0, 1.0)]), line(24.0, 25.0, [("b", 24.0, 25.0)])], duration=25.0)
    assert any("timing gap" in w for w in transcript.warnings)
    assert any(g.duration >= 20.0 for g in transcript.gaps)


def test_short_gaps_are_not_reported():
    out = normalize_transcript(
        Transcript(segments=[line(0.0, 1.0, [("a", 0.0, 1.0)]), line(1.3, 2.0, [("b", 1.3, 2.0)])], duration=2.0)
    )
    assert out.gaps == []


def test_duration_never_shrinks_below_the_last_segment():
    out = normalize_transcript(Transcript(segments=[line(0.0, 9.0, [("a", 0.0, 9.0)])], duration=2.0))
    assert out.duration == 9.0


def test_stats_are_derived_not_stored():
    transcript = make([line(0.0, 1.0, [("a", 0.0, 0.5), ("b", 0.5, 1.0)])], duration=10.0)
    assert transcript.word_count == 2
    assert transcript.speech_duration == 1.0
    assert transcript.speech_ratio == 0.1


# --------------------------------------------------------------------------- #
# tolerant parsing
# --------------------------------------------------------------------------- #


def test_word_from_dict_accepts_our_shape():
    word = Word.from_dict({"text": "hi", "start": 1.0, "end": 2.0, "probability": 0.8, "id": "w-1"})
    assert (word.text, word.start, word.end, word.probability, word.id) == ("hi", 1.0, 2.0, 0.8, "w-1")


def test_word_from_dict_accepts_the_veed_shape():
    word = Word.from_dict({"text": "hi", "s": 1.0, "e": 2.0})
    assert (word.text, word.start, word.end) == ("hi", 1.0, 2.0)


def test_gap_duration():
    assert Gap(1.0, 3.5).duration == 2.5
    assert Gap(3.0, 1.0).duration == 0.0


def test_round_trip_through_dict():
    original = make([line(0.0, 1.0, [("hello", 0.0, 0.5), ("there", 0.5, 1.0)])], duration=4.0, language="en")
    restored = Transcript.from_dict(original.to_dict())
    assert normalize_transcript(restored).to_dict() == original.to_dict()
