"""transcript-studio's Python client — `requests` in, files out."""

from .client import Client, TranscriptStudioError, DEFAULT_URL

__all__ = ["Client", "TranscriptStudioError", "DEFAULT_URL"]
__version__ = "0.1.0"
