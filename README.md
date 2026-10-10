# AV Studio

**Two cooperating studios over audio and video.** One edits the *captions* — text, style, placement,
the cut, the render, the exported file. The other works out *what was said and when*, with the timing
audited rather than guessed.

Both run locally. No account, no upload, no build step in the browser half, and no runtime npm
dependency at all in it.

| | Studio | Owns | Stack |
|---|---|---|---|
| `caption-studio` | [`caption-studio/`](caption-studio) | the **caption** timeline: 10 Veed/CapCut-style templates, direct-manipulation placement with snapping, a CapCut-style timeline that cuts video *and* audio, a real offline export (WebCodecs → `.mp4`/`.webm`, rendered frame by frame, never screen-recorded), and a corrections ledger | browser, ES modules, **zero runtime npm deps**, no bundler |
| `audio-studio` | [`audio-studio/`](audio-studio) | the **audio** timeline: speech-to-text, per-word timing, forced alignment, silence detection, and a validation layer with an auditable ledger | Python, `faster-whisper`, optional wav2vec2 alignment, optional LLM validation |

Each half is useful on its own. `caption-studio` edits a document you already have an `.srt`, `.vtt`,
CapCut/Veed JSON or the built-in demo for; reach for `audio-studio` when you need the timings to come
*from the audio*.

## How the two fit together

A browser cannot spawn a Python process, so `audio-studio` exposes exactly one network surface — a job
server on localhost — and `caption-studio` talks to it:

```
caption-studio (browser)                       audio-studio (Python)
  Transcribe tab                                 python -m audio_studio serve
  upload audio  ──────────────────────────────▶  POST /transcribe   → 202 {jobId}
  poll progress ──────────────────────────────▶  GET  /jobs/{id}
  import captions ◀──────────────────────────    GET  /jobs/{id}/{json|veed|srt|vtt}
  ── then edit, cut, style, export locally ──
```

The default address is `http://127.0.0.1:8756`, editable in the Transcribe tab. Nothing leaves the
machine unless you point the studio at a hosted validation model, which is off by default.

Two design rules hold the seam together, and both are the reason the bridge can be trusted:

* **`align` owns timing, `validate` owns spelling.** A pass that could do both would leave nothing to
  check it against, so alignment never rewords a line and a correction that would insert, delete or
  split a word is refused and recorded.
* **A cut is a gap in the source, not a ripple.** Captions, the preview and the export all read one
  source clock, so a caption can never end up drawn over the wrong frame.

## Requirements

* **Node 24+** for `caption-studio` (developed on v24.21.0). No dependencies to install — the test
  and dev tooling is Node's own.
* **Python 3.10+** (3.11 tested) for `audio-studio`, in a **virtualenv**. Never the system Python.
* **Chrome** for the UI smoke test and for the export (WebCodecs).
* The instructions are written for **Windows 11 + Git Bash**; everything is POSIX shell syntax, so
  macOS and Linux work with the obvious substitutions.

## Quick start

### 1. The caption studio

```bash
cd caption-studio
npm run serve            # → http://localhost:8000
```

Open that address and click **Demo document** to start with something on screen, or drop in an audio
file, a `.srt`/`.vtt`, or a Veed/CapCut caption JSON.

A server is required: ES modules, Web Workers and `captureStream` do not work from `file://`.
`tools/serve.mjs` is a zero-dependency static server, so Python is not needed to run this half.

> Stopping it on Windows: `kill $!` does **not** work from Git Bash — the bash job PID is not the
> Windows PID, so the port stays held. Use `netstat -ano | grep :8000`, then `taskkill //F //PID <pid>`.

### 2. The audio studio (only for transcription)

```bash
cd audio-studio
python -m venv .venv
source .venv/Scripts/activate        # Windows/Git Bash
pip install -e ".[dev]"              # base + test tooling: instant, no heavy deps

pip install -e ".[asr]"              # faster-whisper + numpy — needed for real transcription
pip install -e ".[align]"            # optional: torch + torchaudio, precise forced alignment
pip install -e ".[llm]"              # optional: google-genai + httpx, hosted validation
```

`[dev]` alone runs the whole test suite; the heavier extras are only for real audio. Model weights
download lazily on first use and are cached outside the repo.

```bash
python -m audio_studio doctor                       # what can actually run on this machine
python -m audio_studio transcribe song.mp3          # → out/song.{speech,veed}.json, .srt, .vtt
python -m audio_studio transcribe song.mp3 --align wav2vec --validate rules
python -m audio_studio serve --port 8756            # the job server the browser talks to
```

`--align` and `--validate` are off unless asked for: one downloads a large acoustic model, the other
can spend money, and neither is a sane default.

### 3. Both, together

```bash
# terminal 1
cd audio-studio && source .venv/Scripts/activate && python -m audio_studio serve --port 8756
# terminal 2
cd caption-studio && npm run serve
```

Then, in the browser: **Transcribe** tab → pick the audio → upload → the returned caption document
lands in the editor, ready to edit, cut, style and export.

## Tests

```bash
cd caption-studio
npm test                 # unit tests, pure Node, no browser, no dependencies
npm run ui               # the real editor page in headless Chrome (needs Chrome)
npm run e2e              # both studios on the real song (needs the Python venv above)
npm run quality          # the whole pass through the real UI, scored against reference lyrics
npm run visual           # render the reference documents to PNG for eyeballing

cd ../audio-studio && source .venv/Scripts/activate
python -m pytest         # no model, no network, no browser
```

The suites are deliberately dependency-free: nothing needs a model download or a network connection
to catch a layout or timing bug. Where a real audio file is needed, the tests write one with the
standard library.

## Fonts

The preview needs no font files: it loads **Inter 900** and falls back to a system face offline
(logged as `font fallback in use`). For exact offline parity, drop `Inter-900.woff2` into
`caption-studio/src/fonts/packaged/` and it is picked up before any network request.

Two display faces are wired up there, and only one of them can legally ship:

| Face | Committed? | Licence |
|---|---|---|
| `HibernalSentry.ttf` — Iconian Fonts' "Hibernal Sentry" | **yes**, with `HibernalSentry.LICENSE.txt` | free for non-commercial use, and redistribution is explicitly permitted |
| `ZyenaHibernal.ttf` — the face CapCut calls "Hibernal" | **no** | licensed to CapCut, not to this project |

`caption-studio/src/fonts/packaged/README.md` explains both, and gives the one-liner that copies
CapCut's face out of CapCut's own cache for local rendering. If you are using this project
commercially, check that file before shipping: the Iconian face needs a commercial licence.

## Repository layout

```
.
├── caption-studio/          the browser editor
│   ├── index.html           the single page — no bundler, no build
│   ├── src/                 model/ · render/ · editor/ · io/ · align/ · fonts/ · templates/ · store/ · util/
│   ├── tests/               unit/ (pure Node) · helpers/ · visual/
│   ├── tools/               static server, headless-Chrome smoke test, e2e, quality, visual
│   └── vendor/              the MP4 and WebM muxers, with their licence and VENDOR.md
├── audio-studio/            the Python engine
│   ├── audio_studio/        asr/ · align/ · validate/ · pipeline.py · cli.py · server.py
│   └── tests/               runs with no model, no network and no third-party packages
└── README.md                this file
```

## Where to read more

* [`caption-studio/README.md`](caption-studio/README.md) — the renderer's parity with the reference
  implementation, the editing layer, the timeline and its cuts, the export pipeline, and the fonts.
* [`caption-studio/IMPLEMENTATION-PLAN.md`](caption-studio/IMPLEMENTATION-PLAN.md) — the plan each
  phase was built and verified against.
* [`caption-studio/docs/KNOWLEDGE-BASE.md`](caption-studio/docs/KNOWLEDGE-BASE.md) — what the
  reference renderer does, measured rather than assumed.
* [`audio-studio/README.md`](audio-studio/README.md) — the engine decisions, the pipeline passes, the
  validation ledger, and the numbers from the real track.

## Notes

* **Not affiliated with Veed or CapCut.** Both are named only to say which formats and which look this
  project reproduces, and the import/export formats stay compatible with them.
* The reference material, the vendor dumps, the local font pack, the API keys and the internal
  research notes are all deliberately **not** in version control — see [`.gitignore`](.gitignore).
