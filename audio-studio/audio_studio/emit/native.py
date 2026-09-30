"""
emit/native.py — our own artifact format, ``<stem>.speech.json``.

This is the studio's *native* output: everything the pipeline knows, including
per-word confidence, engine provenance, alignment provenance, gaps, the
validation ledger and the structural warnings. It is the file every other
emitter can be regenerated from, and the file the HTTP server hands back.

It is deliberately self-describing (``schemaVersion`` + ``generator``) so a
future reader can tell which build produced it without guessing.
"""

from __future__ import annotations

import json

from ..model import Transcript

KIND = "json"
EXTENSION = ".speech.json"
OPTIONS = ("indent",)


def to_native_dict(transcript: Transcript) -> dict:
    return transcript.to_dict()


def render(transcript: Transcript, indent: int = 2) -> str:
    return json.dumps(to_native_dict(transcript), indent=indent, ensure_ascii=False) + "\n"
