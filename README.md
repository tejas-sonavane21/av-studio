# AV Studio

```bash
git clone https://github.com/tejas-sonavane21/av-studio.git
```

**Three cooperating studios over audio and video.** One edits the *captions* — text, style, placement,
the cut, the render, the exported file. One works out *what was said and when*, with the timing
audited rather than guessed. The third fetches a transcript from a free hosted service whose text is
better than the local small model's, and writes it in the formats the other two already read.

All three run locally. No account, no upload in the editing half, no build step in the browser half,
and no runtime npm dependency in either JavaScript studio.

| | Studio | Owns | Stack |
|---|---|---|---|
| `caption-studio` | [`caption-studio/`](caption-studio) | the **caption** timeline: 10 Veed/CapCut-style templates, direct-manipulation placement with snapping, a CapCut-style timeline that cuts video *and* audio, a real offline export (WebCodecs → `.mp4`/`.webm`, rendered frame by frame, never screen-recorded), and a corrections ledger | browser, ES modules, **zero runtime npm deps**, no bundler |
| `audio-studio` | [`audio-studio/`](audio-studio) | the **audio** timeline: speech-to-text, per-word timing, forced alignment, silence detection, and a validation layer with an auditable ledger | Python, `faster-whisper`, optional wav2vec2 alignment, optional LLM validation |
| `transcript-studio` | [`transcript-studio/`](transcript-studio) | the **transcript** bridge: a free hosted transcriber driven through its real page, emitting millisecond SRT/VTT, audio-studio's native artifact and the Veed master caption-studio imports | Node, **zero runtime npm deps**, the user's own Chrome over CDP |

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

* **Node 24+** for `caption-studio` and `transcript-studio` (developed on v24.21.0). Neither has
  dependencies to install — the test and dev tooling is Node's own, and both drive Chrome over the
  DevTools protocol rather than through a browser-automation package.
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
pip install -r requirements.txt      # the pinned set — install this first
pip install -e .                     # the package + the `audio-studio` command
```

**Install from `requirements.txt`, not from the extras.** `pyproject.toml` is the flexible view:
its extras (`.[asr]`, `.[align]`, `.[llm]`, `.[dev]`) set only *lower* bounds, which is fine on the
machine that already has the packages and is how a fresh machine ends up subtly broken — the
`av`/`faster-whisper` pair is the one that bites (a new `av` removed a keyword `faster-whisper`
still passes, and the run dies with a message that blames a missing `ffmpeg`). `requirements.txt`
holds the exact versions this project was built and verified on, and the pin that matters is
explained in a comment beside it. Everything in it is needed for real transcription; `[dev]` on its
own is enough to run the test suite.

Model weights download lazily on first use and are cached outside the repo.

```bash
python -m audio_studio doctor                        # what can actually run on this machine
python -m audio_studio transcribe song.mp3           # → out/song.{speech,veed}.json, .srt, .vtt
python -m audio_studio transcribe song.mp3 --align wav2vec --validate rules
python -m audio_studio transcribe song.mp3 --reference lyrics.srt --align wav2vec
python -m audio_studio serve --port 8756             # the job server the browser talks to
```

`--align` and `--validate` are off unless asked for: one downloads a large acoustic model, the other
can spend money, and neither is a sane default. `--reference` is worth asking for whenever you have
the real lyrics — the words come from the file and the timing from the audio, which is the difference
between a caption that is merely plausible and one that is correct.

#### The API key, for the optional `--validate llm` pass only

Transcription, alignment and every emitted file need no key at all. The hosted proofreading pass is
the one that does, and it reads it from the environment with a `.env` file loaded underneath — there
is no `export` step to remember and no key file to point at:

```bash
cp .env.example .env          # from the repository root
# then edit .env and set:  GEMINI_API_KEY=...
```

`.env` is gitignored; `.env.example` is committed and holds placeholders, so the shape of what a key
must be is version-controlled and the key itself never is. A real environment variable always wins
over the file, and `python -m audio_studio doctor` prints whether a key was found and where from.

### 3. The transcript bridge (optional)

```bash
cd transcript-studio
npm test                                  # 50 unit tests, no network, no browser
node src/cli.js song.mp3 --out out        # opens Chrome, uses the free transcriber, closes it
npm start                                 # or: a local studio on http://127.0.0.1:8757
```

It writes `.transcript.json`, `.srt`, `.vtt`, `.speech.json` and `.veed.json`. The last two are the
suite's own formats: `audio-studio emit` re-reads the first, and `caption-studio`'s importer opens
the second with no changes on either side. There is also a `requests`-only Python client in
`transcript-studio/python/` for the local server, so a Python script never touches a browser.

Why a browser at all is explained in [`transcript-studio/README.md`](transcript-studio/README.md):
the site sits behind a Cloudflare challenge and its endpoint needs a token only a browser can
obtain. `requests` and even `curl_cffi` with Chrome's TLS fingerprint get a 403 there — measured,
not assumed.

### 4. Both, together

```bash
# terminal 1
cd audio-studio && source .venv/Scripts/activate && python -m audio_studio serve --port 8756
# terminal 2
cd caption-studio && npm run serve
```

Then, in the browser: **Transcribe** tab → pick the audio → upload → the returned caption document
lands in the editor, ready to edit, cut, style and export.

The strongest results come from using them together: take the *text* from `transcript-studio`
(measured 5.5 % WER on the project's own track, against 11.8 % for the local `small` model), and the
*timing* from `audio-studio --reference … --align wav2vec`. The README explains the measurement and
why the site's own timings are not good enough to keep.

## Where the files go

Nothing is written outside the folder you ran the command in, and every run leaves a record of
itself beside what it wrote:

| Written by | Lands in | Named |
|---|---|---|
| `audio-studio transcribe` | `--out` (default `./out`) | `<stem>.speech.json`, `<stem>.veed.json`, `<stem>.srt`, `<stem>.vtt` |
| the same run's manifest | beside those four | `<stem>.run.json` — what produced it, the source's SHA-256, and every file it wrote |
| `audio-studio serve` | `--out` (default `./jobs`), one folder per job | `jobs/<id>/source.*` |
| `caption-studio` | your browser's download folder | `<stem>.caproj`, `<stem>.veed.json`, `<stem>.srt`, `<stem>.vtt`, and the exported `.mp4`/`.webm` |
| `transcript-studio` | `--out` (default `./out`) | `<stem>.transcript.json`, `<stem>.srt`, `<stem>.vtt`, `<stem>.speech.json`, `<stem>.veed.json` (`--emit txt` adds the words) |

The stem is sanitised the same way by both studios: a path is not a name, so only the last segment
survives, and a character a filesystem refuses becomes `_`. `--stem ../../notes/attack` writes
`out/attack.srt`, and a recording called `take 2: final?.mp3` produces `take 2_ final_.srt`.

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

cd ../transcript-studio
npm test                 # unit tests, no network, no browser
cd python && python -m unittest -v    # the requests client against a stub server
```

The suites are deliberately dependency-free: nothing needs a model download or a network connection
to catch a layout or timing bug. Where a real audio file is needed, the tests write one with the
standard library.

## Fonts

The preview needs no font files: it loads **Inter 900** and falls back to a system face offline
(logged as `font fallback in use`). For exact offline parity, drop `Inter-900.woff2` into
`caption-studio/src/fonts/packaged/` and it is picked up before any network request.

Two display faces are wired up there, and both are committed, so a clone renders the intended look
with no hunt through anybody's cache:

| Face | Committed? | Licence |
|---|---|---|
| `HibernalSentry.ttf` — Iconian Fonts' "Hibernal Sentry" | **yes**, with `HibernalSentry.LICENSE.txt` | free for non-commercial use, and redistribution is explicitly permitted |
| `ZyenaHibernal.ttf` — the face CapCut calls "Hibernal" | **yes**, with the attribution in the directory's README | licensed to CapCut, not to this project — tracked deliberately, for personal use |

`caption-studio/src/fonts/packaged/README.md` explains both, including where the CapCut face came
from. **If you are using this project commercially, read it and
[`THIRD-PARTY.md`](THIRD-PARTY.md) first:** the Iconian face needs a commercial licence, and the
CapCut face is not ours to redistribute at all — it is in the tree because this project is a
personal one that has to render the same way on every machine its owner uses.

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
├── transcript-studio/       the hosted-transcription bridge
│   ├── src/                 core/ · browser/ · provider/ · cli.js · server.js
│   ├── web/                 its local studio page
│   ├── python/              the requests-only client for that studio
│   └── tests/               node:test, no network, no browser
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
* [`transcript-studio/README.md`](transcript-studio/README.md) — the reverse-engineered contract, the
  measured quality comparison, why plain HTTP cannot call it, and the two bridges' provenance.

## Licence

**MIT** — see [`LICENSE`](LICENSE). Copyright (c) 2026 Tejas Sonavane.

MIT covers the source code. It does **not** cover everything in the tree, and one bundled asset is
more restrictive than the project itself, so please read [`THIRD-PARTY.md`](THIRD-PARTY.md) before
shipping anything commercially:

* the vendored container muxers are MIT, and their notice is retained beside them;
* the one bundled display font, **HibernalSentry.ttf**, is *free for non-commercial use only* —
  commercial use needs a licence from [Iconian Fonts](http://iconian.com/commercial.html).

Each studio carries its own copy of the licence: [`caption-studio/LICENSE`](caption-studio/LICENSE)
and [`audio-studio/LICENSE`](audio-studio/LICENSE).

## Notes

* **Not affiliated with Veed or CapCut.** Both are named only to say which formats and which look this
  project reproduces, and the import/export formats stay compatible with them.
* The reference material, the vendor dumps, the local font pack, the API keys and the internal
  research notes are all deliberately **not** in version control — see [`.gitignore`](.gitignore).
