"""
models.py — the model catalogue: what each preset really loads, and whether it is here yet.

A preset called ``balanced`` says nothing about what will run. The two questions a
person actually has before typing a path are *which model am I loading* and *is it
already on this machine* — and until now neither had an answer without reading
``config.py`` or watching a progress bar start a multi-hundred-megabyte download.

This module answers both, and it exists because of a real failure: the same commit
transcribed correctly on one laptop and failed on another, and the difference was the
model cache, not the code. ``Systran/faster-whisper-small`` was present on one and had
to be fetched on the other. Reporting that up front — in ``doctor``, in ``GET /health``
and in the transcribe panel — turns "it works on my machine" into a machine that says
what it is missing.

Nothing here imports faster-whisper or torch. The catalogue is data, and the download
check is a directory listing, so asking the question never pays the cost of answering
it with an import. The repo names are the same ones ``faster_whisper.utils._MODELS``
maps these short names to; ``tests/test_models.py`` asserts that against the installed
package, so a catalogue that drifts from the library fails the suite rather than a run.

A short name is not a version. ``small`` resolves to whatever
``Systran/faster-whisper-small`` points at *today*, so two machines that installed a
month apart can load different weights, transcribe the same recording differently, and
have nothing on screen to say why. Every entry below therefore carries the commit its
weights were verified at (``revision``) - read out of this machine's cache, not chosen -
and both the transcriber and the aligner hand it to the loader. A model whose weights
were never fetched here carries ``None``: an invented revision is worse than no revision,
so those keep the hub's current ``main``, and ``doctor`` shows the pin so "the other
laptop is on different weights" is a fact you can read rather than one you infer.

``is_downloaded`` asks the pinned question, not the loose one: the snapshot for *that*
commit, or the answer is "not here yet". A cache holding an older snapshot is a machine
that will fetch the verified weights, which is the whole point of pinning them.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping, Optional

#: The short name faster-whisper accepts → everything worth knowing about it.
#:
#: ``repo`` is the Hugging Face repository the short name resolves to, which is also the
#: name of its directory in the local cache (see :func:`repo_cache_name`). ``params`` is
#: the size of the *encoder+decoder* weights that get downloaded, which is the number a
#: person weighing up "accurate" against a slow laptop wants to see.
MODELS: dict[str, dict] = {
    "tiny": {
        "repo": "Systran/faster-whisper-tiny",
        "revision": None,
        "family": "Whisper tiny",
        "params": "39 M",
        "languages": "multilingual",
        "note": "the smallest; a transcription you would not use for captions",
    },
    "base": {
        "repo": "Systran/faster-whisper-base",
        # This machine's cache: `refs/main` of the repository named above.
        "revision": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
        "family": "Whisper base",
        "params": "74 M",
        "languages": "multilingual",
        "note": "quick draft; on a sung track it garbles words",
    },
    "small": {
        "repo": "Systran/faster-whisper-small",
        # The default preset's weights. Pinning these is what makes "the same commit" mean
        # the same transcript on the next machine as well.
        "revision": "536b0662742c02347bc0e980a01041f333bce120",
        "family": "Whisper small",
        "params": "244 M",
        "languages": "multilingual",
        "note": "the smallest model measured to get sung lyrics right on a CPU",
    },
    "medium": {
        "repo": "Systran/faster-whisper-medium",
        "revision": "08e178d48790749d25932bbc082711ddcfdfbc4f",
        "family": "Whisper medium",
        "params": "769 M",
        "languages": "multilingual",
        "note": "better on hard audio, several times slower than small",
    },
    "large-v3": {
        "repo": "Systran/faster-whisper-large-v3",
        # Never fetched here, so there is no verified commit to name - see the module
        # docstring. `doctor` reports these as unpinned rather than guessing.
        "revision": None,
        "family": "Whisper large-v3",
        "params": "1.55 B",
        "languages": "multilingual",
        "note": "the full large model; needs a GPU to be practical",
    },
    "distil-large-v3": {
        "repo": "Systran/faster-distil-whisper-large-v3",
        "revision": "c3058b475261292e64a0412df1d2681c06260fab",
        "family": "distil-whisper large-v3",
        "params": "756 M",
        "languages": "English only",
        "note": "near-large accuracy for a little over a third of large's weights",
    },
    "distil-medium.en": {
        "repo": "Systran/faster-distil-whisper-medium.en",
        "revision": None,
        "family": "distil-whisper medium.en",
        "params": "394 M",
        "languages": "English only",
        "note": "mid-sized distilled model, English only",
    },
}

#: What each preset is *called*, in words, for a person choosing one.
#:
#: Kept beside the catalogue rather than inside ``config.PRESETS``, which is the options
#: the engine consumes — a preset's `model` is a machine's business and its title is not.
PRESET_NOTES: dict[str, str] = {
    "fast": "the quickest; a rough pass to see if the alignment is working",
    "balanced": "the default — the cheapest model with usable lyrics on this machine",
    "accurate": "slower and more robust on hard audio; the pick for a dense mix",
    "best": "best accuracy available; only worth it on a GPU or many cores",
}

#: The forced-aligner's weights, and the commit they were verified at.
#:
#: The aligner is not a Whisper model and no preset chooses it, so it has no row in
#: ``MODELS`` - but it is downloaded from the same hub and it moves the same way, and a
#: re-timed word is only reproducible if the model that timed it is pinned too.
ALIGN_MODEL = "facebook/wav2vec2-base-960h"
ALIGN_REVISION = "22aad52d435eb6dbaf354bdad9b0da84ce7d6156"

#: Environment variables that move the Hugging Face cache, in the order the hub reads them.
_CACHE_ENV = ("HUGGINGFACE_HUB_CACHE", "HF_HUB_CACHE")


def cache_dir(env: Optional[Mapping[str, str]] = None) -> Path:
    """
    Where the Hugging Face hub keeps its models on this machine.

    Mirrors the hub's own resolution order — the explicit cache variables first, then
    ``HF_HOME`` with ``hub`` appended, then the platform default — because a check that
    looked somewhere else would report every model as missing on a machine that has
    them, which is worse than not checking at all.
    """
    source = os.environ if env is None else env
    for key in _CACHE_ENV:
        value = source.get(key)
        if value:
            return Path(value)
    home = source.get("HF_HOME")
    if home:
        return Path(home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def repo_cache_name(repo: str) -> str:
    """The hub's directory name for a repository: ``Systran/faster-whisper-small`` → ``models--Systran--faster-whisper-small``."""
    return "models--" + str(repo).replace("/", "--")


def revision_for(identifier: str) -> Optional[str]:
    """
    The commit these weights are pinned to, or ``None`` when they are not pinned.

    Accepts either spelling of the same model - the short name a preset uses (``small``)
    and the hub repository it resolves to (``Systran/faster-whisper-small``) - because the
    two callers hold different ones: the transcriber has a model name, and a cache check
    holding a directory name only has the repository.

    ``None`` is a real answer, not a failure: a model that was never fetched here, a hub id
    from outside the catalogue, or a local path all mean "nothing is pinned, use what the
    hub serves now".
    """
    entry = MODELS.get(str(identifier))
    if entry is not None:
        return entry.get("revision") or None
    for known in MODELS.values():
        if known["repo"] == str(identifier):
            return known.get("revision") or None
    if str(identifier) == ALIGN_MODEL:
        return ALIGN_REVISION
    return None


def repo_dir(model_id: str, *, root: Optional[Path] = None, env: Optional[Mapping[str, str]] = None) -> Optional[Path]:
    """The cache directory a model would live in, or ``None`` for a model we do not know by name."""
    entry = MODELS.get(model_id)
    if not entry:
        return None
    return (Path(root) if root else cache_dir(env)) / repo_cache_name(entry["repo"])


def is_downloaded(
    model_id: str,
    *,
    root: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
) -> Optional[bool]:
    """
    Is this model already on disk? ``None`` when the name is not in the catalogue.

    A directory that exists but holds no snapshot counts as *not downloaded*: an
    interrupted fetch leaves exactly that behind, and treating it as present is how a
    offline run turns into "No such file or directory: model.bin" after the download it
    thought it did not need.

    When the model is pinned, the *pinned* snapshot is what is looked for. A cache holding
    some other commit is a machine that will fetch these weights, and answering yes because
    a directory with the right name exists is how two machines end up on different weights
    while both report the model as present.
    """
    directory = repo_dir(model_id, root=root, env=env)
    if directory is None:
        return None
    pinned = revision_for(model_id)
    snapshots = directory / "snapshots"
    try:
        if not snapshots.is_dir():
            return False
        if pinned:
            return (snapshots / pinned).is_dir() and any((snapshots / pinned).iterdir())
        return any(child.name and any(child.iterdir()) for child in snapshots.iterdir())
    except OSError:
        return False


def describe(
    model_id: str,
    *,
    root: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
) -> dict:
    """One catalogue row, with this machine's answer for whether it is already cached."""
    entry = MODELS.get(model_id)
    if entry is None:
        # An unknown name is not an error: `--model` takes any path or hub id the library
        # understands, and a name we cannot describe is still a name it can load.
        return {
            "id": str(model_id),
            "repo": str(model_id),
            "family": str(model_id),
            "params": "",
            "languages": "",
            "note": "not in the catalogue; passed to the engine as given",
            "known": False,
            "downloaded": None,
            "revision": None,
        }
    return {
        "id": str(model_id),
        "repo": entry["repo"],
        "family": entry["family"],
        "params": entry["params"],
        "languages": entry["languages"],
        "note": entry.get("note", ""),
        "known": True,
        "downloaded": is_downloaded(model_id, root=root, env=env),
        "revision": entry.get("revision") or None,
    }


def catalog(*, root: Optional[Path] = None, env: Optional[Mapping[str, str]] = None) -> list[dict]:
    """Every model we know, in the order the catalogue lists them. Free of imports."""
    return [describe(model_id, root=root, env=env) for model_id in MODELS]


def preset_details(
    presets: Mapping[str, Mapping[str, object]],
    *,
    root: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
) -> list[dict]:
    """
    Each preset resolved to the model it loads, in the order ``presets`` lists them.

    This is what the transcribe panel renders its options from. The ordering is the
    caller's, deliberately: "fast → balanced → accurate → best" is a progression, and
    sorting it alphabetically would put the default in the middle of a list that is
    supposed to read from quickest to best.
    """
    rows: list[dict] = []
    for preset_id, spec in presets.items():
        model_id = str(spec.get("model", ""))
        info = describe(model_id, root=root, env=env)
        rows.append(
            {
                "id": preset_id,
                "model": model_id,
                "modelName": info["family"] or model_id,
                "repo": info["repo"],
                "params": info["params"],
                "languages": info["languages"],
                "downloaded": info["downloaded"],
                "beamSize": spec.get("beam_size"),
                "note": PRESET_NOTES.get(preset_id, ""),
                "known": info["known"],
                "revision": info["revision"],
            }
        )
    return rows


def describe_model(model_id: str) -> str:
    """One line naming a model as a person would: ``Whisper small (Systran/faster-whisper-small, 244 M)``."""
    info = describe(model_id)
    if not info["known"]:
        return str(model_id)
    size = f", {info['params']}" if info["params"] else ""
    return f"{info['family']} ({info['repo']}{size})"


def describe_preset(preset_id: str, presets: Mapping[str, Mapping[str, object]]) -> str:
    """``balanced → Whisper small (Systran/faster-whisper-small, 244 M)``, or a bare id when unknown."""
    spec = presets.get(preset_id)
    if spec is None:
        return str(preset_id)
    return f"{preset_id} → {describe_model(str(spec.get('model', '')))}"


__all__ = [
    "ALIGN_MODEL",
    "ALIGN_REVISION",
    "MODELS",
    "PRESET_NOTES",
    "cache_dir",
    "catalog",
    "describe",
    "describe_model",
    "describe_preset",
    "is_downloaded",
    "preset_details",
    "repo_cache_name",
    "repo_dir",
    "revision_for",
]
