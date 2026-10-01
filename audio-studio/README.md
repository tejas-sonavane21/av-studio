# Audio Studio

The **audio-side studio** of the `web_av_editor` suite: a local, Python-driven
**speech-to-text and word-timing engine** with an auditable validation layer.

Where [`caption-studio`](../caption-studio) owns the *caption* timeline — text,
style, placement, the render — this studio owns the *audio* timeline: what was
said, **when exactly each word was said**, where the silence is, and whether the
transcript can be trusted.

> **Status: Phases A and B complete and verified.** The transcript model, the
> four emitters (native JSON, Veed-compatible master JSON, SRT, VTT), the engine
> registry with a deterministic offline backend, the CLI, and **real local
> transcription via `faster-whisper`** are built. The backend-free layers are
> covered by **98 tests that pass with *zero* third-party packages installed**,
> so the pure layers can never be blocked behind a model download. Forced
> alignment, LLM validation and the HTTP server are the next phases.

## Why this exists

`caption-studio` corrects an AI transcript against a trusted subtitle file, and
it is good at it. But it **inherits its word timings from Veed** — and a
correction engine cannot repair a number it was handed. When a caption is split
in two, the cut lands on the midpoint of the silence between two words, so if the
words themselves are badly timed, every split, join and reveal inherits the
error. That is the drift this studio exists to remove: **measure the timings
ourselves, from the audio.**

The two studios are siblings, not a pipeline with a head and a tail. Each runs
standalone; this one's artifacts are importable by that one.

## The engine decisions, and why

Built and tuned for the machine it must run on: **4 logical cores, ~16 GB RAM,
no GPU, no `ffmpeg` on `PATH`.**

| Layer | Choice | Why it wins here |
|---|---|---|
| **Transcribe** | [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (CTranslate2, int8) | No PyTorch, and the best throughput-per-core of the CPU-capable options. Default model `small`: the cheapest model measured to transcribe a *sung* track correctly here |
| **Align** *(the actual sync fix)* | `wav2vec2` forced alignment — optional `[align]` extra | Tightens word onsets to ~20–50 ms. We usually already *have* the words (an SRT/VTT), so we do not have to guess them — known text can be aligned to the waveform |
| **Validate** | `google-genai` / OpenRouter — optional `[llm]` extra | Polices the transcript *text* (spelling, casing, punctuation) and emits an auditable ledger. Timings never depend on it |
| **Decode** | PyAV, bundled with the `[asr]` extra | No system `ffmpeg` install; a system one is still used if it appears |

Heavy dependencies live behind extras so the base install is instant, and every
backend sits behind one interface (`engines/base.py`) so the choice can change
without every caller changing with it. `doctor` reports what is actually usable
rather than what was intended.

The defaults were then **measured on the real fixture** —
`referece_material/The_Crimson_Burden.mp3`, a 182.5 s sung track — rather than
copied from a benchmark table:

| model | wall time | throughput | lyric accuracy |
|---|---|---|---|
| `base` | ~25 s | ~7.3× | garbled |
| `small` | ~78 s | ~2.3× | correct |
| `distil-large-v3` | >400 s / 30 s slice | <0.1× | never finishes |

Three backend defaults fall out of that, and each protects *timing*:

- **`vad_filter=False`** — the opposite of most Whisper recipes, and on purpose.
  Voice-activity detection is tuned for *speech*, and a sung vocal is not speech
  to it: on the fixture above VAD found **0.74 s of "speech" in 182 s (2 words
  out of 224)** — it silently deleted the entire song. VAD is now opt-in
  (`--vad`), for spoken-word files with long instrumental stretches where
  hallucination over music is the larger risk.
- **`condition_on_previous_text=False`** — Whisper otherwise conditions each
  window on the last one, which is what makes it emit a looping, repeated line
  across an instrumental break. Against a music bed that is a correctness bug,
  not a nuisance.
- **`small` over `distil-large-v3`** — the "accurate" model is six times larger
  and, on four CPU cores, too slow to return at all. `small` is the smallest
  model whose lyrics are actually usable.

## The bridge to caption-studio

`caption-studio`'s importer is written against Veed's extractor output, and the
plan is explicitly **not** to rewrite it yet. So this studio speaks that format
instead of asking the other one to learn a new one:

```
caption-studio/src/io/veed-json.js
  detectVeedVersion()          needs  obj.canvas          → we emit `canvas`
  blocks read                  sub.start / sub.end        → we emit both
  words read                   w.text / w.s / w.e         → we emit all three
  style copied onto defaults   font/fontSize/posX/posY/align
```

The last row is the subtle one. The importer copies those five values onto its
own `createDefaultStyle()`, so we emit the **verified Veed parity numbers**
(Inter, size `0.036` of width, bottom-right `0.772`/`0.848`, centred) — meaning
the imported document reports itself as *unedited* instead of silently looking
like a style change nobody asked for. The consequence: **importing our output
requires zero changes to `caption-studio`.** Our timings become the timing
authority, and loading an SRT alongside still corrects the spelling exactly as
before.

On emphasis we deliberately invent nothing. Veed's "auto-highlight" picks
*keywords* — a model decision we cannot reproduce, and fabricating ranges would
be the silent guessing this suite forbids. The default emits none; if you want
karaoke highlighting, `caption-studio`'s `emphasis.source = 'active'` needs no
ranges at all.

## What works today

| Area | Status |
|---|---|
| Transcript model + invariants (`text == words.join(' ')`) | ✅ `audio_studio/model.py` |
| Overlap resolution by sliding (durations preserved) | ✅ `audio_studio/model.py` |
| Silence / gap analysis (lead-in, interior, tail) | ✅ `audio_studio/model.py` |
| Native artifact `*.speech.json` + load/save | ✅ `audio_studio/artifact.py`, `emit/native.py` |
| **Veed-master-compatible export** (imports into caption-studio) | ✅ `audio_studio/emit/veed.py` |
| SRT / VTT export, including word-level cues | ✅ `audio_studio/emit/srt.py`, `emit/vtt.py` |
| Engine registry, lazy imports, no-dependency base install | ✅ `audio_studio/engines/base.py` |
| Deterministic offline backend (`--engine fake`) | ✅ `audio_studio/engines/fake.py` |
| CLI: `transcribe` / `emit` / `doctor` / `version` | ✅ `audio_studio/cli.py` |
| Local Whisper transcription (`faster-whisper`) | ✅ `audio_studio/engines/whisper.py` |
| Forced alignment + re-timing | ⏳ Phase C |
| LLM transcript validation + ledger | ⏳ Phase D |
| HTTP server (job queue) for the browser | ⏳ Phase E |

## Install (Windows 11 · Git Bash)

**Never install into the system Python.** Always a local virtualenv:

```bash
cd audio-studio
python -m venv .venv
source .venv/Scripts/activate      # Windows/Git Bash
pip install -e ".[dev]"            # base + test tooling: instant, no heavy deps

# then, for real transcription:
pip install -e ".[asr]"            # faster-whisper + numpy (no PyTorch)

# optional, and heavier:
pip install -e ".[align]"          # torch + torchaudio — precise forced alignment
pip install -e ".[llm]"            # google-genai + httpx — transcript validation
```

Model weights download **lazily** on first use and are cached by
`faster-whisper` outside the repo. `.venv/` and `models/` are gitignored, so the
virtualenv and the weights never land in a commit.

## Use it

```bash
python -m audio_studio doctor                       # what can actually run here
python -m audio_studio transcribe song.mp3          # → out/song.{speech,veed}.json, .srt, .vtt
python -m audio_studio transcribe clip.mp4 --preset balanced --language en
python -m audio_studio transcribe song.mp3 --emit veed --emphasis none --json
python -m audio_studio emit out/song.speech.json --emit srt,vtt   # re-emit, no re-transcribe
```

Progress goes to **stderr**, so `--json` on stdout stays machine-parseable.
`--engine fake` runs the whole pipeline with a deterministic synthetic
transcript — useful for checking the file layout and the caption-studio import
without downloading a model.

Presets: `balanced` (default — `small`), `accurate` (`medium`), `fast`
(`base`). `--model distil-large-v3` is available but only sane with a GPU or
many CPU cores; a 4-core machine will not finish it in a sitting. VAD is
**off**; add `--vad` only for spoken-word audio.

## Test it

```bash
cd audio-studio
source .venv/Scripts/activate
python -m pytest          # 98 tests, no model, no network, no browser
```

The suite is deliberately dependency-free: it runs on `pip install -e ".[dev]"`
and nothing else. A test that needed a 750 MB model to catch a layout bug would
not get run. Where a real audio file is needed, `tests/conftest.py` writes a
valid 16-bit PCM WAV with the standard library `wave` module. The *model*
choices above are pinned by tests too, so a future "remember to turn VAD on"
regression has to argue with the numbers.

Two tests exist specifically to lock the *interfaces* rather than the details:

- one asserts the emitted Veed JSON carries the exact keys
  `caption-studio/src/io/veed-json.js` reads, and that the word texts still join
  back to the line (a word list that does not join back loses or invents a
  space);
- one imports the package in a **subprocess** and asserts `faster_whisper`,
  `torch`, `numpy` and `google.genai` are all still unimported — because the
  moment a heavy backend creeps into a top-level import, the base install stops
  working and everything above it goes down with it.

## Design rules

1. **Pure core.** `model.py`, the emitters and the timestamps import nothing but
   the standard library, and every function is a pure function of its arguments.
   Same input ⇒ byte-identical output, which is what makes a timing change a
   one-line diff instead of a mystery.
2. **No silent guessing.** A long gap, an empty segment, a slid overlap, a
   segment with no word timings — each is *warned about*, never quietly
   corrected. `validate()` separates errors (do not ship) from warnings (ship,
   but tell someone).
3. **Record the provenance.** Every artifact carries the engine, its settings,
   the model, and the SHA-256 of the audio. Two transcripts that disagree over
   the same bytes are then a real disagreement.
4. **Never touch the system Python.** `.venv` or nothing.
5. **Everything git-tracked.** No untracked working copies to lose.

## Document map

| File | Purpose |
|---|---|
| `audio_studio/model.py` | The transcript model, its invariants, gap analysis, validation |
| `audio_studio/artifact.py` | Load / save `*.speech.json` |
| `audio_studio/emit/` | `native`, `veed` (the caption-studio bridge), `srt`, `vtt` |
| `audio_studio/engines/` | Backend interface + registry; `whisper`, `fake` |
| `audio_studio/media.py` | Decoding, hashing, duration probing |
| `audio_studio/config.py` | Presets and defaults, tuned for CPU-only |
| `audio_studio/cli.py` | The command line |
| `pyproject.toml` | Packaging and the optional-dependency extras |
