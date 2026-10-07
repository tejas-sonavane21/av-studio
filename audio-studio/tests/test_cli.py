"""cli.py — the command line, end to end, with no model and no network."""

from __future__ import annotations

import json

import pytest

from audio_studio import __version__
from audio_studio.cli import build_parser, main
from audio_studio.emit import native


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# trivial commands
# --------------------------------------------------------------------------- #


def test_version(capsys):
    assert main(["version"]) == 0
    assert capsys.readouterr().out.strip() == __version__


def test_doctor_json_is_machine_readable(capsys):
    assert main(["doctor", "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["audioStudio"] == __version__
    assert {e["name"] for e in report["engines"]} == {"fake", "whisper"}
    assert report["cpuCount"] >= 1
    assert "accurate" in report["presets"]


def test_doctor_prints_a_human_report(capsys):
    assert main(["doctor"]) == 0
    out = capsys.readouterr().out
    assert "audio-studio" in out
    assert "engines" in out
    assert "virtualenv" in out


# --------------------------------------------------------------------------- #
# transcribe
# --------------------------------------------------------------------------- #


def test_transcribe_writes_every_default_format(wav_file, tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out)]) == 0

    names = sorted(p.name for p in out.iterdir())
    assert names == ["clip.speech.json", "clip.srt", "clip.veed.json", "clip.vtt"]
    assert "transcribed" in capsys.readouterr().out


def test_transcribe_json_summary_is_parseable(wav_file, tmp_path, capsys):
    out = tmp_path / "out"
    code = main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "--json", "-q"])
    assert code == 0

    summary = json.loads(capsys.readouterr().out)
    assert summary["segments"] >= 1
    assert summary["words"] > 0
    assert len(summary["files"]) == 4
    assert summary["engine"]["name"] == "fake"


def test_transcribe_output_imports_as_a_caption_document(wav_file, tmp_path):
    """
    The end-to-end promise: the Veed-shaped file we write must carry the exact
    keys caption-studio's importer reads, and its word texts must join back to
    the line.
    """
    out = tmp_path / "out"
    assert main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out)]) == 0

    data = read(out / "clip.veed.json")
    assert data["canvas"] and data["subtitles"]
    for subtitle in data["subtitles"]:
        assert isinstance(subtitle["start"], (int, float))
        assert isinstance(subtitle["end"], (int, float))
        words = [w["text"] for w in subtitle["words"]]
        assert words and all(isinstance(t, str) and t for t in words)
        assert all("s" in w and "e" in w for w in subtitle["words"])


def test_transcribe_does_not_enable_vad_unless_asked(wav_file, tmp_path):
    """VAD deletes sung vocals, so it must stay off through the whole CLI path."""
    out = tmp_path / "out"
    assert main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "-q"]) == 0
    assert read(out / "clip.speech.json")["engine"]["vadFilter"] is False

    out2 = tmp_path / "out2"
    main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out2), "--vad", "-q"])
    assert read(out2 / "clip.speech.json")["engine"]["vadFilter"] is True


def test_transcribe_stem_can_be_overridden(wav_file, tmp_path):
    out = tmp_path / "out"
    main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "--stem", "song", "-q"])
    assert (out / "song.speech.json").exists()


def test_transcribe_respects_an_emit_subset(wav_file, tmp_path):
    out = tmp_path / "out"
    main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "--emit", "srt", "-q"])
    assert [p.name for p in out.iterdir()] == ["clip.srt"]


def test_transcribe_word_level_and_emphasis(wav_file, tmp_path):
    out = tmp_path / "out"
    main(
        [
            "transcribe", str(wav_file), "--engine", "fake", "--no-decode",
            "--out", str(out), "--emit", "veed,srt", "--word-level", "--emphasis", "all", "-q",
        ]
    )
    assert (out / "clip.srt").read_text(encoding="utf-8").count("-->") > 3
    assert read(out / "clip.veed.json")["subtitles"][0]["styles"][0]["id"] == "auto-highlight"


def test_transcribe_reports_a_missing_file_without_a_traceback(tmp_path, capsys):
    assert main(["transcribe", str(tmp_path / "nope.mp3"), "--engine", "fake"]) == 1
    assert "not found" in capsys.readouterr().err


def test_an_unknown_emit_kind_is_a_usage_error():
    with pytest.raises(SystemExit) as exc:
        main(["transcribe", "x.wav", "--emit", "ass"])
    assert exc.value.code == 2


def test_an_unknown_engine_is_a_usage_error():
    with pytest.raises(SystemExit) as exc:
        main(["transcribe", "x.wav", "--engine", "elevenlabs"])
    assert exc.value.code == 2


# --------------------------------------------------------------------------- #
# emit
# --------------------------------------------------------------------------- #


def test_emit_regenerates_formats_from_a_saved_artifact(wav_file, tmp_path):
    first = tmp_path / "first"
    main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(first), "--emit", "json", "-q"])

    second = tmp_path / "second"
    artifact_path = first / "clip.speech.json"
    assert main(["emit", str(artifact_path), "--out", str(second), "--emit", "srt,vtt", "--stem", "clip"]) == 0
    assert sorted(p.name for p in second.iterdir()) == ["clip.srt", "clip.vtt"]


def test_emit_of_a_broken_artifact_fails_cleanly(tmp_path, capsys):
    bad = tmp_path / "bad.speech.json"
    bad.write_text("{ not json", encoding="utf-8")
    assert main(["emit", str(bad)]) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_emit_round_trips_the_native_artifact_unchanged(wav_file, tmp_path):
    out = tmp_path / "out"
    main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "--emit", "json", "-q"])
    again = tmp_path / "again"
    main(["emit", str(out / "clip.speech.json"), "--out", str(again), "--emit", "json", "--stem", "clip"])
    assert read(again / "clip.speech.json") == read(out / "clip.speech.json")


# --------------------------------------------------------------------------- #
# parser shape
# --------------------------------------------------------------------------- #


def test_transcribe_runs_the_optional_passes_when_asked(wav_file, tmp_path, capsys):
    out = tmp_path / "out"
    code = main(
        [
            "transcribe", str(wav_file), "--engine", "fake", "--no-decode",
            "--align", "fake", "--validate", "rules", "--out", str(out),
        ]
    )
    assert code == 0
    printed = capsys.readouterr().out
    assert "alignment" in printed and "validation" in printed

    data = json.loads((out / "clip.speech.json").read_text(encoding="utf-8"))
    assert data["alignment"]["aligner"] == "fake"
    assert data["validation"]["passes"][0]["validator"] == "rules"


def test_align_re_times_a_saved_artifact_without_rewording_it(wav_file, tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "-q"]) == 0
    capsys.readouterr()  # drop the transcribe summary; only the align JSON is under test
    artifact = out / "clip.speech.json"
    before = json.loads(artifact.read_text(encoding="utf-8"))

    code = main(
        [
            "align", str(artifact), "--audio", str(wav_file), "--no-decode", "--align", "fake",
            "--out", str(out), "--emit", "json", "-q", "--json",
        ]
    )
    assert code == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["alignment"]["aligner"] == "fake"
    assert summary["alignment"]["segmentsAligned"] >= 1

    after = json.loads(artifact.read_text(encoding="utf-8"))
    words_before = [(w["text"], w["start"]) for s in before["segments"] for w in s["words"]]
    words_after = [(w["text"], w["start"]) for s in after["segments"] for w in s["words"]]
    assert [text for text, _ in words_after] == [text for text, _ in words_before]
    assert words_after != words_before
    assert after["stats"] == before["stats"]


def test_validate_records_a_ledger_for_a_saved_artifact(wav_file, tmp_path, capsys):
    out = tmp_path / "out"
    assert main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "-q"]) == 0
    capsys.readouterr()  # drop the transcribe summary; only the validate JSON is under test
    code = main(
        ["validate", str(out / "clip.speech.json"), "--validate", "rules", "--out", str(out), "--emit", "json", "-q", "--json"]
    )
    assert code == 0
    summary = json.loads(capsys.readouterr().out)
    record = summary["validation"]["passes"][0]
    assert record["validator"] == "rules"
    assert record["corrections"] == len(summary["corrections"])
    # The offline validator reports; it never proposes a replacement, so a
    # ledger entry from it can only ever be a finding.
    assert all(entry["outcome"] == "reported" for entry in summary["corrections"])
    assert all(entry["applied"] is False and "to" not in entry for entry in summary["corrections"])


def test_align_asks_its_audio_to_be_given():
    """The command is meaningless without the recording it is aligning against."""
    with pytest.raises(SystemExit):
        build_parser().parse_args(["align", "out/x.speech.json"])


def test_a_pass_that_needs_the_audio_says_so_rather_than_guessing(wav_file, tmp_path, capsys):
    artifact = tmp_path / "x.speech.json"
    artifact.write_text(native.render(_sample_transcript()), encoding="utf-8")
    # --no-decode leaves no samples behind, and a real aligner listens to the audio.
    code = main(["align", str(artifact), "--audio", str(wav_file), "--no-decode", "--out", str(tmp_path), "-q"])
    assert code == 1
    stderr = capsys.readouterr().err
    assert "aligner" in stderr
    assert "audio-studio:" in stderr


def _sample_transcript():
    from audio_studio.model import Segment, Transcript, Word

    words = [Word(text="we", start=0.0, end=0.4), Word(text="rise", start=0.4, end=0.9)]
    return Transcript.from_segments([Segment(start=0.0, end=0.9, words=words)], language="en", duration=2.0)


def test_every_subcommand_is_registered():
    parser = build_parser()
    actions = [a for a in parser._actions if hasattr(a, "choices") and a.choices]
    subcommands = set()
    for action in actions:
        if hasattr(action, "_name_parser_map"):
            subcommands |= set(action._name_parser_map)
    assert subcommands == {"transcribe", "emit", "align", "validate", "doctor", "serve", "version"}


def test_serve_is_wired_to_a_handler():
    args = build_parser().parse_args(["serve", "--port", "9000"])
    assert args.port == 9000
    assert callable(args.func)


def test_native_module_is_importable_for_tests():
    assert native.KIND == "json"


# --------------------------------------------------------------------------- #
# --reference: the original lyrics
# --------------------------------------------------------------------------- #

#: The fake engine says exactly this (``engines/fake.py``, ``DEFAULT_LINES``), so a
#: reference built from it with different punctuation and one extra word is a
#: transcript that reconciles: everything matches on spelling, and one word is new.
LYRICS = """We rise before the morning light,
And carry every promise that we made along the long way home,
The road taught us how to wait
forever
"""

FAKE_LINE_WORDS = 6 + 13 + 6


def test_transcribe_with_the_original_lyrics_takes_the_words_from_the_file(wav_file, tmp_path, capsys):
    """
    End to end through the CLI: the words come from the file, the count is the file's,
    and the artifact says which file and how well it matched.
    """
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text(LYRICS, encoding="utf-8")
    out = tmp_path / "out"

    code = main(
        [
            "transcribe", str(wav_file), "--engine", "fake", "--no-decode",
            "--out", str(out), "--reference", str(lyrics), "-q",
        ]
    )
    assert code == 0
    speech = read(out / "clip.speech.json")

    reference = speech["reference"]
    assert reference["outcome"] == "applied"
    assert reference["name"] == "lyrics.txt"
    assert reference["words"] == FAKE_LINE_WORDS + 1
    assert reference["counts"]["inserted"] == 1
    assert speech["stats"]["words"] == FAKE_LINE_WORDS + 1

    first_block = speech["segments"][0]
    assert first_block["text"].startswith("We rise before the morning light,"), "the file's punctuation wins"


def test_the_cli_reports_what_the_reference_pass_did(wav_file, tmp_path, capsys):
    lyrics = tmp_path / "lyrics.txt"
    lyrics.write_text(LYRICS, encoding="utf-8")
    main(
        [
            "transcribe", str(wav_file), "--engine", "fake", "--no-decode",
            "--out", str(tmp_path / "out"), "--reference", str(lyrics), "-q",
        ]
    )
    out = capsys.readouterr().out
    assert "reference" in out and "applied" in out and "1 inserted" in out


def test_an_unreadable_reference_fails_before_anything_is_written(wav_file, tmp_path, capsys):
    """
    A lyric file that cannot be read is a typo on the command line. It must fail the
    run — not quietly pass as "no reference" — and it must fail *before* the
    transcription, which is the slow part.
    """
    out = tmp_path / "out"
    code = main(
        [
            "transcribe", str(wav_file), "--engine", "fake", "--no-decode",
            "--out", str(out), "--reference", str(tmp_path / "nope.srt"), "-q",
        ]
    )
    assert code == 1
    assert "nope.srt" in capsys.readouterr().err
    assert not out.exists() or not list(out.glob("*"))


def test_a_reference_for_another_song_is_refused_and_says_so(wav_file, tmp_path, capsys):
    lyrics = tmp_path / "other.txt"
    lyrics.write_text("kangaroo wallaby wombat\n", encoding="utf-8")
    out = tmp_path / "out"
    assert main(
        [
            "transcribe", str(wav_file), "--engine", "fake", "--no-decode",
            "--out", str(out), "--reference", str(lyrics), "-q",
        ]
    ) == 0

    speech = read(out / "clip.speech.json")
    assert speech["reference"]["outcome"] == "refused"
    assert speech["stats"]["words"] == FAKE_LINE_WORDS, "a refusal changes nothing"
    assert any("refused" in warning for warning in speech["warnings"])


def test_the_reference_flag_is_on_transcribe_align_and_validate():
    for argv in (["transcribe", "x.wav"], ["align", "x.json", "--audio", "x.wav"], ["validate", "x.json"]):
        args = build_parser().parse_args([*argv, "--reference", "lyrics.srt"])
        assert args.reference == "lyrics.srt"
        assert args.reference_min_match == 0.5
