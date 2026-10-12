"""emit naming — the stem every output name is built from."""

from __future__ import annotations

import pytest

from audio_studio.emit import filename, safe_stem, write_bundle
from audio_studio.model import Segment, Transcript, Word


def line(start, end, words) -> Segment:
    return Segment(start=start, end=end, words=[Word(t, s, e) for t, s, e in words])


@pytest.mark.parametrize(
    "given,expected",
    [
        ("song", "song"),
        ("Take 2 final", "Take 2 final"),
        # A path is not a name: the whole point is that the last segment is taken and
        # the climb out of the output folder is gone.
        ("../../notes/attack", "attack"),
        ("..\\..\\notes\\attack", "attack"),
        ("/etc/passwd", "passwd"),
        ("C:\\Users\\me\\song.mp3", "song.mp3"),
        # Windows refuses these outright, and the run used to die on the write.
        ("take 2: final?", "take 2_ final_"),
        ("a|b<c>d", "a_b_c_d"),
        ("trailing dots...", "trailing dots"),
        ("  spaced  out  ", "spaced out"),
        ("", "transcript"),
        ("...", "transcript"),
        (None, "transcript"),
    ],
)
def test_a_stem_cannot_escape_its_folder_or_break_a_filesystem(given, expected):
    assert safe_stem(given) == expected


def test_a_stem_is_bounded_in_length():
    assert len(safe_stem("x" * 400)) == 80
    assert safe_stem("y" * 400).startswith("y" * 80)


def test_the_fallback_is_the_caller_s():
    assert safe_stem("///", "source") == "source"


def test_every_output_name_goes_through_the_same_rule():
    assert filename("srt", "../../evil") == "evil.srt"
    assert filename("veed", "a:b") == "a_b.veed.json"


def test_write_bundle_cannot_be_talked_out_of_its_directory(tmp_path):
    transcript = Transcript(segments=[line(0.0, 1.0, [("hi", 0.0, 1.0)])], duration=1.0)
    written = write_bundle(transcript, tmp_path / "out", stem="../../escape", kinds_selected=("srt",))

    assert [p.name for p in written] == ["escape.srt"]
    assert written[0].parent == tmp_path / "out"
    assert not (tmp_path / "escape.srt").exists()
