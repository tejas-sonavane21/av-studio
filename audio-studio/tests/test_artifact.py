"""artifact.py — reading and writing ``*.speech.json``."""

from __future__ import annotations

import json

import pytest

from audio_studio import artifact
from audio_studio.model import Segment, Transcript, Word, normalize_transcript


def sample() -> Transcript:
    return normalize_transcript(
        Transcript(
            segments=[Segment(start=0.0, end=1.0, words=[Word("hello", 0.0, 1.0, 0.9)])],
            duration=5.0,
            language="en",
        )
    )


def test_save_then_load_round_trips(tmp_path):
    path = artifact.save(sample(), tmp_path / "clip.speech.json")
    assert artifact.load(path).to_dict() == sample().to_dict()


def test_save_creates_missing_directories(tmp_path):
    path = artifact.save(sample(), tmp_path / "deep" / "nested" / "clip.speech.json")
    assert path.exists()


def test_load_rejects_text_that_is_not_json(tmp_path):
    path = tmp_path / "bad.speech.json"
    path.write_text("not json at all", encoding="utf-8")
    with pytest.raises(artifact.ArtifactError, match="not valid JSON"):
        artifact.load(path)


def test_load_rejects_json_that_is_not_an_artifact(tmp_path):
    path = tmp_path / "other.json"
    path.write_text(json.dumps({"hello": "world"}), encoding="utf-8")
    with pytest.raises(artifact.ArtifactError, match="no 'segments' key"):
        artifact.load(path)


def test_load_rejects_a_list(tmp_path):
    path = tmp_path / "list.json"
    path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    with pytest.raises(artifact.ArtifactError, match="must be a JSON object"):
        artifact.load(path)


def test_load_refuses_a_newer_schema(tmp_path):
    """Better a clear error than a half-understood file."""
    data = sample().to_dict()
    data["schemaVersion"] = 99
    path = tmp_path / "future.speech.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(artifact.ArtifactError, match="newer than this build"):
        artifact.load(path)


def test_load_renormalises_a_hand_edited_artifact(tmp_path):
    """
    A hand-edited file is a legitimate input, so the invariants have to be
    re-established on the way in rather than trusted.
    """
    data = {
        "schemaVersion": 1,
        "segments": [
            {"start": 0.0, "end": 2.0, "text": "one", "words": [{"text": "one", "start": 0.0, "end": 2.0}]},
            {"start": 1.0, "end": 3.0, "text": "two", "words": [{"text": "two", "start": 1.0, "end": 3.0}]},
        ],
    }
    path = tmp_path / "edited.speech.json"
    path.write_text(json.dumps(data), encoding="utf-8")

    loaded = artifact.load(path)
    assert loaded.segments[1].start == 2.0
    assert loaded.segments[1].text == "two"


def test_load_from_data_accepts_a_dict_directly():
    assert artifact.from_data(sample().to_dict()).word_count == 1
