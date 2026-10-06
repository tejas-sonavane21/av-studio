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
| `small` | ~78 s | ~2.3× | **16.7 % WER** against the reference lyrics |
| `medium` (`accurate`) | ~291 s | ~0.6× | **11.6 % WER** — the best of the three that finishes |
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

## Choosing a flow: accuracy, latency, and the free tier

Three measurements settle the defaults. All of them are reproducible against the
real fixture with the scratch scripts in `out/` (gitignored), and none of them is
a claim about a benchmark table.

### 1. Text quality: score the transcripts against the lyrics

Word-level edit distance between each transcript and the reference lyrics in
`referece_material/spidy.srt` (case and punctuation folded away, so only real
word errors count):

| preset | model | wall time | **WER** | what is left to fix by hand |
|---|---|---|---|---|
| `fast` | `base` | ~25 s | garbled | too many to be worth it |
| `balanced` *(default)* | `small` | ~82 s | **11.8 %** | `awoke` → `woke`, `of`/`a`, the `hero's burden` / `warrior's soul` pair, `memorial`/`mortal`, `cast`/`catch`, `tool`/`toll`, `i'm`/`road` — and a hallucinated `Music` before the first line |
| `balanced` + `--validate llm` | `small` | ~82 s + seconds | **7.8 %** | `fly`/`try`/`fight`, `loss`/`lost`, `innocent`/`innocents` |
| `accurate` | `medium` | ~291 s | **6.7 %** | `moral`/`mortal`, `steal`/`shield`, `sailing`/`swinging`, `cast`/`catch`, `lost`/`loss` |

`medium` costs **~291 s against `small`'s ~82 s** — 3.5× the wall clock, on four
cores, for the whole track — and almost every error it leaves behind is a
**homophone**: right sound, wrong word. That is a proofreading decision, not a
listening one, which is the hosted `validate` pass's entire job. So the flow the
numbers support is:

1. `--preset balanced --align wav2vec` — the fast model for the words, the audio
   for the timing;
2. **`--validate llm`**, which is what actually closes the gap: measured on the
   real song it took `small` from **11.8 % to 7.8 %**, for a few seconds instead of
   209 extra ones. Ten of its twelve corrections were right
   (`memorial → mortal`, `cast → catch`, `tool → toll`, `road → rope`,
   `taste → chains`, `heroes → hero's`, `burn → burden,`, `worry → warrior's`,
   `Our → A`), and two were wrong: it turned `woke` into `spark` instead of
   `awoke`, and `to` into `whole`. That is the ledger earning its keep — every
   proposal, accepted or not, is in the artifact and auditable — but it is not a
   reason to trust the pass unread.

Note which way that cut: `medium` *still* gets `mortal`/`cast`/`shield` wrong, and
the text pass fixes exactly those. The two are complementary, and the cheap one is
the one worth running.

`--validate rules` is an **alternative** to the hosted pass, not a warm-up for
it. It is offline, free, and honest about what it is: a **reporter, not a
correcter**. It never rewrites a word — on the real song it proposed 6 findings
and applied **0**, so the WER did not move at all. What it finds is the
transcriber's *mechanical* tells, which no model is needed for: an empty word, a
punctuation-only token, a zero-length timing left behind by an overlap being
resolved, and a word repeated within 0.3 s across a musical break. Run it to see
those, and to exercise the correction ledger with no network and no key.

A three-minute song costs one or two text requests, and the alignment is the only
slow, model-bearing step. That is the "fast yet accurate" path: **do not buy
accuracy with the big ASR model, buy it with the cheap text pass.**

### 2. Time mapping: which clock is actually early

A global shift sweep against the waveform: for each clock, find the single offset
that best lines its word onsets up with the audio's energy rises. A **positive**
best shift means the clock is running **early** (it has to be pushed later).
Scored against a vocal-band energy flux (250–3500 Hz), because on a sung track a
drum or a guitar hit can lead the voice and make a clock look unbiased against
the full mix while still sounding early to a listener:

| clock | vs the full mix | vs the voice band |
|---|---|---|
| Whisper `small`, **no alignment** | **+0.58 s** | +0.12 s |
| `--align wav2vec` | −0.02 s | +0.00 s |
| after caption-studio's own aligner | −0.04 s | +0.00 s |

The "words appear before they are heard" symptom lives on the **first** row. It
has one cause and it is not the aligner: Whisper pins every segment's first word
*exactly* to the segment's leading edge (all 41 segments, gap `+0.000`), and a
segment's leading edge is wherever the silence before the singing stopped — so
the caption is on screen for the length of that lead-in. `--align wav2vec` moves
the first word off the boundary (mean gap `+0.249 s`) and the bias goes to zero.
The scripts are `out/shift_sweep.py` (the sweep) and `out/vocal_onset.py` (the
band split).

### 3. The free tier: what is uploaded, and what actually runs out

**The validation pass uploads text, never media.** The hosted call receives a
numbered list of the words in batches (`batch_words`, default 220) plus a short
system instruction, at `temperature = 0`. The audio, the video and the file are
never sent — a three-minute song is one or two small requests. So a quota error
is never about the size of the recording.

Gemini's free tier, from the provider's own documentation:

- Limits are metered **per project, not per API key** — issuing another key under
  the same project changes nothing.
- Three counters apply at once — **requests/minute, tokens/minute, requests/day**
  — and exceeding *any* one returns the same opaque `429 RESOURCE_EXHAUSTED`.
- The **requests/day** counter resets at **midnight Pacific**.
- The Flash models are **free of charge** on the Standard free tier; the **Pro**
  models are not on the free tier at all. Naming a Pro model is the quickest way
  to a 429 that has nothing to do with a quota.
- The numbers themselves change, so they are not copied here. Read the live values
  for your own project at **Google AI Studio → Rate limits**.

Measured against this project's own key: it can see 61 models, and one-word real
requests succeed on the configured pair — `gemini-3.5-flash-lite` and its fallback
`gemini-3.1-flash-lite`. `gemini-3.8-flash` was returning `503 UNAVAILABLE` in the
same minute, which is the part that matters here: availability on the free tier is
**intermittent** rather than exhausted, and the same model answers a minute later.
So `--llm-model` is the escape hatch, and the error names every model that was
tried.

That is also why a 429 is **not** retried on the next model. `MODEL_UNUSABLE_CODES`
is only `404` and `503` — retired, or busy — because silently swapping models on
an exhausted quota would hide the one fact the caller needs: the project is out of
budget. A 429 raises `QuotaError` instead, carrying the provider's own name for
the limit, its `retryDelay`, and how many batches the run got through before it
stopped. `--llm-model` will point the pass at a model you know is free, and the
studio does not guess which ones those are.

### Waiting out a spike: the cool-down

Because a spike is normal weather on the free tier, a refusal is not the end of the
pass — it is a wait. Which wait depends on what was refused and on which model
refused it, and the numbers are pinned by a test rather than left to taste:

| Situation | What the pass does |
|---|---|
| The **named** model answers `503` | waits **10 s**, then spends the fallback |
| A **fallback** model answers `503` | waits **15 s**, and retries it **once** |
| ...once that model has answered `RESOURCE_EXHAUSTED` **twice** | the full **15 → 30 → 60 → 120 s** ladder opens for it |
| A model answers `404` — retired | swapped **immediately**: a retired name does not come back |
| A rejected key, or the first `RESOURCE_EXHAUSTED` | raised untouched and explained |
| Every request after the first | spaced **6 s** apart (≈10/min), so a long transcript cannot walk into the per-minute limit |

Two asymmetries in that table are deliberate. The exponential ladder has to be
**earned**: a transient spike costs fifteen seconds, not four minutes, because
waiting minutes for something that clears in seconds is the failure mode a busy free
tier invites. And the accounting is **per model**, so a saturated fallback cannot
slow down a model that is answering fine.

A `RESOURCE_EXHAUSTED` still stops the run — it is the caller's allowance, and
swapping models would hide it — but it is now *counted*, and two of them are what
earn the ladder. The counts live for the life of the process, which is what this
studio's server is: two exhausted quotas noticed by one job are remembered by the
next. The failure that arms a model says so in its own text, so a run that waits
four minutes explains where the minutes went.

Measured end to end against the real API: asking for the busy `gemini-3.8-flash`
waited, moved to `gemini-3.1-flash-lite`, and came back with an answer in **20 s**. A
raw single SDK call to that busy model raises in **2.7 s**, so almost all of that
time is the studio's own policy — the SDK is not stacking invisible retries
underneath it, and the number in the table is the number you actually wait.

The waits are not slept through in the test suite: `tests/conftest.py` replaces the
module's clock with one that records each wait instead of taking it, so the whole
policy is asserted in milliseconds, on the order and the number of waits rather than
on a stopwatch.

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
python -m pytest          # 255 tests, no model, no network, no browser
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
- **The cool-down schedule.** The same file scripts a busy model, an exhausted
  quota and a retired name onto that local provider, and asserts the *waits the
  pass asks for*: one 10 s hop to the fallback, one 15 s retry before the ladder is
  earned, then 15 → 30 → 60 → 120 once it is, and nothing at all for a retired
  name. The clock is faked for the whole directory (`tests/conftest.py`), so this
  is free in time, and one test pins the five numbers themselves — they are a
  product decision, not a detail of the code.

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
