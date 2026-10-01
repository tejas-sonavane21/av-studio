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


def test_every_subcommand_is_registered():
    parser = build_parser()
    actions = [a for a in parser._actions if hasattr(a, "choices") and a.choices]
    subcommands = set()
    for action in actions:
        if hasattr(action, "_name_parser_map"):
            subcommands |= set(action._name_parser_map)
    assert subcommands == {"transcribe", "emit", "doctor", "serve", "version"}


def test_serve_is_wired_to_a_handler():
    args = build_parser().parse_args(["serve", "--port", "9000"])
    assert args.port == 9000
    assert callable(args.func)


def test_native_module_is_importable_for_tests():
    assert native.KIND == "json"
