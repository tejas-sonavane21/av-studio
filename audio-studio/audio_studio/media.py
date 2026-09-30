"""
media.py — getting audio into the pipeline, and proving which bytes were used.

Decoding goes through **PyAV** (via ``faster_whisper.decode_audio``), which
bundles the ffmpeg libraries. There is no ``ffmpeg`` binary on this machine and
none is needed — but a system ``ffmpeg`` is still used as a fallback if one ever
appears, because on Windows "ffmpeg is on PATH" is sometimes true and sometimes
not, and neither case should break the pipeline.

Every artifact records the SHA-256 of the audio it came from. Two transcripts
that disagree over the same file are then a real disagreement, not two runs over
different bytes.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .config import DEFAULT_SAMPLE_RATE

CHUNK = 1024 * 1024

#: Extensions we accept as audio-or-video input.
AUDIO_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wma",
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
}


class MediaError(RuntimeError):
    """Audio could not be read."""


class MissingDependency(MediaError):
    """A required optional dependency is not installed."""


@dataclass
class Audio:
    """Decoded audio plus the provenance needed to defend it later."""

    path: Optional[Path] = None
    samples: Any = None  # numpy float32 mono, when decoded
    sample_rate: int = DEFAULT_SAMPLE_RATE
    duration: float = 0.0
    sha256: str = ""
    source_sample_rate: Optional[int] = None
    channels: Optional[int] = None
    decoded_by: str = ""
    warnings: list[str] = field(default_factory=list)

    def excerpt(self, start: float, end: float) -> Any:
        """Slice the decoded samples by time. Requires the decoded buffer."""
        if self.samples is None:
            raise MediaError("audio is not decoded; call load_audio() first")
        if end <= start:
            return self.samples[0:0]
        a = max(0, int(start * self.sample_rate))
        b = max(a, int(end * self.sample_rate))
        return self.samples[a:b]

    def to_dict(self) -> dict:
        out = {
            "path": str(self.path) if self.path else None,
            "sha256": self.sha256,
            "sampleRate": self.sample_rate,
            "duration": round(self.duration, 3),
            "decodedBy": self.decoded_by,
        }
        if self.source_sample_rate is not None:
            out["sourceSampleRate"] = self.source_sample_rate
        if self.channels is not None:
            out["channels"] = self.channels
        return out


def sha256_file(path: str | Path) -> str:
    """SHA-256 of a file, streamed so a 2 GB video does not land in memory."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def probe_wav(path: str | Path) -> tuple[float, int, int]:
    """Duration / sample-rate / channels of a PCM WAV, using only the stdlib."""
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        frames = handle.getnframes()
        channels = handle.getnchannels()
        duration = frames / rate if rate else 0.0
    return duration, rate, channels


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def decode_with_ffmpeg(path: str | Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> bytes:
    """Decode to raw float32 mono 16 kHz PCM with the system ffmpeg binary."""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise MissingDependency("ffmpeg is not on PATH")
    command = [
        exe, "-nostdin", "-threads", "0", "-i", str(path),
        "-f", "f32le", "-ac", "1", "-acodec", "pcm_f32le", "-ar", str(sample_rate),
        "-",
    ]
    try:
        result = subprocess.run(command, capture_output=True, check=True)
    except subprocess.CalledProcessError as exc:  # pragma: no cover - depends on a broken file
        tail = (exc.stderr or b"")[-400:].decode("utf-8", "replace")
        raise MediaError(f"ffmpeg failed to decode {path}: {tail}") from exc
    return result.stdout


def load_audio(
    path: str | Path,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    *,
    decode: bool = True,
) -> Audio:
    """
    Read an audio (or video) file into the pipeline.

    ``decode=False`` only reads metadata and the hash — enough to report on a
    file without spending a CPU-minute decoding it, which is what ``doctor``
    and the job scheduler want.

    The order is: PyAV (bundled with the ``asr`` extra) → system ffmpeg → the
    stdlib ``wave`` module for plain PCM WAV. The last one matters because it is
    the only path that works with **no** optional dependencies installed, and it
    keeps the test suite honest.
    """
    file = Path(path)
    if not file.exists():
        raise MediaError(f"audio file not found: {file}")

    info = Audio(path=file, sample_rate=sample_rate, sha256=sha256_file(file))

    if file.suffix.lower() == ".wav":
        try:
            duration, rate, channels = probe_wav(file)
            info.duration, info.source_sample_rate, info.channels = duration, rate, channels
        except (wave.Error, EOFError) as exc:
            info.warnings.append(f"could not read the WAV header: {exc}")

    if not decode:
        return info

    samples = None
    try:
        import numpy as np  # noqa: F401  (imported for the dtype below)

        from faster_whisper import decode_audio  # type: ignore

        samples = decode_audio(str(file), sampling_rate=sample_rate)
        info.decoded_by = "pyav"
    except ImportError:
        pass
    except Exception as exc:  # pragma: no cover - depends on codec availability
        info.warnings.append(f"PyAV could not decode the file ({exc}); trying ffmpeg")

    if samples is None and has_ffmpeg():
        import numpy as np

        raw = decode_with_ffmpeg(file, sample_rate)
        samples = np.frombuffer(raw, dtype="<f4").copy()
        info.decoded_by = "ffmpeg"

    if samples is None and file.suffix.lower() == ".wav":
        import array

        import numpy as np

        with wave.open(str(file), "rb") as handle:
            if handle.getsampwidth() != 2:
                raise MediaError(f"{file.name}: only 16-bit PCM WAV can be read without the 'asr' extra")
            frames = handle.readframes(handle.getnframes())
            pcm = array.array("h")
            pcm.frombytes(frames)
            samples = np.asarray(pcm, dtype="<f4") / 32768.0
            if handle.getnchannels() > 1:
                samples = samples.reshape(-1, handle.getnchannels()).mean(axis=1)
            info.source_sample_rate = handle.getframerate()
            info.channels = handle.getnchannels()
        info.decoded_by = "wave"

    if samples is None:
        raise MissingDependency(
            "cannot decode audio: install the 'asr' extra (pip install -e '.[asr]') "
            "or put ffmpeg on PATH"
        )

    info.samples = samples
    if len(samples):
        info.duration = round(len(samples) / sample_rate, 6)
    info.sample_rate = sample_rate
    return info


def describe(path: str | Path, sample_rate: int = DEFAULT_SAMPLE_RATE) -> Audio:
    """Metadata-only read (no decoding). Re-exported for the CLI and doctor."""
    return load_audio(path, sample_rate, decode=False)
