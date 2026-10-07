"""emit/ — output formats, and the contract caption-studio's importer relies on."""

from __future__ import annotations

import json

import pytest

from audio_studio import emit
from audio_studio.emit._time import format_timestamp
from audio_studio.model import Segment, Transcript, Word, normalize_transcript


def sample() -> Transcript:
    return normalize_transcript(
        Transcript(
            segments=[
                Segment(
                    start=1.23,
                    end=3.45,
                    words=[Word("hello", 1.23, 2.0, 0.91), Word("world", 2.0, 3.45, 0.88)],
                ),
                Segment(start=5.0, end=6.5, words=[Word("again", 5.0, 6.5, 0.77)]),
            ],
            duration=10.0,
            language="en",
            engine={"name": "fake"},
        )
    )


# --------------------------------------------------------------------------- #
# timestamps
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (0, "00:00:00,000"),
        (1.23, "00:00:01,230"),
        (83.5, "00:01:23,500"),
        (3661.001, "01:01:01,001"),
        (-5, "00:00:00,000"),
        (float("nan"), "00:00:00,000"),
    ],
)
def test_format_timestamp(seconds, expected):
    assert format_timestamp(seconds) == expected


def test_format_timestamp_separator_for_vtt():
    assert format_timestamp(1.5, ".") == "00:00:01.500"


# --------------------------------------------------------------------------- #
# SRT / VTT
# --------------------------------------------------------------------------- #


def test_srt_output_is_exact():
    assert emit.render("srt", sample()) == (
        "1\n00:00:01,230 --> 00:00:03,450\nhello world\n\n"
        "2\n00:00:05,000 --> 00:00:06,500\nagain\n\n"
    )


def test_srt_word_level_gives_one_cue_per_word():
    text = emit.render("srt", sample(), word_level=True)
    assert text.count("-->") == 3
    assert "hello" in text and "world" in text and "again" in text


def test_vtt_has_the_required_header_and_dot_separator():
    text = emit.render("vtt", sample())
    assert text.startswith("WEBVTT\n\n")
    assert "00:00:01.230 --> 00:00:03.450" in text


def test_vtt_word_level_uses_inline_timestamps():
    text = emit.render("vtt", sample(), word_level=True)
    assert "<00:00:01.230>hello" in text


# --------------------------------------------------------------------------- #
# the caption-studio bridge
# --------------------------------------------------------------------------- #


def test_veed_output_carries_the_keys_caption_studios_importer_reads():
    """
    Mirrors ``caption-studio/src/io/veed-json.js``:
    ``detectVeedVersion`` needs ``canvas``; blocks read ``sub.start``/``sub.end``;
    words read ``w.text``/``w.s``/``w.e``.
    """
    data = emit.veed.to_veed_master(sample())
    assert isinstance(data["canvas"], dict) and data["canvas"]["width"] == 1280
    assert data["version"] == "3.0"
    assert len(data["subtitles"]) == 2

    first = data["subtitles"][0]
    assert first["start"] == 1.23 and first["end"] == 3.45
    assert [w["text"] for w in first["words"]] == ["hello", "world"]
    assert [w["s"] for w in first["words"]] == [1.23, 2.0]
    assert [w["e"] for w in first["words"]] == [2.0, 3.45]
    assert first["styles"] == []


def test_veed_word_texts_join_back_to_the_segment_text():
    """
    The importer rebuilds the line as ``words.map(w => w.text).join(' ')``, so a
    word list that does not join back to the text loses or invents a space.
    """
    transcript = sample()
    for subtitle, segment in zip(emit.veed.to_veed_master(transcript)["subtitles"], transcript.segments):
        assert " ".join(w["text"] for w in subtitle["words"]) == segment.text


def test_veed_style_matches_caption_studios_parity_defaults():
    """
    The importer copies these five values onto its own ``createDefaultStyle()``.
    Emitting the verified Veed parity numbers is what lets the imported document
    report itself as unedited instead of silently looking like a style change.
    """
    style = emit.veed.to_veed_master(sample())["style"]
    assert style == {"font": "Inter", "fontSize": 0.036, "posX": 0.772, "posY": 0.848, "align": "center"}


def test_veed_style_can_be_omitted():
    assert "style" not in emit.veed.to_veed_master(sample(), include_style=False)


def test_veed_emphasis_defaults_to_inventing_nothing():
    assert emit.veed.to_veed_master(sample())["subtitles"][0]["styles"] == []


def test_veed_emphasis_all_covers_the_whole_line():
    styles = emit.veed.to_veed_master(sample(), emphasis="all")["subtitles"][0]["styles"]
    assert len(styles) == 1
    assert (styles[0]["from"], styles[0]["to"]) == (0, len("hello world"))
    assert styles[0]["id"] == "auto-highlight"
    assert styles[0]["style"] == emit.veed.EMPHASIS_STYLE


def test_veed_emphasis_rejects_an_unknown_mode():
    with pytest.raises(ValueError):
        emit.veed.to_veed_master(sample(), emphasis="keywords")


def test_veed_emphasis_auto_writes_one_range_per_chosen_word():
    """
    ``auto`` turns the LLM validator's picks into the Veed char-ranges the caption
    editor reads as emphasis — always as a *selection*, never the whole line.
    """
    transcript = sample()
    transcript.validation = {"passes": [{"validator": "llm", "highlights": [1]}]}
    first = emit.veed.to_veed_master(transcript, emphasis="auto")["subtitles"][0]
    assert len(first["styles"]) == 1
    # "world" is the second word of "hello world": characters 6..11
    assert (first["styles"][0]["from"], first["styles"][0]["to"]) == (6, 11)
    assert first["styles"][0]["id"] == "auto-highlight"
    assert first["styles"][0]["style"] == emit.veed.EMPHASIS_STYLE


def test_veed_emphasis_auto_keeps_a_pick_in_its_own_segment():
    transcript = sample()
    transcript.validation = {"passes": [{"validator": "llm", "highlights": [2]}]}  # 'again'
    subtitles = emit.veed.to_veed_master(transcript, emphasis="auto")["subtitles"]
    assert subtitles[0]["styles"] == []
    assert len(subtitles[1]["styles"]) == 1
    assert (subtitles[1]["styles"][0]["from"], subtitles[1]["styles"][0]["to"]) == (0, 5)


def test_veed_emphasis_auto_without_picks_invents_nothing():
    subtitles = emit.veed.to_veed_master(sample(), emphasis="auto")["subtitles"]
    assert all(subtitle["styles"] == [] for subtitle in subtitles)


def test_highlight_indices_union_every_pass_and_ignore_junk():
    transcript = sample()
    transcript.validation = {"passes": [{"highlights": [0]}, {"highlights": [1, "x", None]}, {}]}
    assert emit.veed.highlight_indices(transcript) == {0, 1}
    assert emit.veed.highlight_indices(sample()) == set()


def test_veed_probability_is_optional():
    with_probability = emit.veed.to_veed_master(sample())["subtitles"][0]["words"][0]
    without = emit.veed.to_veed_master(sample(), include_probability=False)["subtitles"][0]["words"][0]
    assert with_probability["p"] == 0.91
    assert "p" not in without


def test_veed_declares_its_provenance_without_breaking_the_importer():
    """Extra keys are ignored by the importer, so provenance is free."""
    data = emit.veed.to_veed_master(sample())
    assert data["generator"].startswith("audio-studio/")
    assert data["engine"] == {"name": "fake"}


def test_veed_carries_the_passes_ledger_in_a_namespace_of_our_own():
    """
    This is the one file that crosses between the two studios, so it is the one
    that has to say where its timings came from and what the validation did. It
    lives under ``audioStudio`` so no Veed field can ever collide with it, and
    ``parseVeedJSON`` ignores unknown keys, so the bridge pays nothing for it.
    """
    transcript = sample()
    transcript.alignment = {"aligner": "wav2vec", "segmentsAligned": 2}
    transcript.validation = {"passes": [{"validator": "llm", "applied": 1}]}
    transcript.corrections = [{"index": 0, "from": "wae", "to": "we", "applied": True}]
    transcript.warnings = ["a quiet stretch"]

    data = emit.veed.to_veed_master(transcript)
    audit = data["audioStudio"]
    assert audit["alignment"]["aligner"] == "wav2vec"
    assert audit["validation"]["passes"][0]["validator"] == "llm"
    assert audit["corrections"][0]["to"] == "we"
    assert audit["warnings"] == ["a quiet stretch"]
    assert audit["language"] == transcript.language
    assert "alignment" not in data  # namespaced, not smeared across the document


# --------------------------------------------------------------------------- #
# native + registry + bundle
# --------------------------------------------------------------------------- #


def test_native_output_round_trips_through_the_model():
    text = emit.render("json", sample())
    assert Transcript.from_dict(json.loads(text)).to_dict() == sample().to_dict()


def test_native_output_is_valid_json_with_a_schema_version():
    data = json.loads(emit.render("json", sample()))
    assert data["schemaVersion"] == 1
    assert data["stats"] == {"segments": 2, "words": 3, "speechDuration": 3.72, "speechRatio": 0.372}


def test_registry_lists_every_format():
    assert sorted(emit.kinds()) == ["json", "srt", "veed", "vtt"]
    assert "veed" in emit.DEFAULT_KINDS


def test_unknown_kind_is_a_clear_error():
    with pytest.raises(ValueError, match="unknown emit kind"):
        emit.render("ass", sample())


def test_extensions_are_distinct():
    assert emit.extension("json") == ".speech.json"
    assert emit.extension("veed") == ".veed.json"
    assert emit.extension("srt") == ".srt"
    assert emit.extension("vtt") == ".vtt"


def test_write_bundle_writes_every_requested_format(tmp_path):
    written = emit.write_bundle(sample(), tmp_path, stem="clip")
    names = sorted(p.name for p in written)
    assert names == ["clip.speech.json", "clip.srt", "clip.veed.json", "clip.vtt"]
    assert all(p.exists() and p.read_text(encoding="utf-8") for p in written)


def test_write_bundle_honours_a_subset(tmp_path):
    written = emit.write_bundle(sample(), tmp_path / "nested", stem="clip", kinds_selected=["srt"])
    assert [p.name for p in written] == ["clip.srt"]
    assert written[0].parent.name == "nested"


def test_write_bundle_is_byte_identical_across_runs(tmp_path):
    first = emit.write_bundle(sample(), tmp_path / "a", stem="clip")
    second = emit.write_bundle(sample(), tmp_path / "b", stem="clip")
    for left, right in zip(first, second):
        assert left.read_text(encoding="utf-8") == right.read_text(encoding="utf-8")
