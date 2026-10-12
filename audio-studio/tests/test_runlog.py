"""
runlog.py — the record a run leaves behind, and the menu that reads it back.

The manifest is a *contract between two processes*: the command line writes it, and
`caption-studio` (or anything else with access to the folder) reads it to find a run
without being told a path. So it is tested as one: the shape is asserted field by
field, the reader is asserted to round-trip that shape, and the CLI is asserted to
write it at all — because the failure mode here is silence, not an exception.
"""

from __future__ import annotations

import json
import sys

import pytest

from audio_studio import cli
from audio_studio.model import Segment, Transcript, Word
from audio_studio.runlog import (
    SUFFIX,
    build_manifest,
    describe,
    find_manifests,
    manifest_path,
    read_manifest,
    write_manifest,
)


def transcript() -> Transcript:
    words = [Word(text="hello", start=0.0, end=0.5, probability=0.9), Word(text="world", start=0.6, end=1.1)]
    return Transcript(
        language="en",
        duration=12.5,
        segments=[Segment(start=0.0, end=1.1, words=words)],
        engine={"name": "fake"},
    )


class FakeAudio:
    """The part of `media.Audio` the manifest reads."""

    def __init__(self, path, sha256="a" * 64, duration=12.5, decoded_by="pyav"):
        self.path = path
        self.sha256 = sha256
        self.duration = duration
        self.decoded_by = decoded_by


def test_the_manifest_names_the_files_it_produced(tmp_path):
    written = []
    for name in ("song.srt", "song.vtt", "song.veed.json", "song.speech.json"):
        path = tmp_path / name
        path.write_text("x", encoding="utf-8")
        written.append(path)

    manifest = build_manifest(transcript(), stem="song", outputs=written)

    assert manifest["schemaVersion"] == 1
    assert manifest["tool"] == "audio-studio"
    assert [entry["file"] for entry in manifest["outputs"]] == [
        "song.srt",
        "song.vtt",
        "song.veed.json",
        "song.speech.json",
    ]
    assert [entry["kind"] for entry in manifest["outputs"]] == ["srt", "vtt", "veed", "speech"]
    assert all(entry["bytes"] == 1 for entry in manifest["outputs"])


def test_the_summary_is_what_a_menu_wants_to_show(tmp_path):
    manifest = build_manifest(transcript(), stem="song", outputs=[])
    assert manifest["summary"]["segments"] == 1
    assert manifest["summary"]["words"] == 2
    assert manifest["summary"]["durationSeconds"] == 12.5
    assert manifest["summary"]["language"] == "en"


def test_the_source_is_recorded_with_the_hash_that_identifies_it(tmp_path):
    """
    The same SHA-256 the artifact carries. Two transcripts that disagree over the same
    bytes are then a real disagreement — the point of hashing the audio at all.
    """
    source = FakeAudio(tmp_path / "song.mp3")
    (tmp_path / "song.mp3").write_bytes(b"0123456789")

    manifest = build_manifest(transcript(), stem="song", outputs=[], source=source)

    assert manifest["source"]["file"] == "song.mp3"
    assert manifest["source"]["sha256"] == "a" * 64
    assert manifest["source"]["bytes"] == 10
    assert manifest["source"]["decodedBy"] == "pyav"


def test_a_run_that_read_nothing_says_so_rather_than_guessing(tmp_path):
    """A re-emit never saw the recording. A manifest that invented a source would be worse."""
    manifest = build_manifest(transcript(), stem="song", outputs=[])
    assert manifest["source"] is None


def test_the_manifest_round_trips_through_a_file(tmp_path):
    manifest = build_manifest(transcript(), stem="song", outputs=[], command="audio-studio transcribe song.mp3")
    path = write_manifest(tmp_path, "song", manifest)

    assert path == manifest_path(tmp_path, "song")
    assert path.name == f"song{SUFFIX}"
    assert read_manifest(path)["command"] == "audio-studio transcribe song.mp3"
    # ...and json on disk, not a Python repr
    assert json.loads(path.read_text(encoding="utf-8"))["tool"] == "audio-studio"


def test_a_file_that_is_not_a_manifest_is_not_mistaken_for_one(tmp_path):
    other = tmp_path / "caproj.run.json"
    other.write_text('{"tool": "caption-studio"}', encoding="utf-8")
    assert read_manifest(other) is None


def test_a_broken_manifest_is_skipped_rather_than_thrown(tmp_path):
    (tmp_path / "a.run.json").write_text("{not json", encoding="utf-8")
    assert read_manifest(tmp_path / "a.run.json") is None
    assert find_manifests(tmp_path) == []


def test_finding_runs_reads_both_layouts_newest_first(tmp_path):
    """
    The server writes one folder per job and the command line writes one flat folder.
    A reader that understood only one of the two would work in only one mode.
    """
    flat = build_manifest(transcript(), stem="old", outputs=[], created="2026-10-01T00:00:00+00:00")
    write_manifest(tmp_path, "old", flat)
    job = tmp_path / "0f00d" / "new.run.json"
    job.parent.mkdir()
    job.write_text(
        json.dumps(build_manifest(transcript(), stem="new", outputs=[], created="2026-10-12T10:00:00+00:00")),
        encoding="utf-8",
    )

    found = find_manifests(tmp_path)

    assert [entry["stem"] for entry in found] == ["new", "old"], "newest first"
    assert found[0]["directory"] == "0f00d"
    assert found[0]["manifest"] == "0f00d/new.run.json"
    assert found[1]["directory"] == "."


def test_finding_runs_in_a_folder_that_is_not_there_is_empty_not_an_error(tmp_path):
    assert find_manifests(tmp_path / "nope") == []


def test_the_limit_keeps_the_newest(tmp_path):
    for day in ("01", "02", "03"):
        write_manifest(
            tmp_path,
            f"run{day}",
            build_manifest(transcript(), stem=f"run{day}", outputs=[], created=f"2026-10-{day}T00:00:00+00:00"),
        )
    assert [m["stem"] for m in find_manifests(tmp_path, limit=2)] == ["run03", "run02"]


def test_describe_survives_a_partial_manifest():
    assert "segments" in describe({"summary": {"segments": 3, "words": 9}, "source": {"file": "x.mp3"}})
    assert "a run" in describe({})


# --------------------------------------------------------------------------- #
# the command line writes one
# --------------------------------------------------------------------------- #


def test_transcribe_leaves_a_manifest_beside_its_outputs(wav_file, tmp_path, capsys):
    out = tmp_path / "out"
    code = cli.main(
        ["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "--stem", "song"]
    )
    assert code == 0
    manifest = read_manifest(out / "song.run.json")
    assert manifest is not None, "the run was not recorded"
    # `--no-decode` still reads the file's metadata and hash, and the manifest says so
    # by naming the decoder as nothing rather than by inventing one.
    assert manifest["source"]["file"] == wav_file.name
    assert manifest["source"]["decodedBy"] is None
    assert manifest["source"]["sha256"], "the hash is what ties the record to the bytes"
    assert manifest["summary"]["segments"] >= 1
    # The default bundle, in the order it is written, each file named for what it is.
    assert [entry["kind"] for entry in manifest["outputs"]] == ["speech", "veed", "srt", "vtt"]
    assert "manifest" in capsys.readouterr().out


def test_the_manifest_records_the_command_that_was_run(wav_file, tmp_path):
    out = tmp_path / "out"
    cli.main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out)])
    manifest = read_manifest(out / f"{wav_file.stem}.run.json")
    assert manifest["command"].startswith("audio-studio transcribe")
    assert "--engine fake" in manifest["command"]


def test_emit_over_the_same_stem_replaces_the_manifest_rather_than_writing_a_second(wav_file, tmp_path):
    out = tmp_path / "out"
    cli.main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "--emit", "json"])
    first = read_manifest(out / f"{wav_file.stem}.run.json")
    cli.main(["emit", str(out / f"{wav_file.stem}.speech.json"), "--out", str(out), "--emit", "srt"])
    second = read_manifest(out / f"{wav_file.stem}.run.json")

    assert first is not None and second is not None
    assert [entry["kind"] for entry in second["outputs"]] == ["srt"]
    assert second["command"].startswith("audio-studio emit")
    assert list(out.glob(f"*{SUFFIX}")) == [out / f"{wav_file.stem}.run.json"]


def test_a_manifest_is_written_even_when_the_console_cannot_print_it(wav_file, tmp_path, monkeypatch, capsys):
    """
    The output path is printed, and on a Windows console with a legacy code page a path
    with a non-ASCII character can raise on `print`. The run's *artifacts* must not depend
    on the console being able to describe them, so the manifest is written first.
    """
    out = tmp_path / "out"

    def refuse(*args, **kwargs):
        raise UnicodeEncodeError("cp1252", "x", 0, 1, "no")

    monkeypatch.setattr(sys.stdout, "write", refuse)
    # Windows keeps a legacy code page in a lot of consoles, and a path with a
    # non-ASCII character in it really does raise here. What matters is that the
    # *record* of the run was already on disk when the console failed to describe it.
    with pytest.raises(UnicodeEncodeError):
        cli.main(["transcribe", str(wav_file), "--engine", "fake", "--no-decode", "--out", str(out), "-q"])
    capsys.readouterr()
    assert (out / f"{wav_file.stem}.run.json").is_file()
    assert (out / f"{wav_file.stem}.srt").is_file()
