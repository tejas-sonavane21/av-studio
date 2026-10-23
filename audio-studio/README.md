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
| **Align** *(the actual sync fix)* | `wav2vec2` forced alignment (default), or `w2v-bert` on a music-trained lyrics CTC — optional `[align]` extra | Tightens word onsets to ~20–50 ms. We usually already *have* the words (an SRT/VTT), so we do not have to guess them — known text can be aligned to the waveform. The second backend is measurably better on a sung mix and costs 3× the time; see [below](#a-second-aligner-w2v-bert-measured-against-wav2vec2) |
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

### Which model a preset loads

A preset name is a trade-off, not a model — and the two questions a person has before typing a path
are *which model am I loading* and *is it already here*. `audio_studio/models.py` is the catalogue
that answers both, and `doctor`, `GET /health` and the browser's transcribe panel all render their
answer from it rather than repeating it:

| preset | loads | repository | weights |
|---|---|---|---|
| `fast` | Whisper base | `Systran/faster-whisper-base` | 74 M |
| `balanced` *(default)* | Whisper small | `Systran/faster-whisper-small` | 244 M |
| `accurate` | Whisper medium | `Systran/faster-whisper-medium` | 769 M |
| `best` | distil-whisper large-v3 | `Systran/faster-distil-whisper-large-v3` | 756 M |

`best` is on the menu because the machine is not always a four-core laptop: on a GPU, distil-whisper
large-v3 is `large`'s accuracy for a little over a third of its weights, and leaving it off made the
studio look as though it had no answer for anyone with the hardware to run it. It is listed last,
because it is the one choice here that can take minutes on the machine this was tuned for. The
catalogue is asserted against the installed library's own name map (`tests/test_models.py`), so a
rename upstream fails the suite rather than a run.

The second half is the one that has already cost a day: **is that model downloaded here?** The check
resolves the Hugging Face cache exactly as the hub does (`HUGGINGFACE_HUB_CACHE`, then `HF_HOME`,
then the platform default) and counts only a snapshot with files in it *at the commit the weights are
pinned to*, because an interrupted fetch leaves a directory behind and a directory from last month
holds other weights. The same commit transcribed correctly on one laptop and failed on another,
and the difference was an empty cache — a machine-level fact that used to surface as a hub error
minutes into a job, and is now on screen before one starts:

```
$ python -m audio_studio doctor
  presets       fast, balanced, accurate, best (default: balanced)
    fast       Whisper base (Systran/faster-whisper-base, 74 M) - cached @ebe41f70
    balanced   Whisper small (Systran/faster-whisper-small, 244 M) - cached @536b0662
    accurate   Whisper medium (Systran/faster-whisper-medium, 769 M) - will download @08e178d4
    best       distil-whisper large-v3 (Systran/faster-distil-whisper-large-v3, 756 M) - will download @c3058b47
  model cache   /home/you/.cache/huggingface/hub
    ! not downloaded yet: accurate (Whisper medium), best (distil-whisper large-v3) - the first run fetches it from the hub
```

### The weights are fetched once, and a run says which case it is in

"It feels like it downloads the model every time" is a measurable claim, and the answer is that it
does not. `engines/whisper.py::load_plan()` is the whole of it, and it is pure — the catalogue already
knows whether the snapshot is on disk, and that one fact decides what happens next *and* what a person
is told while it happens:

| the catalogue says | what runs | what the panel shows |
|---|---|---|
| `downloaded: true` | `WhisperModel(..., local_files_only=True)` — a disk read, the hub is never contacted | *"Whisper small is already on this machine — reading it from the cache, no download"* |
| `downloaded: false` | the ordinary hub fetch, once | *"…is not on this machine yet — fetching Systran/faster-whisper-medium, 769 M once; every later run reads it from the cache"* |
| `unknown` (a path, or a hub id not in the catalogue) | passed to the library as given | *"loading …"* |

Measured on this machine, all five models under `~/.cache/huggingface/hub` were already there, and an
uncached lookup cost **1.16 s** where the offline one cost **0.27 s** — per model, per process. Small,
but it is the part that touches the network on *every* run, and it is the reason a machine with no
internet can transcribe from cache at all. A cached snapshot that turns out to be incomplete falls
back to the hub once rather than failing the job.

The model *instance* is cached beside it (`_MODEL_CACHE`, keyed by model, device, compute type and
thread count), because constructing one reparses hundreds of megabytes: measured here, **4.6 s** for
`small`, **11.3 s** for `medium` and for `distil-large-v3`. That is what the first `loaded …` line is
measuring — and why a second run in the same server reports *"already loaded in this server"* instead
of repeating a number it did not spend. Both facts are written into the artifact's provenance, so a
finished file can answer the question later:

```json
"engine": { "model": "small", "modelRevision": "536b0662742c…", "modelSource": "disk", "modelLoadSeconds": 4.61, … }
```

`modelSource` is `disk` when the cache was reused and `download` when this machine did not have the
weights — a run that fetched 769 MB says so, in its own output, rather than looking like a hang.

### A model name is not a version

`small` resolves to whatever `Systran/faster-whisper-small`'s `main` points at *on the day it is first
fetched*, and the hub may move that. Two machines set up a month apart could then load different
weights, transcribe the same recording differently, and have nothing in either output to explain it.
So every model this project measured is pinned to the commit it was verified at — `models.py`,
`MODELS[...]["revision"]`, plus `ALIGN_REVISION` for the wav2vec2 aligner — and both the transcriber and
the aligner hand that commit to the loader:

* `doctor` prints the shortened pin beside every preset, and names the aligner's separately;
* every transcript records it as `modelRevision`, and every alignment records it in its provenance, so
  two machines can be compared instead of guessed at;
* *"is this model downloaded?"* now means *is the pinned snapshot here*: a machine holding an older
  commit reports `will download` and fetches the verified weights rather than quietly using others;
* a model nothing here has verified (`large-v3`, or a hub id from outside the catalogue) has no pin —
  reported as `unpinned` and loaded as given, because an invented revision would look verified;
* **a pin the hub no longer has falls forward to `main`, once, instead of failing the run.** A commit
  can be force-pushed away, and a studio that then refused to transcribe would be broken for a reason
  nobody could act on. It is one retry, and only for a failure that is *about the revision* — a
  repository that is gone, a machine with no network and a missing file are raised as they were,
  because asking for `main` would fail the same way and bury the first error behind a second. When it
  does happen the run says so in its output and in the artifact: `modelRevision` then names the commit
  `main` resolved to — read out of the cache the fetch just wrote — and `modelRevisionFallback`
  carries the sentence, so a transcript that came from other weights is a fact on the file rather than
  something to infer from a date.

### The weights are kept, not just cached

A pin narrows *which commit* a run asks for. It cannot say anything about the files that
machine ended up with: the hub cache records no checksum, so an interrupted download, a bad
disk read or a copy between machines all load, and all produce a different transcript.

The **model store** is the half a cache does not have. It is a directory of weight files with
a manifest of every file's size and SHA-256, and it is used **instead of** the hub when it has
the model:

```bash
# once, on a machine that already has the weights (from the pinned hub cache)
python -m audio_studio models --import all

# on any machine, or the same one: re-hash everything against the manifest
python -m audio_studio models --verify

# copy a model to a USB stick / share, manifest included
python -m audio_studio models --export D:/weights
```

The store holds the set this studio actually runs on: **`medium`** (1.5 GB) and the
`facebook/wav2vec2-base-960h` aligner (361 MB) — 1.8 GB, both `[ok]` under `models --verify`.
`--import all` also takes `base`, `small` and `distil-large-v3`, which is two more gigabytes for
presets nothing here selects; import one by name (`models --import small`) on a machine that
wants it. A preset that is not in the store is not blocked — it just loads from the hub cache,
unverified, and `models` lists it as `missing` so that difference is visible before a run.

The w2v-bert checkpoint is **not** in the catalogue or the store: it is six times the size
of the aligner the store was built for, so `--align-model` takes its hub id (or a local
folder) and the load is unverified, the same trade `models` reports as `missing` for any
preset that was never imported. Add it to `models.ALIGN_MODEL` only if it becomes a
default, because everything that reads that pin - `doctor`, the store manifest, the
provenance in every artifact - would then be describing a different set of weights.

The default location is `audio-studio/models/` (gitignored, because the weights are
hundreds of megabytes). `AUDIO_STUDIO_MODELS` moves it, so three machines can point at one
read-only copy on a share and load the same bytes without each holding 800 MB.

Three rules make it worth having:

* **The store wins.** When it has the model the hub is never contacted, so an offline run is
exactly the same run as an online one.
* **A mismatch is an error, not a fallback.** A corrupted or tampered copy refuses to load
and says which file disagreed. Quietly using the cache instead would transcribe with
weights nobody verified, which is the failure the store exists to prevent.
* **A commit is written once.** Importing different files under the same commit is refused
rather than one of them silently winning; `--overwrite` makes replacing it deliberate.

The digest is computed the same way for a store copy and a hub snapshot, so
`engine.modelWeightsSha256` in an artifact is comparable regardless of which one made it,
and importing the same weights from either place produces the same number.

### The same song, a different laptop

"It is much better on this machine" is the hardest bug report in this studio, because nothing in a
transcript said *what* the run was made of. Two machines can agree on the commit, the preset, the
model name and the recording, and still disagree in the output — so the first job was to find out
which of those assumptions is false. Measured on this 4-core box, 60 s of the 182 s fixture, `small`:

| change | words | word onsets |
|---|---|---|
| `int8`, 4 threads vs 1 thread | 78/78 identical | identical |
| `int8` vs `int8_float32` | identical | identical |
| `int8` vs `float32` | 77/78 | up to **0.30 s** apart |
| `torch` 1 thread vs 4, on the aligner over a 403-word transcript | — | 403/403 identical |

Two conclusions, both worth having before blaming the aligner: **thread count is not the cause**
(the int8 GEMM is exact, and the wav2vec2 path is stable across thread counts), and **the numeric
path is** — a different precision moves the *timings Whisper hands to the aligner*, which is the
input the alignment is built on. The aligner itself is deterministic given a transcript and a clip.

So the differences that survive are: the **weights actually loaded** (a pin can fall forward, a
snapshot can be half-downloaded), the **decoded PCM** (PyAV on one machine, a system `ffmpeg` on
another), the **numeric path** (`compute_type`, and the CPU kernel behind it —
`torch.backends.cpu.get_cpu_capability()` returns `AVX512` on one laptop and `AVX2` on another, which
selects different vectorised kernels), and the **versions of the packages that compute**
(`ctranslate2`, `torch`, `transformers`, `tokenizers`).

`parity` runs one clip through every stage and prints one hash per stage, so the first line that
differs is the answer:

```bash
# on each machine, the same file and the same settings
python -m audio_studio parity song.mp3 --seconds 30

  machine      Windows 10 AMD64  kernel AVX2  torch threads 2
  settings     model small, int8, cpu_threads None
  weights      536b0662742c02347bc0e980a01041f333bce120  363ce3ff…
  stages
  source       191b01cc38e3e2d9…
  pcm          3bb9c35308542d47…
  weights      363ce3ffa6971c4e…
  transcript   ab5184c37f833179…
  emissions    1117955a1156a108…
  alignment    3ded3e3b85fa44a2…
```

* **`source` differs** — not the same bytes. Compare `sha256` of the file.
* **`pcm` differs, `source` does not** — the same file decoded differently. `doctor` names the
  decoder; pin `av`, or give both machines the same WAV.
* **`weights` differs** — the same model name is not the same weights. The pinned commit and the
  hash of the files on disk are printed; `modelRevisionFallback` in the artifact says whether a pin
  fell forward. With the store filled on both machines this line should never differ; when it does,
  one machine is not reading the store.
* **`transcript` differs, `weights` does not** — same weights, different arithmetic. Check
  `kernel`, `compute_type` and the package versions; `--compute-type float32` is the portable
  (slower) setting if the two machines have to match.
* **`emissions`/`alignment` differ but `transcript` does not** — the difference has reached the
  aligner, and the numbers above say from where.

Every artifact now carries the same facts, so a finished file can be compared after the fact without
re-running anything: `source.samplesSha256` (the decoded samples, not the container),
`engine.modelWeightsSha256`, `engine.cpuCapability`, `engine.cpuThreads`,
`alignment.weightsSha256`, `alignment.torchThreads`. And the two knobs that used to have no flag —
`--compute-type` and `--cpu-threads` — are on `transcribe` as well, so a run that behaved differently
can be reproduced on purpose instead of by luck.

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

On emphasis the default invents nothing: Veed's "auto-highlight" picks *keywords*,
and fabricating ranges from a rule would be the silent guessing this suite forbids.
`--emphasis none` (the default) emits none, and if you want karaoke highlighting,
`caption-studio`'s `emphasis.source = 'active'` needs no ranges at all.

`--emphasis auto` is the other honest answer: it writes one range per word the
**LLM validator chose** to emphasise. That choice is part of the same proofreading
request (`validate/llm.py` asks for corrections *and* highlights in one reply),
it is recorded in the ledger as a proposal that changes no text, and the emitter
then turns the recorded word numbers into Veed ranges. So emphasis is a model
decision, made and audited — never a guess. With no highlights recorded, `auto`
emits nothing.

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
| `GET` | `/health` | version, usable engines, presets, emit kinds, and each preset's model + whether it is downloaded |
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

### A second aligner: w2v-bert, measured against wav2vec2

`wav2vec2-base-960h` was trained on read speech; a chorus is not that, and it shows
when a drum fill sits under a vowel. [`mrfakename/w2v-bert-2.0-music-lyrics-ctc`](https://huggingface.co/mrfakename/w2v-bert-2.0-music-lyrics-ctc)
is the same CTC pass over a 921-character checkpoint fine-tuned on **full music
mixes** — and it is six times the weights (2.3 GB, 24 layers). It is a second
backend, not a replacement, because the trade is real:

```bash
python -m audio_studio align transcript.speech.json --audio song.mp3 \
  --align w2v-bert --align-model mrfakename/w2v-bert-2.0-music-lyrics-ctc
```

Measured on `Holding_the_Sky.mp3` (178.8 s, 403 words in 47 segments), same
transcript, same guards, 4 CPU cores, no GPU. `onset` is the mean z-score of a
vocal-band (250–3500 Hz) energy rise at each word start — computed from the
waveform alone, so neither model is scoring itself — and `lift` is that minus the
same measurement 0.25 s later, which a run that just likes loud moments cannot win:

| run | onset | lift | on a rise | emissions | total | peak RSS |
|---|---|---|---|---|---|---|
| Whisper, **no alignment** | +1.63 | +0.17 | 90 % | — | — | — |
| `wav2vec` (the default) | +1.89 | +0.50 | 94 % | 140 s | 160 s | 3.76 GB |
| `wav2vec`, `--align-pad 0.5` | +2.04 | +0.69 | 95 % | 161 s | 183 s | 3.76 GB |
| `w2v-bert`, 20 s window | **+2.10** | **+0.71** | 98 % | 454 s | 477 s | **3.43 GB** |
| `w2v-bert`, 15 s window | +2.09 | +0.69 | 97 % | 451 s | 495 s | 3.21 GB |

The averages hide the part that matters, so the two clocks were also scored word
by word: of 403 words, 129 are placed more than 100 ms apart, and the w2v-bert
placement scores higher on 78 of them against 49 for wav2vec2 (sign test over the
paired scores, z = −2.6). The 960h clock is not *wrong* on those words — both
clocks clear the same guards and both keep all 47 segments — the music-trained one
is more often on the consonant.

What that costs is the whole argument for keeping wav2vec2 as the default: **3× the
wall time** for the same song, a 2.3 GB download against 361 MB, and about 3 s of
loading before it starts. Peak memory is actually *lower*, because a 20 s window cap
does what the 960h pass does with the whole file at once. Two settings matter and
both were measured rather than copied: 20 s windows are the cheapest size that keeps
the onsets (30 s needed 181 s of emissions on a 60 s clip where 20 s needed 115 s,
and 10 s was slower than both), and `bfloat16` weights do not run on a CPU in
torch 2.14 (`layer_norm` refuses the mixed dtype), so `float32` stays.

The scripts are `out/eval/aligner-bench.py` (the sweep, the per-word duel and the
peak-RSS sampler) and `out/eval/bench_one.py` (one configuration per process, so
the memory numbers do not add up across models). They are scratch, and `out/` is
ignored; the numbers above are what they printed on this machine.

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
| `balanced` + `--reference spidy.srt` | `small` | ~82 s | **0.0 %** | nothing — these are the lyric sheet's own words, placed on the audio |

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

#### When the words already exist, use them

Everything above is a *proofreading* strategy: it makes a guess better. If the user
has the words themselves — a `.srt`, a `.vtt`, or a plain lyric sheet — there is no
guess left to improve, and `--reference FILE` takes them instead:

```bash
python -m audio_studio transcribe song.mp3 --reference spidy.srt --align wav2vec
```

Measured on the same fixture, both transcripts above score **0.0 %**:

| transcript | WER | with `--reference spidy.srt` |
|---|---|---|
| `balanced` (`small`) | 11.8 % | **0.0 %** — 255 words, S 0 D 0 I 0 |
| caption-studio's corrected document | 8.2 % | **0.0 %** |

What it does in one line: **the words come from the file, the timing still comes
from the audio.** The two word streams are aligned, and then

* a word the file spells differently is **rewritten in place**, keeping the
transcriber's measured window — `whould` becomes `would` without moving;
* a word the audio missed is **inserted**, timed by interpolation between its
neighbours and marked `interpolated: true` in the artifact;
* a word the audio invented is **deleted**.

Two things in that list are load-bearing, and both are deliberate.

**It runs before alignment, not after.** An inserted word arrives with a made-up
window, and the next rung's whole job is to replace made-up windows with measured
ones. Run the reference pass afterwards and the words it adds keep a time nobody
measured; run it first and `--align wav2vec` re-times every one of them. That is
why `pipeline.py` fixes the order as
`transcribe → reconcile → align → validate`.

**The mapping is solved, not approximated.** Which file word is which transcript word
is a minimum-edit alignment of the two word lists, decided once for the whole file,
because one wrong anchoring moves the window of every word after it. The obvious
library call — `difflib.SequenceMatcher` — is *not* that algorithm: it anchors on the
longest matching block, and a lyric sheet is a repeated chorus, so anchoring the wrong
repetition strands whole lines of a transcript that was fine. Measured on a rap track
with a word-for-word subtitle file mirrored from the same song:

| alignment | lyric words matched | worst gap in the timeline |
|---|---|---|
| `difflib` (longest block first) | 234 of 404 | **48.1 s** |
| minimum-edit (this pass) | **347 of 404** | 3.1 s |

That difference costs nothing to collect: the common prefix and suffix are peeled off
first — for a reference pass they are most of the file — and the rest is solved inside a
diagonal band wide enough to hold the answer, widened if it is not. The whole pass runs
in **0.19 s** on that file against a **0.88** match rate, and a transcript that cannot be
confirmed inside the budget is refused exactly like a sheet that is not this song.

**A sheet that is not this song is refused, not applied.** A wrong lyric file is the
worst failure available here, because rewriting a transcript with confident nonsense
*looks* like success. So the pass measures how much of the audio and the file agree
and, below `--reference-min-match` (default `0.5`), changes nothing, records why, and
warns. On this project's own material the two agree on **88 %** and **94 %** of words,
so the floor has a great deal of room under it: what it catches is a wrong file, not a
hard recording.

Reading the file is a pass of its own rather than a validation backend, and
`validate/ledger.py` is the reason. That ledger refuses *by construction* any proposal
that changes the word count, because inserting or deleting a word moves the timing of
everything after it. Reconciling with the real lyrics **is** changing the word count.
So it keeps its own ledger, its own record in the artifact, and its own rules — and
every rewrite, insertion and deletion is in that record, indexed against the
transcript as it was before the pass.

One reading detail is worth knowing because it is invisible when it goes wrong. The
reference file for this project is a **rolling** subtitle file: every cue repeats the
lines above it and adds one. Read naively, that multiplies the whole lyric sheet
several times over — the first version of this parser turned 255 words into 753 — and
read as "the last line of each cue" it loses the first cue's *first* line instead. So
the parser **measures** the file: it computes the overlap between each cue and the one
above, reads the file as rolling only when that overlap is the rule rather than the
exception, and says which reading it used. Read this way the file is **255 words**,
exactly what `out/wer.py` parses by hand to score the table above — and that agreement
is what makes the score trustworthy.

Because the text is now the file's, `--validate llm` has nothing left to guess.
Running both is allowed and recorded as a warning, but it is not worth doing: the only
correction that pass can still propose is one that disagrees with the lyrics.

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
| Model catalogue — what each preset loads, and whether this machine has it | ✅ `audio_studio/models.py` |
| Local Whisper transcription (`faster-whisper`) | ✅ `audio_studio/engines/whisper.py` |
| HTTP server (job queue) for the browser | ✅ `audio_studio/server.py` |
| **Forced alignment** (`wav2vec2` CTC, 20 ms frames) | ✅ `audio_studio/align/wav2vec.py` |
| Music-mix aligner (`--aligner w2v-bert`, w2v-bert lyrics CTC) | ✅ `audio_studio/align/w2vbert.py` |
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
pip install -r requirements.txt    # the pinned set — this is the install
pip install -e . --no-deps         # the package itself, which that list omits on purpose
```

**This, and not the extras, is the install.** `pyproject.toml` is the flexible view:
its extras set only *lower* bounds, so `pip install -e ".[asr]"` on a fresh machine
resolves to whatever is newest that day — and the `av`/`faster-whisper` pair is the
combination where that is fatal. `faster-whisper` calls `av.open(...)` with a keyword
`av` 19 removed, so on a newer `av` every decoder fails and the error blames a missing
`ffmpeg` binary that was never needed. `requirements.txt` pins the versions this project
was built and verified against, and explains that pin beside the line that makes it.

The extras still work, and still mean what they say — for a machine where you want the
newest of everything and are willing to find out:

```bash
pip install -e ".[dev]"            # base + test tooling: instant, no heavy deps
pip install -e ".[asr]"            # faster-whisper + numpy (no PyTorch)
pip install -e ".[align]"          # torch + torchaudio — precise forced alignment
pip install -e ".[llm]"            # google-genai + httpx — transcript validation
```

Model weights download **lazily** on first use and are cached by
`faster-whisper` outside the repo. `.venv/` and `models/` are gitignored, so the
virtualenv and the weights never land in a commit.

## Configure a key (only for `--validate llm`)

Nothing else needs a key: transcription, alignment and every emitted caption file
work with none. The hosted validation pass does, and it reads one from the process
environment — with a `.env` file loaded underneath it, so there is no `export` step to
remember:

```bash
cp .env.example .env      # in audio-studio/ - the studio ships its own template
# then edit .env and set GEMINI_API_KEY=...
```

**This studio runs standalone.** It is not required to sit inside the `web_av_editor`
tree, so the template travels with it: `audio-studio/.env.example` is the one to copy
when you are working in this folder, and the suite root carries the same file for a run
started from `caption-studio`. What the walk finds is the file nearest to where you
start - the working directory and its four nearest parents are searched, then the
repository root beside the package - so a checkout of just this folder is a complete
install, key setup included, and `.env` is gitignored in both places so neither can
publish a key.

The rules are `audio_studio/env.py`'s, and there are three of them:

* a **real environment variable always wins** — `.env` never overrides something you
  exported deliberately, so CI and containers keep working unchanged;
* the file is looked for in the working directory, its four nearest ancestors, then the
  repository root — the walk is bounded so a `.env` from an unrelated project is never
  picked up;
* `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_GENAI_API_KEY` are all accepted, in
  that order, plus `OPENROUTER_API_KEY` for the alternative provider.

`.env` is gitignored. `.env.example` is committed and holds placeholders.
`python -m audio_studio doctor` ends its `validators` section with which of the two it
can actually see, and says `key from the environment or .env` when one was found —
without ever printing the key itself.

## Use it

```bash
python -m audio_studio doctor                       # what can actually run here
python -m audio_studio transcribe song.mp3          # → out/song.{speech,veed}.json, .srt, .vtt
python -m audio_studio transcribe clip.mp4 --preset balanced --language en
python -m audio_studio transcribe song.mp3 --emit veed --emphasis none --json
python -m audio_studio emit out/song.speech.json --emit srt,vtt   # re-emit, no re-transcribe

python -m audio_studio transcribe song.mp3 --align wav2vec            # re-time every word from the audio (the default)
python -m audio_studio transcribe song.mp3 --align w2v-bert \
  --align-model mrfakename/w2v-bert-2.0-music-lyrics-ctc                # the music-trained one
python -m audio_studio transcribe song.mp3 --align wav2vec --validate rules
python -m audio_studio transcribe song.mp3 --reference lyrics.srt --align wav2vec

python -m audio_studio models --import all            # fill the verified store, once
python -m audio_studio models --verify                # re-hash it
python -m audio_studio parity song.mp3 --seconds 30   # where do two machines stop agreeing?
```

### What a run leaves behind

Every emit writes beside its own outputs a `<stem>.run.json`: what produced it, the
source file with its **SHA-256** (the same hash the transcript records, so a manifest and
an artifact can be shown to be about the same bytes), and every file the run wrote, with
sizes. Two runs over different recordings no longer overwrite each other silently — the
second writes its own manifest, and `find_manifests()` is what `caption-studio`'s run
list reads to offer them.

Names are sanitised (`emit/safe_stem`), and identically on the browser side: a path is not
a name, so only its last segment survives, and a character a filesystem refuses becomes
`_`. `--stem ../../notes/attack` writes `out/attack.srt` and never leaves the output
directory.

```json
{
  "tool": "audio-studio", "stem": "song",
  "source": { "file": "song.mp3", "sha256": "…", "durationSeconds": 181.734 },
  "outputs": [ { "kind": "srt", "file": "song.srt", "bytes": 2578 } ],
  "summary": { "segments": 31, "words": 248, "warnings": [] }
}
```

And the rest of the commands:

```bash
python -m audio_studio align out/song.speech.json --audio song.mp3    # re-time a saved transcript
python -m audio_studio validate out/song.speech.json --validate llm   # needs a key
python -m audio_studio validate out/song.speech.json --validate llm --provider openrouter
```

`--align` and `--validate` are both **off** unless asked for: one downloads a
360 MB acoustic model, the other can spend money. A default that did either would
be worse than no default.

The two passes have different authorities, and the split is the whole design:

| | authority | may change |
|---|---|---|
| `align` (`wav2vec2` / `w2v-bert` CTC) | **timing** | `start` / `end`, and nothing else |
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
(`base`), `best` (`distil-large-v3`, only sane with a GPU or many CPU cores;
a 4-core machine will not finish it in a sitting). `python -m audio_studio
doctor` prints which model each one loads, how big it is, and whether it is
already in the local cache. VAD is **off**; add `--vad` only for spoken-word
audio.

## Test it

```bash
cd audio-studio
source .venv/Scripts/activate
python -m pytest          # 418 tests, no model, no network, no browser
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
| `audio_studio/align/` | `ctc` (pure trellis), `wav2vec`, `w2vbert`, `fake`, `apply` (the guards) |
| `audio_studio/validate/` | `rules`, `llm`, `ledger` (the corrections audit trail) |
| `audio_studio/pipeline.py` | The order the optional passes run in, in one place |
| `audio_studio/media.py` | Decoding, hashing, duration probing |
| `audio_studio/config.py` | Presets and defaults, tuned for CPU-only |
| `audio_studio/cli.py` | The command line |
| `audio_studio/server.py` | The local HTTP job server for `caption-studio` |
| `pyproject.toml` | Packaging and the optional-dependency extras |
