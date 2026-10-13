"""
env.py — where a key is allowed to live, and what a `.env` is allowed to look like.

The parser is pure, so it is tested directly and exhaustively: a `.env` is written by
hand, by a person, on a keyboard, and every one of these cases is a real way a key has
been typed. The failure they guard against is specific and unpleasant — a secret that
arrives *slightly* wrong is reported by the provider as a bad key, so the hunt goes to
the wrong place entirely and the file that caused it looks fine.
"""

from __future__ import annotations

from pathlib import Path

from audio_studio.env import (
    ENV_EXAMPLE_FILENAME,
    ENV_FILENAME,
    find_env_file,
    load_env,
    parse_env,
    read_env,
)

#: Every variable the studios read a key from, so a test can prove it found *its* value
#: and not one exported on the machine running the suite.
KEY_VARIABLES = ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY")


def sandbox(monkeypatch, tmp_path):
    """Move `env.py`'s idea of where it lives into the sandbox, and clear the keys."""
    monkeypatch.setattr("audio_studio.env.__file__", str(tmp_path / "pkg" / "a" / "b" / "c" / "d.py"))
    for name in KEY_VARIABLES:
        monkeypatch.delenv(name, raising=False)


# --------------------------------------------------------------------------- #
# the parser
# --------------------------------------------------------------------------- #


def test_a_plain_assignment_parses():
    assert parse_env("GEMINI_API_KEY=abc123\n") == {"GEMINI_API_KEY": "abc123"}


def test_whitespace_around_the_assignment_is_not_part_of_the_value():
    assert parse_env("  GEMINI_API_KEY = abc123  \n") == {"GEMINI_API_KEY": "abc123"}


def test_export_is_accepted_because_that_is_what_people_copy():
    assert parse_env("export GEMINI_API_KEY=abc\n") == {"GEMINI_API_KEY": "abc"}


def test_single_quotes_are_literal():
    """A key with a backslash in it must not be unescaped into a different key."""
    assert parse_env(r"GEMINI_API_KEY='a\\b'" + "\n") == {"GEMINI_API_KEY": "a\\\\b"}


def test_double_quotes_unescape_the_sequences_dotenv_defines():
    assert parse_env('GEMINI_API_KEY="a\\tb"\n') == {"GEMINI_API_KEY": "a\tb"}


def test_a_comment_after_a_bare_value_is_not_part_of_it():
    assert parse_env("GEMINI_API_KEY=abc # the real one\n") == {"GEMINI_API_KEY": "abc"}


def test_a_hash_inside_a_value_is_kept():
    """`abc#def` is a value, not a comment — the separator is the whitespace."""
    assert parse_env("GEMINI_API_KEY=abc#def\n") == {"GEMINI_API_KEY": "abc#def"}


def test_comment_and_blank_lines_are_skipped():
    text = "# a comment\n\n   \nGEMINI_API_KEY=abc\n# another\n"
    assert parse_env(text) == {"GEMINI_API_KEY": "abc"}


def test_crlf_and_a_byte_order_mark_do_not_break_the_first_line():
    assert parse_env("\ufeffGEMINI_API_KEY=abc\r\nGOOGLE_API_KEY=def\r\n") == {
        "GEMINI_API_KEY": "abc",
        "GOOGLE_API_KEY": "def",
    }


def test_a_line_that_is_not_an_assignment_is_skipped_not_guessed():
    assert parse_env("this is prose\nGEMINI_API_KEY=abc\noops\n") == {"GEMINI_API_KEY": "abc"}


def test_an_empty_value_is_dropped():
    """"Set to nothing" is not a key; keeping it would make two callers disagree."""
    assert parse_env("GEMINI_API_KEY=\nGOOGLE_API_KEY=   \n") == {}


def test_the_last_assignment_wins():
    assert parse_env("GEMINI_API_KEY=first\nGEMINI_API_KEY=second\n") == {"GEMINI_API_KEY": "second"}


def test_parsing_is_pure():
    text = "GEMINI_API_KEY=abc\n"
    parse_env(text)
    assert text == "GEMINI_API_KEY=abc\n"


# --------------------------------------------------------------------------- #
# finding and applying the file
# --------------------------------------------------------------------------- #


def test_the_file_is_found_beside_the_working_directory(tmp_path, monkeypatch):
    sandbox(monkeypatch, tmp_path)
    (tmp_path / ENV_FILENAME).write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
    assert find_env_file(tmp_path) == tmp_path / ENV_FILENAME


def test_the_nearest_file_wins_over_a_distant_one(tmp_path, monkeypatch):
    """A project that keeps its own `.env` deeper in the tree is not overruled."""
    sandbox(monkeypatch, tmp_path)
    deep = tmp_path / "a" / "b"
    deep.mkdir(parents=True)
    (tmp_path / ENV_FILENAME).write_text("GEMINI_API_KEY=outer\n", encoding="utf-8")
    (deep / ENV_FILENAME).write_text("GEMINI_API_KEY=inner\n", encoding="utf-8")
    assert find_env_file(deep) == deep / ENV_FILENAME


def test_reading_leaves_the_environment_alone(tmp_path, monkeypatch):
    sandbox(monkeypatch, tmp_path)
    (tmp_path / ENV_FILENAME).write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
    assert read_env(tmp_path / ENV_FILENAME) == {"GEMINI_API_KEY": "abc"}
    import os

    assert "GEMINI_API_KEY" not in os.environ


def test_loading_puts_the_values_into_the_environment(tmp_path, monkeypatch):
    sandbox(monkeypatch, tmp_path)
    (tmp_path / ENV_FILENAME).write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
    import os

    values = load_env(tmp_path / ENV_FILENAME)
    assert values == {"GEMINI_API_KEY": "abc"}
    assert os.environ["GEMINI_API_KEY"] == "abc"


def test_a_real_environment_variable_is_never_overridden(tmp_path, monkeypatch):
    sandbox(monkeypatch, tmp_path)
    (tmp_path / ENV_FILENAME).write_text("GEMINI_API_KEY=from-the-file\n", encoding="utf-8")
    monkeypatch.setenv("GEMINI_API_KEY", "from-the-environment")
    load_env(tmp_path / ENV_FILENAME)
    import os

    assert os.environ["GEMINI_API_KEY"] == "from-the-environment"


def test_an_unreadable_or_missing_file_is_not_a_failure(tmp_path, monkeypatch):
    sandbox(monkeypatch, tmp_path)
    assert read_env(tmp_path / "nowhere" / ENV_FILENAME) == {}
    assert load_env(tmp_path / "nowhere" / ENV_FILENAME) == {}
    assert find_env_file(tmp_path / "nowhere") is None


def test_the_template_that_ships_is_the_file_this_module_reads():
    """
    `.env.example` is the committed documentation of `.env`, so the two names have to
    agree — a template called something else is a template nobody copies.
    """
    assert ENV_EXAMPLE_FILENAME == ".env.example"
    example = Path(__file__).resolve().parents[2] / ENV_EXAMPLE_FILENAME
    assert example.is_file(), f"{ENV_EXAMPLE_FILENAME} is missing from the repository root"
    placeholders = parse_env(example.read_text(encoding="utf-8"))
    assert "GEMINI_API_KEY" in placeholders
    assert "your-gemini-api-key-here" in placeholders["GEMINI_API_KEY"]


def test_the_studio_ships_a_template_of_its_own():
    """
    The studio is standalone, so *this* folder has to carry the template.

    The suite root's `.env.example` is reachable from a run started at the root, and it is
    no help at all to a checkout of `audio-studio` on its own - which is exactly how the
    studio is expected to be used. Copying the studio somewhere else must not leave the
    user with a key error and nothing to copy.
    """
    example = Path(__file__).resolve().parents[1] / ENV_EXAMPLE_FILENAME
    assert example.is_file(), f"{ENV_EXAMPLE_FILENAME} is missing from audio-studio/"
    placeholders = parse_env(example.read_text(encoding="utf-8"))
    assert "GEMINI_API_KEY" in placeholders
    assert "your-gemini-api-key-here" in placeholders["GEMINI_API_KEY"]


def test_the_studio_ignores_its_own_dot_env():
    """
    A key must not be committable from this folder either.

    The rule lives in two places for one reason: the root `.gitignore` protects the tree
    it was written in, and a clone of `audio-studio` alone gets this file and not that
    one. A template that ships without the rule that hides its copy is a trap.
    """
    rules = (Path(__file__).resolve().parents[1] / ".gitignore").read_text(encoding="utf-8")
    lines = [line.strip() for line in rules.replace("\r\n", "\n").split("\n")]
    assert ENV_FILENAME in lines
    assert not any(line.startswith("!") and line.endswith(ENV_FILENAME) for line in lines)
