# Audio Studio

The **audio-side studio** of the `web_av_editor` suite: a local, Python-driven
**speech-to-text and word-timing engine** with an auditable validation layer.

Where [`caption-studio`](../caption-studio) owns the *caption* timeline — text,
style, placement, the render — this studio owns the *audio* timeline: what was
said, **when exactly each word was said**, where the silence is, and whether the
transcript can be trusted.

> **Status: Phases A–E complete, and verified against the real song.** The
> transcript model, the four emitters (native JSON, Veed-compatible master JSON,
> SRT, VTT), the engine registry with a deterministic offline backend, the CLI,
> **real local transcription via `faster-whisper`**, the **local HTTP job
> server**, **forced alignment** and the **validation layer with its corrections
> ledger** are all built. **247 tests pass with *zero* third-party packages
> installed**, so the pure layers can never be blocked behind a model download —
> and the whole bridge is verified end-to-end against the real 182 s track by
> [`caption-studio/tools/e2e-audio-studio.mjs`](../caption-studio/tools/e2e-audio-studio.mjs),
> which runs the real server and imports the answer through caption-studio's own
> client and importer.

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

The drift is measurable, so it was measured. Diffing the Veed master JSON for
the reference track against timings taken from the waveform itself:

| | Veed (inherited) | measured (this studio) |
|---|---|---|
| mean word span | **0.238 s**, floor 0.08 s | 0.569 s |
| first word of line 1 | starts 15.20 s | starts 13.18 s |
| `Just` | 15.20 → 15.28 (0.08 s) | 13.18 → 14.42 (1.24 s) |

A word span that is *the same 0.08 s for `Just`, `an`, `ordinary` and `boy`* is
a marker, not a duration — Veed is not measuring the waveform. Those spans are
exactly what a split uses: the cut lands on the midpoint between two words, so a
timing that is 0.2–0.8 s early makes every split, join and reveal inherit the
authority to place text somewhere it was never sung.

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

## The server (how `caption-studio` actually calls this)

A browser app cannot spawn a Python process, so the studio it hands audio to has
to answer over HTTP. `python -m audio_studio serve` does that, and it is the only
network surface in the suite.

```bash
python -m audio_studio serve --port 8756            # binds 127.0.0.1 by default
python -m audio_studio serve --preset balanced      # the engine/preset jobs inherit
```

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | version, usable engines, presets, emit kinds |
| `POST` | `/transcribe` | `{path, engine?, preset?, model?, language?, emit?, emphasis?}` → `202 {jobId}` |
| `GET` | `/jobs/{id}` | status, progress, and (when done) `files` + `urls` |
| `GET` | `/jobs/{id}/{kind}` | the artifact itself — `kind` is `json`, `veed`, `srt` or `vtt` |
| `GET` | `/jobs` | every job, newest first |
| `DELETE` | `/jobs/{id}` | forget a job (its files stay on disk) |

Three properties are deliberate:

- **Loopback only, by default.** Nothing here is meant to be exposed; the
default should not tempt anyone to try.
- **Stdlib only.** `http.server` and one thread — no Flask. The base install has
to stay instant.
- **One worker.** Transcription saturates four cores, so two jobs in parallel
  would finish later than the same jobs in sequence. Jobs queue.

The workflow mirrors how the browser already thinks: POST a job, poll it, then
fetch the artifact. `GET /jobs/{id}/veed` returns the very payload the importer
already understands, so connecting the two studios is one `fetch`:

```js
const { jobId } = await fetch("http://127.0.0.1:8756/transcribe", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: "C:/media/song.mp3", language: "en" }),
}).then((r) => r.json());

let job;
while ((job = await fetch(`http://127.0.0.1:8756/jobs/${jobId}`).then((r) => r.json())).status !== "done") {
  await new Promise((r) => setTimeout(r, 500));   // job.progress is 0..1
}

const veedMaster = await fetch(`http://127.0.0.1:8756/jobs/${jobId}/veed`).then((r) => r.json());
```

Responses carry `Access-Control-Allow-Origin: *` and answer `OPTIONS`, because
the caller is a different origin and the browser will preflight without them.

## The fix, measured on the real song

Every number below came out of
[`caption-studio/tools/e2e-audio-studio.mjs`](../caption-studio/tools/e2e-audio-studio.mjs),
which starts this studio's real HTTP server, uploads the real 182.5 s track with
caption-studio's real client module, and feeds the answer to caption-studio's real
importer. 4 CPU cores, no GPU.

| Step | Result |
|---|---|
| `--preset balanced` (`small`, int8) | 41 segments, 250 words, **82 s** wall (~2.2× realtime) |
| `--align wav2vec` added | **239 s** total, first run of the acoustic model |
| alignment coverage | 39/41 segments, mean confidence **0.585**, mean **onset shift 0.234 s** |
| guards that fired | 8 words pulled back inside their own segment; 2 segments slid 0.06 s — and both were *reported* |
| import fidelity | 250/250 words, every timing identical to < 1 µs, `validateDocument()` clean |

Why the alignment matters is one comparison from that run. The opening line
(sung *"Just an ordinary boy / Lost in the crowd"*) is **measured** at 13.18 s;
the reference `spidy.srt` cue opens at 12.00 s; and after the quality correction
the editor ends up using **13.40 s**. The measurement wins. That is the exact
inversion of what used to happen when caption-studio inherited its word timings
from Veed — where every word span was 0.08 s long and started up to 2 s late, so
the midpoint a split cuts on was never on the audio.

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
| CLI: `transcribe` / `emit` / `align` / `validate` / `doctor` / `serve` | ✅ `audio_studio/cli.py` |
| Local Whisper transcription (`faster-whisper`) | ✅ `audio_studio/engines/whisper.py` |
| HTTP server (job queue) for the browser | ✅ `audio_studio/server.py` |
| **Forced alignment** (`wav2vec2` CTC, 20 ms frames) | ✅ `audio_studio/align/wav2vec.py` |
| Pure CTC core — no torch, no numpy, hand-testable | ✅ `audio_studio/align/ctc.py` |
| Guarded re-timing (confidence / shift / window / shape) | ✅ `audio_studio/align/apply.py` |
| Offline aligner (`--align fake`: no model, no decoder) | ✅ `audio_studio/align/fake.py` |
| **Validation + corrections ledger** (offline `rules`) | ✅ `audio_studio/validate/rules.py`, `ledger.py` |
| Hosted validation (`google-genai` / OpenRouter) | ✅ `audio_studio/validate/llm.py` |
| Pass order: `transcribe → align → validate → emit` | ✅ `audio_studio/pipeline.py` |

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

python -m audio_studio transcribe song.mp3 --align wav2vec            # re-time every word from the audio
python -m audio_studio transcribe song.mp3 --align wav2vec --validate rules
python -m audio_studio align out/song.speech.json --audio song.mp3    # re-time a saved transcript
python -m audio_studio validate out/song.speech.json --validate llm   # needs a key
```

`--align` and `--validate` are both **off** unless asked for: one downloads a
360 MB acoustic model, the other can spend money. A default that did either would
be worse than no default.

The two passes have different authorities, and the split is the whole design:

| | authority | may change |
|---|---|---|
| `align` (`wav2vec2` CTC) | **timing** | `start` / `end`, and nothing else |
| `validate` (`rules`, `llm`) | **spelling** | `text`, and nothing else |

Neither can do the other's job. Alignment never rewords a lyric — a pass that
could would leave nothing to check it against — and a correction that would
insert, delete or split a word is *refused and recorded*, because that changes the
word count and therefore the timing of everything after it.

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
python -m pytest          # 247 tests, no model, no network, no browser
```

The suite is deliberately dependency-free: it runs on `pip install -e ".[dev]"`
and nothing else. A test that needed a 750 MB model to catch a layout bug would
not get run. Where a real audio file is needed, `tests/conftest.py` writes a
valid 16-bit PCM WAV with the standard library `wave` module. The *model*
choices above are pinned by tests too, so a future "remember to turn VAD on"
regression has to argue with the numbers.

What the newer tests are built around:

- **The guards, not the model.** `tests/test_align.py` drives `apply_alignment`
  with hand-written spans, so every branch is reachable in milliseconds:
  a segment under the confidence floor, a word that would have to travel 17 s,
  a span list of the wrong length, an unalignable word being interpolated, and
  the window rule that stops a leak compounding into a lag. The last one
  documents a real regression: an earlier version of `apply.py` paired the
  aligned spans against the front of the word list, so a skipped word slid every
  later span onto the wrong word and a 17 s misplacement passed a 1 s guard.
  There is now a test with exactly that shape.
- **The ledger's one promise.** `tests/test_validate.py` asserts that applying a
  full ledger to an aligned transcript leaves *every timing byte-identical*,
  that a proposal quoting the wrong text is `stale`, that a replacement with a
  space in it is `unsafe`, and that two proposals for one word are a patch
  series rather than a tally.
- **The CTC core with no torch.** `tests/test_ctc.py` checks the trellis on
  hand-written emissions: repeated labels, ties broken the same way every time,
  the trailing-blank case, and the refusal to allocate an absurd window.
- **The hosted path over real HTTP.** The Gemini free tier was returning 503 for
  an entire session while this was written, so `tests/test_llm_transport.py`
  stands up a **local provider** and points the *real* `google-genai` SDK at it.
  The SDK's own request/response path is therefore covered without a network, a
  key, or a good day at the provider.

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
6. **One authority per property.** The aligner owns *when*; the validator owns
   *what*. Neither may write the other's field, and both are tested on it —
   because the single worst outcome for this suite is a "fix" that quietly
   rewords a lyric or moves a caption it was only asked to spell-check.

## Document map

| File | Purpose |
|---|---|
| `audio_studio/model.py` | The transcript model, its invariants, gap analysis, validation |
| `audio_studio/artifact.py` | Load / save `*.speech.json` |
| `audio_studio/emit/` | `native`, `veed` (the caption-studio bridge), `srt`, `vtt` |
| `audio_studio/engines/` | Backend interface + registry; `whisper`, `fake` |
| `audio_studio/align/` | `ctc` (pure trellis), `wav2vec`, `fake`, `apply` (the guards) |
| `audio_studio/validate/` | `rules`, `llm`, `ledger` (the corrections audit trail) |
| `audio_studio/pipeline.py` | The order the optional passes run in, in one place |
| `audio_studio/media.py` | Decoding, hashing, duration probing |
| `audio_studio/config.py` | Presets and defaults, tuned for CPU-only |
| `audio_studio/cli.py` | The command line |
| `audio_studio/server.py` | The local HTTP job server for `caption-studio` |
| `pyproject.toml` | Packaging and the optional-dependency extras |
