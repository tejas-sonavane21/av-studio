"""
reconcile.py — casting a transcript onto the original lyrics.

This is the one pass in the suite that is *allowed* to change the word count, so
the tests that matter are the ones guarding what it may not do: it may not move a
word it did not have to move, it may not apply a lyric sheet that is for another
song, it may not leave a change unrecorded, and it may not leave two segments
overlapping — because overlapping segments are what ``normalize_transcript`` slides
forward, and a slide at the front becomes drift by the end of the file.

Nothing here needs a model, a network or an audio file: ``build`` lays out
transcripts by hand and a plain-text reference is a few lines.
"""

from __future__ import annotations

from audio_studio.config import ReconcileOptions
from audio_studio.model import Segment, Transcript, Word, validate
from audio_studio.pipeline import PipelineOptions, post_process, summarise_passes
from audio_studio.reconcile import INSERT_WORD_CAP, reconcile
from audio_studio.reference import Reference


def build(lines, *, t0: float = 0.0, word: float = 0.4, gap: float = 0.5) -> Transcript:
    """Contiguous words, one per 0.4 s, one segment per line — the same shape test_align uses."""
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


def texts(transcript: Transcript) -> list[str]:
    return [word.text for word in transcript.iter_words()]


def timings(transcript: Transcript) -> list[tuple[float, float]]:
    return [(word.start, word.end) for word in transcript.iter_words()]


def reference(text: str, **kwargs) -> Reference:
    return Reference.from_text(text, name="lyrics.txt", **kwargs)


# --------------------------------------------------------------------------- #
# the three things the pass may do
# --------------------------------------------------------------------------- #


def test_a_word_the_file_spells_better_keeps_its_timing():
    """
    A misspelling is the case a transcriber gets wrong most often, and the one where
    the timing is known to be right. The spelling must move and the clock must not.
    """
    before = build([["i", "whould", "go"]])
    after = reconcile(before, reference("I would go"))

    assert texts(after) == ["I", "would", "go"]
    assert timings(after) == timings(before), "a rewritten word may not move"
    assert after.reference["counts"] == {"kept": 1, "rewritten": 2, "inserted": 0, "deleted": 0}


def test_a_word_the_audio_missed_is_inserted_with_an_interpolated_window():
    before = build([["and", "they", "say", "that", "love", "will", "last"]])
    after = reconcile(before, reference("And they say that love will last forever"))

    assert texts(after) == ["And", "they", "say", "that", "love", "will", "last", "forever"]
    inserted = [edit for edit in after.reference["edits"] if edit["op"] == "insert"]
    assert [edit["to"] for edit in inserted] == ["forever"]
    assert inserted[0]["interpolated"] is True, "an invented window has to say that it is invented"

    forever = list(after.iter_words())[-1]
    assert forever.duration > 0
    assert forever.start >= list(after.iter_words())[-2].end, "words stay in order"


def test_a_word_the_audio_invented_is_deleted():
    before = build([["and", "they", "say", "music", "that", "love"]])
    after = reconcile(before, reference("And they say that love"))

    assert texts(after) == ["And", "they", "say", "that", "love"]
    assert after.reference["counts"]["deleted"] == 1
    assert [edit for edit in after.reference["edits"] if edit["op"] == "delete"][0]["from"] == "music"


def test_the_result_is_exactly_the_lyric_sheet():
    """The claim the whole pass rests on: after it, the text is the file's text."""
    sheet = "And they say that a hero can save us"
    before = build([["and", "they", "say", "that", "a", "hero", "can", "save", "as"]])
    after = reconcile(before, reference(sheet))

    assert texts(after) == list(reference(sheet).words)
    assert after.word_count == reference(sheet).word_count


def test_punctuation_and_case_come_from_the_file():
    after = reconcile(build([["i", "am", "here"]]), reference("I am here,"))
    assert texts(after) == ["I", "am", "here,"]


# --------------------------------------------------------------------------- #
# invariants the earlier phases rely on
# --------------------------------------------------------------------------- #


def test_the_result_never_overlaps_and_validates_clean():
    before = build([["alpha", "bravo", "charlie"], ["delta", "echo"]])
    after = reconcile(before, reference("alpha bravo charlie delta echo foxtrot golf"))

    report = validate(after)
    assert report["errors"] == [], report["errors"]
    for previous, current in zip(after.segments, after.segments[1:]):
        assert previous.end <= current.start
    for segment in after.segments:
        assert segment.text == " ".join(word.text for word in segment.words)


def test_words_are_never_moved_backwards_and_never_negative():
    after = reconcile(build([["a", "b"], ["c", "d"]]), reference("a b x y c d"))
    previous_end = 0.0
    for word in after.iter_words():
        assert word.start >= previous_end
        assert word.end >= word.start >= 0.0
        previous_end = word.end


def test_an_insert_in_a_long_gap_does_not_hand_one_word_three_seconds():
    """
    The window between two lines can be an instrumental break. Spreading a missed
    word across all of it puts one word on screen for seconds; the cap bounds it, and
    a later alignment is free to move it to the right place.
    """
    before = build([["alpha", "bravo"], ["charlie", "delta"]], gap=3.0)
    after = reconcile(before, reference("alpha bravo echo charlie delta"))

    inserted = [word for word in after.iter_words() if word.text == "echo"]
    assert len(inserted) == 1
    assert inserted[0].duration <= INSERT_WORD_CAP
    assert not [w for w in after.warnings if "slid forward" in w], "an insert may not push a segment"


def test_a_transcript_with_one_segment_stays_one_segment():
    after = reconcile(build([["alpha", "bravo"]]), reference("alpha bravo charlie"))
    assert len(after.segments) == 1


# --------------------------------------------------------------------------- #
# refusal
# --------------------------------------------------------------------------- #


def test_a_lyric_sheet_for_another_song_is_refused_not_applied():
    before = build([["alpha", "bravo", "charlie"], ["delta", "echo", "foxtrot"]])
    after = reconcile(before, reference("kangaroo wallaby wombat"))

    assert after.reference["outcome"] == "refused"
    assert texts(after) == texts(before)
    assert timings(after) == timings(before)
    assert "does not look like the same recording" in after.reference["reason"]


def test_a_refusal_is_recorded_and_warned_never_silent():
    after = reconcile(build([["alpha", "bravo"]]), reference("kangaroo wallaby"))
    assert any("refused" in warning for warning in after.warnings)
    assert after.reference["edits"] == []
    assert after.reference["matchRate"] < after.reference["minMatch"]


def test_min_match_is_the_only_knob_and_it_is_respected():
    before = build([["alpha", "bravo", "charlie", "delta"]])
    # Exactly the same input, twice: trusted at the default floor, refused above it.
    applied = reconcile(before, reference("alpha bravo charlie delta echo"))
    refused = reconcile(before, reference("alpha bravo charlie delta echo"), ReconcileOptions(min_match=0.99))
    assert applied.reference["outcome"] == "applied"
    assert refused.reference["outcome"] == "refused"


def test_reconcile_does_not_touch_the_transcript_it_was_given():
    """
    A refusal returns a copy, and the input is left exactly as it was — so a caller
    that keeps the original (an artifact on disk, the previous pass's output) is not
    quietly holding something the reference pass already edited.
    """
    before = build([["alpha", "bravo"]])
    snapshot = (texts(before), timings(before))

    reconcile(before, reference("alpha bravo charlie"))
    reconcile(before, reference("kangaroo wallaby"))

    assert (texts(before), timings(before)) == snapshot
    assert before.reference is None
    assert before.warnings == []


def test_the_same_inputs_give_the_same_output_twice():
    before = build([["i", "whould", "go", "home"]])
    first = reconcile(before, reference("I would go home"))
    second = reconcile(before, reference("I would go home"))
    assert first.to_dict() == second.to_dict()


# --------------------------------------------------------------------------- #
# the ledger
# --------------------------------------------------------------------------- #


def test_every_change_reaches_the_ledger_with_a_type():
    before = build([["i", "whould", "go", "music", "home"]])
    after = reconcile(before, reference("I would go home forever"))

    ops = sorted(edit["op"] for edit in after.reference["edits"])
    assert set(ops) == {"delete", "insert", "replace"}, ops
    assert len(ops) == sum(after.reference["counts"].values()) - after.reference["counts"]["kept"]
    spelling = [e for e in after.reference["edits"] if e["op"] == "replace" and e["from"] == "whould"]
    assert spelling[0]["to"] == "would"
    assert spelling[0]["type"] == "spelling"
    counts = after.reference["counts"]
    # 'i' -> 'I' is a rewrite too: the file's capitalisation wins.
    assert counts["rewritten"] == 2 and counts["inserted"] == 1 and counts["deleted"] == 1


def test_a_case_only_change_is_typed_as_case_not_spelling():
    after = reconcile(build([["i", "am"]]), reference("I am"))
    replaced = [edit for edit in after.reference["edits"] if edit["op"] == "replace"]
    assert replaced[0]["type"] == "case"


def test_ledger_indices_point_into_the_transcript_as_it_was():
    """
    Indices are pre-pass on purpose and the record says so: the pass changes the word
    count, so an index taken afterwards would not describe the document it is
    explaining.
    """
    before = build([["i", "whould", "go", "home"]])
    after = reconcile(before, reference("I would go home"))
    assert after.reference["indices"] == "relative to the transcript as it was before this pass"

    replaced = [edit for edit in after.reference["edits"] if edit["op"] == "replace"]
    index = replaced[-1]["index"]
    assert list(before.iter_words())[index].text == replaced[-1]["from"]


def test_a_changed_word_list_drops_provenance_that_describes_the_old_one():
    before = build([["i", "whould", "go"]])
    before.alignment = {"aligner": "fake", "meanShift": 0.1}
    before.validation = {"passes": [{"validator": "rules", "corrections": 1, "applied": 0}]}
    before.corrections = [{"index": 1, "from": "whould", "to": "would", "applied": True}]

    after = reconcile(before, reference("I would go home"))

    assert after.alignment is None and after.validation is None and after.corrections == []
    assert after.reference["dropped"] == {"alignment": True, "validation": True, "corrections": 1}
    note = [w for w in after.warnings if "dropped" in w]
    assert note and "alignment, validation record and corrections ledger" in note[0]
    assert "were dropped" in note[0], "a sentence, not a word salad"


def test_an_unchanged_word_list_keeps_its_provenance():
    before = build([["alpha", "bravo"]])
    before.alignment = {"aligner": "fake", "meanShift": 0.1}
    after = reconcile(before, reference("alpha bravo"))

    assert after.reference["counts"]["rewritten"] == 0
    assert after.alignment == {"aligner": "fake", "meanShift": 0.1}


# --------------------------------------------------------------------------- #
# the record, and the pipeline
# --------------------------------------------------------------------------- #


def test_the_record_survives_a_later_validation_pass():
    """
    A validator rebuilds the transcript. The reference record describes where the words
    came from, so losing it there would leave an artifact whose text has no origin.
    """
    before = build([["i", "whould", "go"]])
    after = post_process(before, None, PipelineOptions(reference=reference("I would go"), validate="rules"))
    assert after.reference == post_process(before, None, PipelineOptions(reference=reference("I would go"))).reference
    assert after.reference["outcome"] == "applied"


def test_the_record_survives_a_round_trip_through_json():
    after = reconcile(build([["i", "whould", "go"]]), reference("I would go"))
    restored = Transcript.from_dict(after.to_dict())
    assert restored.reference == after.reference
    assert texts(restored) == texts(after)


def test_reference_warnings_reach_the_transcript():
    rolling = Reference.from_text(
        "1\n00:00:01,000 --> 00:00:02,000\nalpha one\n\n"
        "2\n00:00:02,000 --> 00:00:03,000\nalpha one\nbeta two\n\n"
        "3\n00:00:03,000 --> 00:00:04,000\nbeta two\ngamma three\n"
    )
    after = reconcile(build([["alpha", "one", "beta", "two", "gamma"]]), rolling)
    assert any(warning.startswith("reference: read as a rolling") for warning in after.warnings)


def test_the_pipeline_runs_reconcile_and_says_so():
    before = build([["i", "whould", "go"]])
    options = PipelineOptions(reference=reference("I would go home"))

    assert options.enabled() == ["reconcile"], "reconcile is a pass, and it comes first"
    assert options.to_dict()["reference"]["words"] == 4
    assert options.to_dict()["referenceOptions"] == {"minMatch": 0.5}

    after = post_process(before, None, options)
    assert texts(after) == ["I", "would", "go", "home"]
    assert any("reference" in line for line in summarise_passes(after))


def test_proofreading_after_the_lyrics_is_flagged_rather_than_silent():
    """
    Reconcile then validate is a legitimate thing to ask for and a bad idea to leave
    unexplained: the text is already the file's, so a "correction" proposed afterwards
    can only disagree with the lyrics. It is warned about, never blocked — the user
    asked for both — and the warning has to survive the validation pass that follows.
    """
    before = build([["i", "whould", "go"]])
    reference_only = post_process(before, None, PipelineOptions(reference=reference("I would go")))
    assert not any("nothing left to guess" in warning for warning in reference_only.warnings)

    both = post_process(before, None, PipelineOptions(reference=reference("I would go"), validate="rules"))
    assert any("nothing left to guess" in warning for warning in both.warnings)


def test_a_pipeline_without_a_reference_does_not_run_the_pass():
    options = PipelineOptions()
    assert options.enabled() == []
    assert options.to_dict()["reference"] is None
    before = build([["alpha"]])
    assert post_process(before, None, options).to_dict() == before.to_dict()


def test_the_record_reports_what_the_file_looked_like():
    after = reconcile(build([["alpha", "bravo"]]), reference("alpha bravo charlie"))
    record = after.reference
    assert record["pass"] == "reconcile"
    assert record["name"] == "lyrics.txt"
    assert record["format"] == "text"
    assert record["rolling"] is False
    assert record["words"] == 3
    assert record["outcome"] == "applied"
    assert 0.0 <= record["matchRate"] <= 1.0
