"""
reference.py — reading a lyric sheet, and the two subtitle conventions it has to
get right.

The tests that matter most here are not "does it split on blank lines". They are
the two ways a reference file is *silently* misread, both of which were real
failures while this was being written:

* a rolling subtitle file — every cue repeats the lines above it — read naively,
  which multiplies the whole lyric sheet by the size of its roll window. The
  reference material for this project is exactly that file, and reading it that way
  turned a 255-word lyric sheet into a 753-word one;
* a cue's **number** read as a lyric. The same file puts its index inside the cue,
  and reading it added "1", "2", "3" … to the lyrics; the same 255-word sheet came
  out as 793.

Neither failure raises. Both produce a plausible-looking transcript, which is why
they are pinned here rather than left to a fixture nobody looks at.
"""

from __future__ import annotations

import pytest

from audio_studio.reference import (
    ROLLING_SHARE,
    Reference,
    ReferenceParseError,
    match_key,
    parse_reference,
)

#: The shape of the real artifact: index, timestamp, then the text. Cue 1 introduces
#: two lines at once; every later cue repeats the previous lines and adds one.
ROLLING_SRT = """1
00:00:01,000 --> 00:00:04,000
alpha one
beta two

2
00:00:04,000 --> 00:00:07,000
alpha one
beta two
gamma three

3
00:00:07,000 --> 00:00:10,000
beta two
gamma three
delta four

4
00:00:10,000 --> 00:00:13,000
gamma three
delta four
epsilon five
"""

#: A conventional one-line-per-cue file. Its second and third cues carry the *same*
#: line, which is a repeat and not a roll.
ORDINARY_SRT = """1
00:00:01,000 --> 00:00:02,000
hold on

2
00:00:02,000 --> 00:00:03,000
hold on

3
00:00:03,000 --> 00:00:04,000
let go
"""

VTT = """WEBVTT
Kind: captions
Language: en

NOTE this note is not a lyric

intro
00:00:01.000 --> 00:00:04.000
<v Singer>And <c.yellow>They</c> say

cue-2
00:00:04.000 --> 00:00:07.000
And They say
That a hero

00:07.000 --> 00:10.000
can save us
"""

PLAIN = """[Verse 1]
someone told me love won't last forever
(oh yeah)

Chorus:
And They say That a hero can save us

[Guitar solo]
(guitar solo)
"""


def words(text: str) -> list[str]:
    return parse_reference(text).words


# --------------------------------------------------------------------------- #
# the rolling convention
# --------------------------------------------------------------------------- #


def test_a_rolling_file_contributes_each_line_once():
    reference = parse_reference(ROLLING_SRT, name="rolling.srt")
    assert reference.format == "srt"
    assert reference.rolling is True
    assert [line for cue in reference.cues for line in cue.lines] == [
        "alpha one",
        "beta two",
        "gamma three",
        "delta four",
        "epsilon five",
    ]
    assert len(reference.cues) == 4, "every cue is kept, even the ones adding nothing new"
    assert reference.warnings and "rolling" in reference.warnings[0]


def test_the_first_cue_may_introduce_two_lines_at_once():
    # "take the last line of every cue" is the plausible wrong rule, and it loses the
    # first line of the whole sheet: cue 1 adds *two*, not one.
    reference = parse_reference(ROLLING_SRT)
    assert reference.cues[0].lines == ("alpha one", "beta two")
    assert reference.words[0] == "alpha"


def test_an_ordinary_file_keeps_a_repeated_line():
    reference = parse_reference(ORDINARY_SRT, name="ordinary.srt")
    assert reference.rolling is False, "half the cues overlapping is a repeat, not a roll"
    assert reference.words == ["hold", "on", "hold", "on", "let", "go"]


def test_a_cue_number_is_never_a_word():
    # Both files above put the index inside the cue; none of these tokens may survive.
    for text in (ROLLING_SRT, ORDINARY_SRT):
        for word in words(text):
            assert word not in {"1", "2", "3", "4"}, f"{word!r} is a cue number, not a lyric"


def test_rolling_detection_needs_more_than_a_majority():
    # The reason the threshold is not 0.5: this file's overlap share is exactly half,
    # and calling it rolling would delete a line the singer really does sing twice.
    assert ROLLING_SHARE > 0.5
    assert parse_reference(ORDINARY_SRT).rolling is False


def test_a_single_cue_file_is_never_rolling():
    one = "1\n00:00:01,000 --> 00:00:02,000\nhold on\n"
    reference = parse_reference(one)
    assert reference.rolling is False
    assert reference.words == ["hold", "on"]


# --------------------------------------------------------------------------- #
# WebVTT
# --------------------------------------------------------------------------- #


def test_webvtt_headers_notes_ids_and_tags_are_handled():
    reference = parse_reference(VTT, name="x.vtt")
    assert reference.format == "vtt"
    assert "note" not in [w.lower() for w in reference.words], "a NOTE block is not a lyric"
    assert "intro" not in reference.words and "cue-2" not in reference.words, "cue ids are not lyrics"
    assert "c.yellow" not in reference.words
    assert reference.words == ["And", "They", "say", "And", "They", "say", "That", "a", "hero", "can", "save", "us"]


def test_webvtt_may_omit_the_hours():
    # The last cue in VTT is `00:07.000 --> ...`: mm:ss, no hours field.
    reference = parse_reference(VTT)
    assert reference.cues[-1].start == 7.0
    assert reference.cues[-1].end == 10.0


def test_srt_timestamps_are_read_in_hours_minutes_and_milliseconds():
    reference = parse_reference(ROLLING_SRT)
    assert reference.cues[0].start == 1.0
    assert reference.cues[0].end == 4.0
    long_cue = parse_reference("1\n01:02:03,500 --> 01:02:04,250\nhi\n")
    assert long_cue.cues[0].start == 3723.5
    assert long_cue.cues[0].end == 3724.25


# --------------------------------------------------------------------------- #
# plain text
# --------------------------------------------------------------------------- #


def test_plain_text_drops_section_labels_and_keeps_sung_brackets():
    reference = parse_reference(PLAIN, name="plain.txt")
    assert reference.format == "text"
    assert reference.rolling is False
    keys = [match_key(w) for w in reference.words]
    assert "verse" not in keys and "chorus" not in keys, "a section label is not a lyric"
    assert "guitar" not in keys, "a section label in brackets is not a lyric either"
    assert "oh" in keys and "yeah" in keys, "(oh yeah) is sung; only known sections are dropped"
    assert "won't" in reference.words, "the sheet's own spelling and punctuation are kept"


def test_a_plain_sheet_keeps_its_line_structure():
    reference = parse_reference(PLAIN)
    assert reference.cues[0].start is None and reference.cues[0].end is None
    assert reference.cues[0].lines[0] == "someone told me love won't last forever"


# --------------------------------------------------------------------------- #
# matching, and refusing to guess
# --------------------------------------------------------------------------- #


def test_match_key_folds_away_the_disagreements_that_are_not_words():
    assert match_key("won't") == match_key("wont") == "wont"
    assert match_key("Love,") == match_key("love") == "love"
    assert match_key("—") == ""
    assert match_key("Ámbar") == "ámbar"


def test_punctuation_only_tokens_are_not_words():
    assert words("1\n00:00:01,000 --> 00:00:02,000\nhold — on ...\n") == ["hold", "on"]


def test_an_empty_file_is_an_error_not_an_empty_pass():
    for text in ("", "   \n\n  \n", "WEBVTT\n\nNOTE nothing here\n"):
        with pytest.raises(ReferenceParseError):
            Reference.from_text(text, name="empty.srt")


def test_a_missing_file_says_which_file(tmp_path):
    with pytest.raises(ReferenceParseError) as excinfo:
        Reference.from_file(tmp_path / "nope.srt")
    assert "nope.srt" in str(excinfo.value)


def test_from_text_records_the_shape_not_the_text():
    record = Reference.from_text(ROLLING_SRT, name="rolling.srt").to_dict()
    assert record == {
        "name": "rolling.srt",
        "format": "srt",
        "rolling": True,
        "cues": 4,
        "words": 10,
        "warnings": record["warnings"],
    }
    assert "words" in record and isinstance(record["words"], int), "a count, not a copy"


def test_a_txt_file_with_timestamps_in_it_is_still_read_as_subtitles():
    # Format detection looks at the content rather than the extension, because a
    # lyric file renamed to `.txt` is common and guessing the extension is wrong.
    renamed = parse_reference(ROLLING_SRT, name="lyrics.txt")
    assert renamed.format == "srt"
    assert renamed.rolling is True


def test_the_real_artifact_reads_as_255_words():
    """
    The project's own reference file, read by this parser.

    ``out/wer.py`` parses that same file by hand to score word error rate, and it
    counts 255 words. Agreement between the two is the whole point: the pass and the
    scorer have to mean the same thing by "the lyrics", or the score is measuring a
    different sheet than the one the pass used.
    """
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "referece_material" / "spidy.srt"
    if not path.exists():
        pytest.skip("the local reference material is not on disk")
    reference = Reference.from_file(path)
    assert reference.rolling is True
    assert len(reference.cues) == 40
    assert reference.word_count == 255
