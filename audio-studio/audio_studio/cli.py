"""
cli.py — ``python -m audio_studio ...`` / ``audio-studio ...``.

Subcommands:

``transcribe``  audio (or video) → transcript artifacts
``emit``        re-emit a saved transcript as SRT/VTT/Veed JSON
``doctor``      report what is installed and what can actually run
``serve``       a local HTTP server for ``caption-studio`` (see ``server.py``)
``version``     print the version

Exit codes: ``0`` success, ``1`` failure, ``2`` bad usage (argparse). Progress
goes to **stderr**, so ``--json`` output on stdout stays machine-parseable.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Optional

from . import __version__
from .align import DEFAULT_ALIGNER, aligner_names, available_aligners
from .artifact import ArtifactError, load
from .config import (
    DEFAULT_ALIGN_MODEL,
    DEFAULT_PRESET,
    PRESETS,
    AlignOptions,
    ReconcileOptions,
    ValidateOptions,
    options_from_preset,
)
from .emit import DEFAULT_KINDS, kinds, write_bundle
from .engines import available_engines, engine_names, get_engine
from .media import MediaError, describe, load_audio
from .model import validate
from .pipeline import PassUnavailable, PipelineOptions, post_process, summarise_passes
from .reference import Reference, ReferenceParseError
from .validate import DEFAULT_VALIDATOR, available_validators, validator_names


def _err(message: str) -> None:
    print(f"audio-studio: {message}", file=sys.stderr)


def _progress_factory(quiet: bool):
    last = [-1]

    def on_progress(fraction: float, message: str) -> None:
        if quiet:
            return
        percent = int(round(fraction * 100))
        if percent == last[0]:
            return
        last[0] = percent
        print(f"[{percent:3d}%] {message}", file=sys.stderr)

    return on_progress


def _parse_kinds(value: str) -> list[str]:
    if value in ("", "all"):
        return list(DEFAULT_KINDS)
    requested = [part.strip() for part in value.split(",") if part.strip()]
    unknown = [k for k in requested if k not in kinds()]
    if unknown:
        raise argparse.ArgumentTypeError(f"unknown emit kind(s) {unknown}; expected {kinds()}")
    return requested


def _summarise(transcript) -> str:
    lines = [
        f"  segments       {len(transcript.segments)}",
        f"  words          {transcript.word_count}",
        f"  duration       {transcript.duration:.3f}s",
        f"  speech         {transcript.speech_duration:.3f}s ({transcript.speech_ratio * 100:.1f}%)",
        f"  language       {transcript.language or 'unknown'}",
    ]
    if transcript.gaps:
        longest = max(g.duration for g in transcript.gaps)
        lines.append(f"  gaps           {len(transcript.gaps)} (longest {longest:.2f}s)")
    lines.extend(summarise_passes(transcript))
    report = validate(transcript)
    if report["errors"]:
        lines.append(f"  ERRORS         {len(report['errors'])}")
        for error in report["errors"][:5]:
            lines.append(f"    - {error}")
    if transcript.warnings:
        lines.append(f"  warnings       {len(transcript.warnings)}")
        for warning in transcript.warnings[:5]:
            lines.append(f"    - {warning}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# transcribe
# --------------------------------------------------------------------------- #


def cmd_transcribe(args: argparse.Namespace) -> int:
    # The passes are read before anything is decoded or transcribed. A lyric file that
    # cannot be read is a typo in the command line, and finding that out after a
    # five-minute transcription has already run is a waste of the five minutes.
    try:
        passes = _pipeline_options(args)
    except (ReferenceParseError, OSError) as exc:
        _err(str(exc))
        return 1

    try:
        audio = load_audio(args.audio, decode=not args.no_decode)
    except (MediaError, OSError) as exc:
        _err(str(exc))
        return 1

    engine = get_engine(args.engine)
    usable, reason = engine.available()
    if not usable:
        _err(f"engine {args.engine!r} is unavailable: {reason}")
        return 1

    options = options_from_preset(
        args.preset,
        model=args.model,
        language=args.language,
        beam_size=args.beam,
        word_timestamps=False if args.no_word_timestamps else True,
        vad_filter=True if args.vad else False,
    )

    if not args.no_decode and not args.quiet:
        print(f"· {args.audio}  ({audio.duration:.2f}s, {audio.decoded_by or 'metadata only'})", file=sys.stderr)

    try:
        transcript = engine.transcribe(audio, options, _progress_factory(args.quiet))
    except Exception as exc:  # noqa: BLE001 - a failed job must not traceback at the user
        _err(f"transcription failed ({args.engine}): {exc}")
        return 1

    if passes.enabled():
        try:
            transcript = post_process(transcript, audio, passes, _progress_factory(args.quiet))
        except PassUnavailable as exc:
            _err(str(exc))
            return 1
        except Exception as exc:  # noqa: BLE001 - a failed pass must not traceback either
            _err(f"post-processing failed: {exc}")
            return 1

    stem = args.stem or Path(args.audio).stem
    written = write_bundle(
        transcript,
        args.out,
        stem=stem,
        kinds_selected=args.emit,
        word_level=args.word_level,
        emphasis=args.emphasis,
    )

    if args.json:
        print(
            json.dumps(
                {
                    "engine": transcript.engine,
                    "segments": len(transcript.segments),
                    "words": transcript.word_count,
                    "duration": transcript.duration,
                    "warnings": transcript.warnings,
                    "files": [str(p) for p in written],
                },
                indent=2,
            )
        )
    else:
        print(f"transcribed {args.audio} with {transcript.engine.get('name', args.engine)}")
        print(_summarise(transcript))
        print("  wrote")
        for path in written:
            print(f"    - {path}")
    return 0


# --------------------------------------------------------------------------- #
# emit
# --------------------------------------------------------------------------- #


def cmd_emit(args: argparse.Namespace) -> int:
    try:
        transcript = load(args.artifact)
    except (ArtifactError, OSError) as exc:
        _err(str(exc))
        return 1

    stem = args.stem or Path(args.artifact).name.split(".")[0]
    written = write_bundle(
        transcript,
        args.out,
        stem=stem,
        kinds_selected=args.emit,
        word_level=args.word_level,
        emphasis=args.emphasis,
    )
    if args.json:
        print(json.dumps({"files": [str(p) for p in written]}, indent=2))
    else:
        for path in written:
            print(f"wrote {path}")
    return 0


# --------------------------------------------------------------------------- #
# doctor
# --------------------------------------------------------------------------- #


def _module_version(name: str) -> str | None:
    try:
        module = __import__(name)
    except Exception:
        return None
    return str(getattr(module, "__version__", "installed"))


def build_doctor_report() -> dict:
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    # `av` is in this list for a reason: it is the ffmpeg binding that actually decodes
    # the input, it is *not* covered by the `import faster_whisper` check the engine
    # report above is built on, and a version of it newer than the faster-whisper
    # release knows silently removes the ability to open any file at all. A doctor that
    # cannot show that version cannot diagnose the failure it causes.
    packages = {
        name: _module_version(name)
        for name in (
            "numpy",
            "faster_whisper",
            "av",
            "torch",
            "torchaudio",
            "transformers",
            "google.genai",
            "httpx",
        )
    }
    return {
        "audioStudio": __version__,
        "python": platform.python_version(),
        "executable": sys.executable,
        "virtualenv": in_venv,
        "platform": f"{platform.system()} {platform.release()}",
        "cpuCount": os.cpu_count(),
        "ffmpeg": shutil.which("ffmpeg"),
        "packages": packages,
        "engines": available_engines(),
        "aligners": available_aligners(),
        "validators": available_validators(),
        "presets": sorted(PRESETS),
        "defaultPreset": DEFAULT_PRESET,
        "defaultAligner": DEFAULT_ALIGNER,
        "defaultValidator": DEFAULT_VALIDATOR,
    }


def cmd_doctor(args: argparse.Namespace) -> int:
    report = build_doctor_report()
    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(f"audio-studio {report['audioStudio']}")
    print(f"  python        {report['python']}  ({report['executable']})")
    print(f"  virtualenv    {'yes' if report['virtualenv'] else 'NO - the studio should run inside .venv'}")
    print(f"  platform      {report['platform']}, {report['cpuCount']} CPUs")
    print(f"  ffmpeg        {report['ffmpeg'] or 'not on PATH (PyAV is bundled with the [asr] extra)'}")
    print("  packages")
    for name, version in report["packages"].items():
        print(f"    {name:<14} {version or '-'}")
    print("  engines")
    for engine in report["engines"]:
        mark = "ok " if engine["available"] else "no "
        print(f"    [{mark}] {engine['name']:<16} {engine['reason']}")
    print("  aligners")
    for aligner in report["aligners"]:
        mark = "ok " if aligner["available"] else "no "
        print(f"    [{mark}] {aligner['name']:<16} {aligner['reason']}")
    print("  validators")
    for validator in report["validators"]:
        mark = "ok " if validator["available"] else "no "
        print(f"    [{mark}] {validator['name']:<16} {validator['reason']}")
    print(f"  presets       {', '.join(report['presets'])} (default: {report['defaultPreset']})")
    if not report["virtualenv"]:
        print("\n  ! Not inside a virtualenv. Create one with: python -m venv .venv")
    return 0


# --------------------------------------------------------------------------- #
# parser
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# the optional passes (shared by transcribe / align / validate)
# --------------------------------------------------------------------------- #


def _pipeline_options(args: argparse.Namespace) -> PipelineOptions:
    """
    Read the pass flags off a parsed namespace, so all three commands agree.

    Raises :class:`ReferenceParseError` for a lyric file that cannot be read, rather
    than treating an unreadable file as "no reference": the two look identical in
    the output and only one of them is what the user asked for.
    """
    return PipelineOptions(
        reference=_reference_from_args(args),
        reference_options=ReconcileOptions(min_match=getattr(args, "reference_min_match", 0.5)),
        align=getattr(args, "align", None),
        align_options=AlignOptions(
            model=getattr(args, "align_model", None) or DEFAULT_ALIGN_MODEL,
            min_confidence=getattr(args, "align_min_confidence", 0.35),
            window_pad=getattr(args, "align_pad", 0.30),
            max_shift=getattr(args, "align_max_shift", 2.0),
        ),
        validate=getattr(args, "validate", None),
        validate_options=ValidateOptions(
            provider=getattr(args, "llm_provider", "auto"),
            model=getattr(args, "llm_model", None),
            api_key=getattr(args, "api_key", None),
            min_confidence=getattr(args, "llm_min_confidence", 0.6),
        ),
    )


def _reference_from_args(args: argparse.Namespace) -> Optional[Reference]:
    """Load ``--reference`` when it was given. The only file the CLI reads itself."""
    path = getattr(args, "reference", None)
    if not path:
        return None
    return Reference.from_file(path)


def _add_reference_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--reference",
        default=None,
        metavar="FILE",
        help="the original lyrics (.srt/.vtt/.txt): the text comes from the file, the timing from the audio",
    )
    parser.add_argument(
        "--reference-min-match",
        type=float,
        default=0.5,
        help="share of words that must agree before the file is trusted (default: 0.5)",
    )


def _add_align_arguments(parser: argparse.ArgumentParser, default: str | None = None) -> None:
    parser.add_argument(
        "--align",
        default=default,
        choices=aligner_names(),
        help="re-time words against the audio (wav2vec: ~20 ms; fake: offline, synthetic)",
    )
    parser.add_argument("--align-model", default=None, help=f"acoustic model (default: {DEFAULT_ALIGN_MODEL})")
    parser.add_argument(
        "--align-min-confidence",
        type=float,
        default=0.35,
        help="below this mean posterior a segment keeps its original timings",
    )
    parser.add_argument("--align-pad", type=float, default=0.30, help="seconds of context either side of a segment")
    parser.add_argument(
        "--align-max-shift",
        type=float,
        default=2.0,
        help="a word may not move further than this from the transcriber's timing",
    )


def _add_validate_arguments(parser: argparse.ArgumentParser, default: str | None = None) -> None:
    parser.add_argument(
        "--validate",
        default=default,
        choices=validator_names(),
        help="police the transcript text (rules: offline; llm: hosted, needs a key)",
    )
    parser.add_argument("--llm-provider", default="auto", choices=("auto", "google", "openrouter"))
    parser.add_argument("--llm-model", default=None, help="model name, e.g. gemini-2.0-flash")
    parser.add_argument(
        "--llm-min-confidence",
        type=float,
        default=0.6,
        help="a correction below this confidence is recorded but not applied",
    )
    parser.add_argument("--api-key", default=None, help="override the environment / key file")


def _add_emit_arguments(parser: argparse.ArgumentParser, *, audio: bool = False) -> None:
    parser.add_argument("--out", default="out", help="output directory (default: ./out)")
    parser.add_argument("--stem", default=None, help="output file stem (default: the input's)")
    parser.add_argument("--emit", type=_parse_kinds, default=list(DEFAULT_KINDS), help="comma list: json,veed,srt,vtt")
    parser.add_argument("--word-level", action="store_true", help="one subtitle cue per word")
    parser.add_argument("--emphasis", default="none", choices=("none", "all", "auto"), help="keyword highlighting in the Veed output (auto = the words the llm validator picked)")
    parser.add_argument("--json", action="store_true", help="machine-readable output on stdout")
    parser.add_argument("--quiet", "-q", action="store_true", help="no progress output")
    if audio:
        parser.add_argument("--no-decode", action="store_true", help="do not decode the audio before aligning")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="audio-studio",
        description="Speech-to-text with word-level timing for the web_av_editor suite.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    t = sub.add_parser("transcribe", help="audio/video → transcript artifacts")
    t.add_argument("audio", help="path to an audio or video file")
    t.add_argument("--out", default="out", help="output directory (default: ./out)")
    t.add_argument("--stem", default=None, help="output file stem (default: the input's)")
    t.add_argument("--engine", default="whisper", choices=engine_names(), help="transcription backend")
    t.add_argument("--preset", default=DEFAULT_PRESET, choices=sorted(PRESETS), help="accuracy/speed preset")
    t.add_argument("--model", default=None, help="override the preset's model (e.g. small, medium, distil-large-v3)")
    t.add_argument("--language", default=None, help="force a language code (e.g. en); default: autodetect")
    t.add_argument("--beam", type=int, default=None, help="beam size (default: the preset's)")
    t.add_argument("--emit", type=_parse_kinds, default=list(DEFAULT_KINDS), help="comma list: json,veed,srt,vtt")
    t.add_argument("--word-level", action="store_true", help="one subtitle cue per word")
    t.add_argument("--emphasis", default="none", choices=("none", "all", "auto"), help="keyword highlighting in the Veed output (auto = the words the llm validator picked)")
    t.add_argument(
        "--vad",
        action="store_true",
        help="voice-activity filtering; for spoken word only - VAD deletes sung vocals",
    )
    t.add_argument("--no-word-timestamps", action="store_true", help="skip per-word timings (fast, but no word editing)")
    t.add_argument("--no-decode", action="store_true", help="do not decode the audio before transcribing")
    t.add_argument("--quiet", "-q", action="store_true", help="no progress output")
    t.add_argument("--json", action="store_true", help="machine-readable summary on stdout")
    _add_reference_arguments(t)
    _add_align_arguments(t)
    _add_validate_arguments(t)
    t.set_defaults(func=cmd_transcribe)

    e = sub.add_parser("emit", help="re-emit a saved transcript")
    e.add_argument("artifact", help="path to a *.speech.json")
    e.add_argument("--out", default="out", help="output directory (default: ./out)")
    e.add_argument("--stem", default=None, help="output file stem")
    e.add_argument("--emit", type=_parse_kinds, default=list(DEFAULT_KINDS), help="comma list: json,veed,srt,vtt")
    e.add_argument("--word-level", action="store_true", help="one subtitle cue per word")
    e.add_argument("--emphasis", default="none", choices=("none", "all", "auto"), help="keyword highlighting in the Veed output (auto = the words the llm validator picked)")
    e.add_argument("--json", action="store_true", help="machine-readable output on stdout")
    e.set_defaults(func=cmd_emit)

    d = sub.add_parser("doctor", help="report installed packages and usable engines")
    d.add_argument("--json", action="store_true", help="machine-readable report on stdout")
    d.set_defaults(func=cmd_doctor)

    a = sub.add_parser("align", help="re-time a saved transcript against its audio")
    a.add_argument("artifact", help="path to a *.speech.json")
    a.add_argument("--audio", required=True, help="the audio (or video) it was transcribed from")
    _add_emit_arguments(a, audio=True)
    _add_reference_arguments(a)
    _add_align_arguments(a, default=DEFAULT_ALIGNER)
    _add_validate_arguments(a)
    a.set_defaults(func=cmd_align)

    va = sub.add_parser("validate", help="review a saved transcript and record the ledger")
    va.add_argument("artifact", help="path to a *.speech.json")
    _add_emit_arguments(va)
    _add_reference_arguments(va)
    _add_align_arguments(va)
    _add_validate_arguments(va, default=DEFAULT_VALIDATOR)
    va.set_defaults(func=cmd_validate)

    v = sub.add_parser("version", help="print the version")
    v.set_defaults(func=cmd_version)

    s = sub.add_parser("serve", help="local HTTP server for caption-studio")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8756)
    s.add_argument("--out", default="jobs", help="directory for job artifacts (default: ./jobs)")
    s.add_argument("--engine", default="whisper", choices=engine_names())
    s.add_argument("--preset", default=DEFAULT_PRESET, choices=sorted(PRESETS))
    s.set_defaults(func=_cmd_serve)

    return parser


def cmd_version(_args: argparse.Namespace) -> int:
    print(__version__)
    return 0


# --------------------------------------------------------------------------- #
# align / validate — the passes, on their own
# --------------------------------------------------------------------------- #


def _reprocess(args: argparse.Namespace, needs_audio: bool) -> int:
    """Shared body of ``align`` and ``validate``: load, pass, write, report."""
    try:
        transcript = load(args.artifact)
    except (ArtifactError, OSError) as exc:
        _err(str(exc))
        return 1

    try:
        options = _pipeline_options(args)
    except (ReferenceParseError, OSError) as exc:
        _err(str(exc))
        return 1
    if not options.enabled():
        _err("nothing to do: pass --reference <file>, --align <name> or --validate <name>")
        return 1

    audio = None
    if needs_audio or options.align:
        source = getattr(args, "audio", None)
        if not source:
            _err("this pass needs the audio: pass --audio <file>")
            return 1
        try:
            audio = load_audio(source, decode=not getattr(args, "no_decode", False))
        except (MediaError, OSError) as exc:
            _err(str(exc))
            return 1

    try:
        transcript = post_process(transcript, audio, options, _progress_factory(args.quiet))
    except PassUnavailable as exc:
        _err(str(exc))
        return 1
    except Exception as exc:  # noqa: BLE001 - a failed pass must not traceback at the user
        _err(f"the pass failed: {exc}")
        return 1

    stem = args.stem or Path(args.artifact).name.split(".")[0]
    written = write_bundle(
        transcript,
        args.out,
        stem=stem,
        kinds_selected=args.emit,
        word_level=args.word_level,
        emphasis=args.emphasis,
    )
    if args.json:
        print(
            json.dumps(
                {
                    "alignment": transcript.alignment,
                    "validation": transcript.validation,
                    "corrections": transcript.corrections,
                    "warnings": transcript.warnings,
                    "files": [str(p) for p in written],
                },
                indent=2,
            )
        )
        return 0

    print(_summarise(transcript))
    print("  wrote")
    for path in written:
        print(f"    - {path}")
    return 0


def cmd_align(args: argparse.Namespace) -> int:
    return _reprocess(args, needs_audio=True)


def cmd_validate(args: argparse.Namespace) -> int:
    return _reprocess(args, needs_audio=False)


def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        from .server import serve
    except ImportError as exc:  # pragma: no cover - only until server.py exists
        _err(f"the HTTP server is not available: {exc}")
        return 1
    return serve(args)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        _err("interrupted")
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
