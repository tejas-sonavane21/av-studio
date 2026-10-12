"""pins.py — the requirements file against what is installed."""

from __future__ import annotations

from pathlib import Path

from audio_studio.pins import compare, installed_versions, read_pins, requirements_path

SAMPLE = """\
# a comment
--extra-index-url https://download.pytorch.org/whl/cpu
faster-whisper==1.2.1
av==18.1.0
# torch==2.14.1+cpu   <- commented out, so not a pin
numpy>=2.0            # a floor is not a pin
httpx==0.28.1 ; python_version >= "3.11"

# and this one is the whole reason the file exists
transformers==5.18.0
"""


def write(tmp_path: Path, text: str) -> Path:
    target = tmp_path / "requirements.txt"
    target.write_text(text, encoding="utf-8")
    return target


def test_only_equality_is_a_pin(tmp_path):
    pins = read_pins(write(tmp_path, SAMPLE))
    assert pins == {
        "faster-whisper": "1.2.1",
        "av": "18.1.0",
        "httpx": "0.28.1",
        "transformers": "5.18.0",
    }


def test_comments_blank_lines_and_index_urls_are_skipped(tmp_path):
    pins = read_pins(write(tmp_path, "# nothing here\n\n--extra-index-url https://x\n"))
    assert pins == {}


def test_a_missing_file_is_no_pins_rather_than_an_error(tmp_path):
    assert read_pins(tmp_path / "nowhere.txt") == {}
    assert requirements_path(tmp_path) is None


def test_the_three_outcomes_are_three_different_fixes():
    rows = compare(
        {"av": "18.1.0", "faster-whisper": "1.2.1", "torch": "2.14.1+cpu"},
        {"av": "19.0.1", "faster-whisper": "1.2.1", "torch": None},
    )
    by_name = {row["name"]: row for row in rows}

    # The one that changes behaviour: a newer `av` removed a keyword faster-whisper
    # passes, and the run then dies blaming a missing ffmpeg binary.
    assert by_name["av"] == {"name": "av", "pinned": "18.1.0", "installed": "19.0.1", "status": "differs"}
    assert by_name["faster-whisper"]["status"] == "ok"
    # Not installed is not a mismatch: the heavier extras are optional.
    assert by_name["torch"]["status"] == "missing"


def test_the_report_is_sorted_and_total():
    rows = compare({"z": "1"}, {"z": "1", "other": "9"})
    assert [row["name"] for row in rows] == ["z"]


def test_this_checkout_pins_something():
    """The file this module reads is present, and it pins the package that broke."""
    pins = read_pins()
    assert pins, "requirements.txt should be next to this package"
    assert "av" in pins


def test_installed_versions_reports_none_for_a_name_that_is_not_a_distribution():
    assert installed_versions(["definitely-not-a-real-distribution-xyz"]) == {
        "definitely-not-a-real-distribution-xyz": None
    }
