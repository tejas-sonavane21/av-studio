# Caption Studio

An interactive, local-first **caption editor + renderer** that replicates the caption
workflow of **Veed.io** and **CapCut** — with a first-class **quality-correction engine**
that cleans up AI-generated captions against a trusted subtitle file (SRT/VTT).

This is a **fresh project**. The previous subtitle-replication work (versions 1–10 in
`../referece_material/`) is parked and treated as a **knowledge base / reference material**.
Everything learned there is distilled into [`docs/KNOWLEDGE-BASE.md`](docs/KNOWLEDGE-BASE.md)
so this folder is self-contained.

> **Status: Phases 0–4 complete and verified.** All engines are built and **282/282 tests pass**:
> the caption document model, the format I/O (SRT/VTT/Veed JSON/project), the
> **quality-correction engine** (rolling-cue resolution → anchors → banded DTW → typed, auditable
> corrections), the **Canvas2D renderer with the Veed parity template**, and the **Phase 4 editing
> layer** — 10 templates (Veed / CapCut / generic), direct-manipulation placement with snapping,
> and sparse per-block overrides. Alignment is validated end-to-end against the real `spidy.srt` +
> `veed_master_v3…json` pair (71 blocks, 135 anchors, 0 document errors, 0 overlaps); the renderer is
> validated by comparing its painted positions against a transcription of v10's own render loop; and
> the editor UI is exercised in real headless Chrome (`npm run ui`). Since Phase 7 it also has a
> **real, offline export** — frames are rendered and encoded with WebCodecs into an `.mp4`/`.webm`,
> not recorded off the screen — reached through a **professional export window** (container,
> resolution, frame ratio, frame rate, quality and both bitrates, with a resolution preset that tunes
> the rest and any control overridable afterwards), and a **CapCut-style timeline that cuts the video
> and the audio** — trim a clip's edges, split at the playhead, cut left / cut right, delete — with
> the cuts honoured by both the preview and the exported file. The preview *plays* the cut too: it
> jumps a removed region, and stops at the last frame the programme kept instead of running on into
> what was dropped. See [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) §20.

## What works today

| Area | Status |
|---|---|
| Caption document model + invariant validation | ✅ `src/model/` |
| Renderer geometry parity with v10 | ✅ `tests/unit/render-parity.test.js` |
| SRT / VTT parse + serialize | ✅ `src/io/srt.js`, `src/io/vtt.js` |
| Veed JSON import/export | ✅ `src/io/veed-json.js` |
| Rolling-cue resolution (birth-cue rule) | ✅ `src/align/rolling.js` |
| Anchors + banded DTW alignment | ✅ `src/align/anchors.js`, `src/align/dtw.js` |
| Typed corrections + report | ✅ `src/align/corrections.js`, `src/align/report.js` |
| App shell (load → align → review) | ✅ `index.html`, `src/main.js` |
| Canvas2D renderer + layout/wrapping | ✅ `src/render/` |
| Veed parity template (underline + italic, no emoji) | ✅ `src/model/schema.js` defaults |
| Font catalog + resilient loading | ✅ `src/fonts/` |
| Preview: video/audio behind captions + transport | ✅ `src/editor/preview.js` |
| Original audio import (drives the clock, transport-synced) | ✅ `index.html`, `src/main.js` |
| 10 templates (Veed / CapCut / generic), validated at import | ✅ `src/templates/` |
| Per-block overrides, promote / reset, style resolver | ✅ `src/templates/merge.js` |
| Drag to place, snapping, keyboard nudge, per-block position | ✅ `src/editor/canvas-overlay.js`, `src/render/placement.js` |
| Caption text editing — re-type a line, or fix a single word | ✅ `src/model/edit.js`, `src/main.js` |
| Split a long caption in two / join it back (the line breaks) | ✅ `src/model/edit.js`, `src/main.js` |
| Transcribe on the sibling studio (upload → poll → import) | ✅ `src/io/audio-studio-client.js` |
| Real offline export — WebCodecs + vendored muxer, `.mp4` / `.webm`, decodes from its own off-screen copy so the preview is never disturbed | ✅ `src/io/webcodecs-export.js` |
| Audio that survives the bitrate — the encoder's accepted rate is searched for, not assumed | ✅ `resolveAudioBitrate` in `src/io/webcodecs-export.js` |
| Professional export window — resolution, ratio, fps, quality, bitrates, preset auto-tune | ✅ `src/io/export-settings.js`, `src/editor/export-dialog.js` |
| An export you can watch and a state you can read — visible track, percentage, and the saved file named | ✅ `describeExportResult` in `src/io/export-settings.js` |
| CapCut-style timeline — caption, video and audio lanes on one source clock | ✅ `src/editor/timeline.js` |
| Cuts — trim edges, split, cut left / cut right, delete, honoured by the preview *and* the export | ✅ `src/model/timeline.js`, `src/editor/preview.js` |
| Playback that respects the cut — a gap is jumped, and the end of the kept material ends the programme | ✅ `playbackTarget` in `src/model/timeline.js` |
| Per-source audio — the picture's own track and the uploaded master track, each with its own switch | ✅ `src/editor/preview.js` |
| Tabbed workspace — Sources / Transcribe / Export share one column instead of three narrow ones | ✅ `index.html`, `src/main.js` |
| Caption files — `.caproj`, Veed JSON, SRT, VTT | ✅ `src/io/download.js` |

## The renderer

The renderer is the interface in `src/render/renderer.js` with a Canvas 2D implementation
(`canvas2d.js`). Drawing depends on nothing but `(document, time, opts)`, which is what makes it
deterministic — and testable without a browser, through a fake 2D context (`tests/helpers/fake-canvas.js`).

```
render/time.js        reveal / active / emphasis windows          (pure)
render/layout.js      measure → wrap → hard-break → place         (pure, injected metrics)
render/draw-text.js   the 8 display modes + paint order
render/decorations.js underline / highlight / box geometry
render/animation.js   easings + presets (the default is the identity transform)
render/emoji.js       image stickers, OFF by default
render/canvas2d.js    the Canvas2D renderer (DPR, caching, guides)
fonts/registry.js     family catalog + metrics     (pure)
fonts/loader.js       packaged → Google → system, with timeouts
editor/preview.js     video/audio + caption canvas + clock
editor/canvas-overlay.js  drag / snap / nudge   (geometry lives in render/placement.js)
render/placement.js   anchors, box rects, snapping, clamping   (pure)
templates/index.js    the registry (validated at import) + picker swatches
templates/merge.js    template ⊕ defaults ⊕ overrides ⊕ placement, with an LRU resolver
templates/defs/*.js   one file per template — data, not code
model/edit.js         re-type a line / one word; split or join captions (pure)
```

## The editing layer

A template is data, not code — a named, complete style patch. `templates/index.js` validates every
one **at import** (kebab-case id, real origin, real `display`/`reveal`/`emphasis` vocabulary, and
that the font family actually exists in the registry), so a typo fails loudly instead of silently
rendering a fallback face. The picker's cards are derived from each template's own defaults, so a card
cannot drift out of date.

Applying a template recomputes the document style from a **fresh parity base**:

```
createDefaultStyle() ⊕ document.defaults ⊕ block.overrides ⊕ { anchor: block.placement }
```

That base is why applying a template is idempotent and order-independent — switching T1 → T2 leaves
nothing of T1 behind — and why the parity template describes the default style exactly, so a fresh
document reports itself as unedited. Per-block overrides and positions survive: they are the user's
explicit per-shot decisions, not an artifact of the template. Edits keep `templateId` for provenance
("Veed — Auto Highlight · **edited**"), and resolving a style is memoised on the *content* of those
three inputs, so the render loop never re-merges the same style twice.

Placement is a geometry problem, not a DOM one. `render/placement.js` is pure — anchors, box rects,
snapping, clamping, safe areas — and `editor/canvas-overlay.js` is only an event adapter over it. Two
rules there are worth knowing because they are what "CapCut-like" actually means:

- **snapping snaps the box's edges, not the anchor point.** The user is looking at the box, and the
  box centre equals the anchor only under `gravity: 'center'` — so each axis tests the box's
  left/centre/right (and top/middle/bottom) edges and moves the anchor by the delta that lands the
  winning edge on the guide. Targets: canvas centre, thirds, title/action-safe edges, canvas edges,
  and the other visible captions. Guides are painted on an overlay canvas, never by the renderer.
- **clamping slides the box, it never resizes it**, and an over-wide box is centred rather than
  pushed off one edge. A drag therefore cannot lose a caption off the frame.

Keyboard nudges are a fraction of the canvas (0.5 %, `Shift` = ×4), so a nudge means the same thing at
every preview size and every display; arrow keys inside a text field are left alone.

### Editing the words

Corrections are only as good as their sources: an AI transcript can mis-hear a line *and* get its
word order wrong, and no spelling policy can fix that. So the inspector edits **content** as well as
looks — a **Caption text** field replaces a block's whole line, and a **word strip** beneath it gives
every word its own input, tagged with that word's own timing.

Both are the same operation, `setBlockText` in `src/model/edit.js`. Overwriting `block.text` would
not be a valid edit: the invariant is `block.text === words.map((w) => w.text).join(' ')`, every word
addresses a slice of that text by `charFrom`/`charTo`, and the keyword highlight is a set of
character ranges *into* it. So the edit rebuilds the word list and hands the block back to
`normalizeBlock` — the one authority on what a consistent block is — which re-derives the offsets,
ranges and emphasis flags rather than patching them. Because a block owns a fixed span, two rules
follow:

- **a same-length line keeps its sync.** Every word retains its own `[start, end]`, so fixing
  `soul` → `toll` cannot nudge the timing. A *reorder* is just a same-length line edit: the words
  change places together with their slots, which is the only arrangement the model can hold, since
  words inside a block are kept in time order.
- **a different-length line stays inside its span.** There is no slot to inherit, so the block's
  `start`…`end` is divided between the words in proportion to their length. Neighbours never move.

An edit to content is never an edit to looks: `overrides` and `placement` are left alone, so fixing
a typo cannot drop a per-block drag or a promoted template.

### Breaking a long line in two

A transcript hands captions over in *sentences*, but a caption holding a whole sentence keeps every
spoken word on screen until the sentence ends — the one thing a Veed or CapCut caption never does.
There is nothing for the renderer to fix there: the line break is the fix, and in this model a line
break **is** a block boundary. So the inspector can draw them:

- **✂ between two words** splits the caption at that boundary;
- **Split at playhead** splits at the nearest boundary to the playhead, and just logs a line when the
  playhead is outside the selected caption;
- **Join with previous** puts two captions back together (disabled on the first one).

`splitBlock` moves the words into a new block carrying their own `[start, end]`, so a split cannot
nudge the sync: the only new number is the cut, taken as the midpoint of the silence between the two
words it falls between, which leaves the two windows exactly contiguous. Both halves inherit the
original's `overrides` and `placement` as *copies* — a split is not a style edit, and promoting one
half later must not drag the other with it — and each re-derives its own emphasis ranges from its own
words. Two boundaries are refused, because they are not splits but deletions: the very first and the
very last word, and any cut that would leave a caption with no duration at all.

The keyword highlight is the subtle part. A range is a set of character offsets *into* a block's
text, so it only means anything within that block — the halves have to re-derive their own text
*before* their ranges, or the new caption's range lands beyond its own end and `normalizeBlock` drops
it without a word. That ordering is exactly what the test for "a highlight that lands in the second
half" exists to catch.

### Parity, and the one deliberate correction

v10 was the version whose output matched the frame-by-frame analysis of the real Veed video, so its
render loop is the reference — `tests/unit/render-parity.test.js` transcribes that loop and asserts
our painted positions match it fragment by fragment.

One thing was **deliberately changed**. v10 computed the caption font size as
`canvas.height × 0.036` (= 25.92 px on a 1280×720 canvas). Veed's own renderer scales **both**
`fontSize` and `wrapWidth` by the canvas **width** (visible in `getTextProps()` in Veed's bundle:
`(… 'fontSize') * pretendedCanvasSize.width`), i.e. 46.08 px — **1.78× larger**. v10 therefore
rendered captions at ~56 % of Veed's true size, which is a very plausible cause of the old
"the font doesn't match" complaint. The parity template now uses `font.sizeUnit: 'w'`.

Adding wrapping changed `wrapWidth` from `0.36` to `0.9`: 0.36 appears to have been carried over
from `fontSize: 0.036`, and at the corrected font size it would wrap lines that Veed renders on
one line. `0.9` is v10's proven overflow cap, so **every line v10 kept on one line still renders on
one line** while genuinely longer text now wraps instead of being shrunk to fit — which is exactly
Phase 2's exit criterion.

Verified on the reference pair — Veed's transcript corrected against `spidy.srt`: AI timing and
keyword emphasis preserved, TRUTH spelling wins (`crush → catch`, `king → kid`, `burning → burden`,
`soul → toll`), plus 30 punctuation and 21 case corrections, every one of them listed and auditable.
The 22-second instrumental hole is reported as a timing gap and **not** stretched across.

One timing bug was found and fixed here rather than in `audio-studio`, because it was introduced
here. An inserted TRUTH word with no AI word in front of it — a *leading* insertion — used to be
bounded by the **previous block's end**. Across the 22-second instrumental hole that stretched one
inserted word over the entire break and switched its caption on screen roughly 15 s before it was
sung. A leading insertion is now bounded by its own block's first measured word instead
(`src/align/aligner.js`, `placeInsertions`): the AI stream is the timing authority, so its envelope
wins over the gap, and `floor` still wins when it is later. On the reference pair the caption that
began at 140.12 s now begins at 154.52 s, beside the word it belongs to.

## The audio-studio bridge

This studio corrects an AI transcript against a trusted subtitle file, and it is good at it — but it
**inherits its word timings from Veed**, and a correction engine cannot repair a number it was handed.
A split cuts at the midpoint of the silence between two words, so when the words themselves are badly
timed, every split, join and reveal inherits the error.

Its sibling [`audio-studio`](../audio-studio) measures the timings from the audio instead. The panel
at the top of the page is where the two meet:

1. **Check server** — `GET /health` reports the version and what can actually run here (which engines,
   aligners and validators are installed), so a missing aligner is a fact up front rather than a
   failure a minute into a job.
2. **Transcribe** — the recording's bytes go over the wire as the request body (a browser cannot read
   a path off the user's disk — deliberately), the job is polled with live progress, and the
   Veed-shaped answer is handed to the **same `importJSON`** a file from disk goes through. Nothing
   downstream changes: the alignment, the corrections and the editing all work exactly as before, on
   better numbers.
3. **The provenance is shown, not swallowed** — which model transcribed, which aligner re-timed it,
   its confidence, how far the words moved, the validation ledger, and every warning the other studio
   attached. None of that is needed to *render* a caption; it is needed to *trust* one.

4. **The original lyrics, if you have them** — the optional file under *Recording to transcribe*.
   The words then come from that file and only the timing comes from the audio, so the transcript
   stops being a guess about *what* was sung: on the real song it takes the word error rate from
   **11.8 % to 0.0 %**. The page reads the file and posts its text (a browser cannot read a path off
   the user's disk, and a lyric sheet is small), the studio refuses a sheet that is not this
   recording rather than applying it, and the result is reported in the panel exactly like the other
   passes. Note that the **TRUTH source** further down is a different pass — that one fixes spelling
   locally, this one reconciles against the words — and the same file can be given to both.

That last panel is where the timing question is answered, so it is worth stating the answer. With
`align = wav2vec` selected, the clock that arrives here is **unbiased against the voice band
(+0.00 s)**. With alignment off it is not: the transcriber pins each segment's first word to the
segment's leading edge, which is where the silence before the singing ended, and the transcript runs
about **0.58 s early** against the full mix. The panel reports which of the two you are looking at.

The transport lives in `src/io/audio-studio-client.js`, which holds no document, no state and no DOM:
it is a function from (base URL, file, options) to (job, Veed JSON), with `fetch` injectable so the
whole flow is testable without a Python process. The commonest failure by far is "the server is not
running", so every error carries the command to start it.

## Run it (Windows 11)

```bash
cd caption-studio
npm run serve      # → http://localhost:8000
```

A local server is required: ES modules, Web Workers and (later) `canvas.captureStream` do not work
from `file://`. `tools/serve.mjs` is a ~70-line zero-dependency static server (Python is not assumed
to exist on the machine). It has been smoke-tested over HTTP: shell assets serve with the right MIME
types, unknown paths give `404`, and targets like `/..%2fREADME.md` or `/%2e%2e/README.md` give `403`
with the server staying up (`/%zz` gives `400`).

> Stopping it on Windows: `kill $!` does **not** work from Git Bash — the bash job PID is not the
> Windows PID, so the process keeps the port and shadows your next run. Use
> `netstat -ano | grep :8000` then `taskkill //F //PID <winpid>`.

## Test it

```bash
cd caption-studio
npm test          # node --test "tests/unit/*.test.js" → 305 tests
npm run ui        # headless-Chrome smoke test of the editor page (87 checks)
npm run e2e       # the two studios on the real song — needs the Python venv (see below)
npm run quality   # the whole pass through the real UI, scored against the reference lyrics
```

All test suites are pure Node — no browser, no dependencies. The integration test runs against the
real `../referece_material/version10/` data when present and skips itself otherwise. The renderer
is covered end-to-end through a fake 2D context (`tests/helpers/fake-canvas.js`), with a
deterministic text metric (0.5 em per character, 0.25 em per space) so expected geometry is
calculated by hand rather than mirrored from the implementation.

### Exercise the editor UI

```bash
cd caption-studio
npm run ui        # → headless Chrome over CDP, 87 checks, exits non-zero on failure
```

`src/main.js` is the one module no unit test can reach — it exists only as browser side effects on
`index.html`. This drives the real page in headless Chrome: loads the demo, clicks through every
template tile as a burst (which is how the overlapping-`await` re-entrancy bug was found), edits a
per-block override, promotes and resets it, drags a caption with real mouse events from the
DevTools protocol, re-types a caption line, fixes a single word, splits a long caption in two (by
handle and at the playhead) and joins it back, and fails on any uncaught exception or
`console.error`. It is worth running after
any change to the editor wiring — the two bugs it caught were both invisible in Node:

- a burst of template clicks could settle the UI on a template the document was not on, because
  `font loading` is async and the *last* application to finish won instead of the last one asked for;
- `.overlay-canvas` lost to `.stage canvas` on CSS specificity, so the overlay became a second,
  relative grid item *below* the preview. It looked harmless and received no pointer events at all.
- the harness once allowed 1.2 s for the demo document, which needs **~1.3 s** to lay out because
  applying a document awaits font loading — so the whole suite reported "the demo document did not
  load" on a build where it loaded perfectly. Two rules came out of that: a wait that gates an async
  render is now a *condition* (`waitFor`) rather than a fixed sleep, and a fact about the harness
  rather than the page has its own `assert()` — `check()` evaluates its expression **inside the
  page**, so passing it a value instead of an expression silently sends that value as JavaScript
  (it did: the string `recording.wav` reached the browser as an expression and threw).

### The quality pass, scored

`npm run quality` drives the editor in headless Chrome against the **real** Python studio: it
uploads the real song through the transcribe panel with `align=wav2vec`, loads the reference lyrics
as the TRUTH file, runs the correction, and then measures what the page is showing — the caption
text against the reference lyrics, and each early caption's window against the cue that introduced
it. Nothing is stubbed. Two numbers come out of it that are worth stating:

- the corrected document is **8.2 % WER** against the reference lyrics, down from **11.8 %** for the
  raw transcription, with the remaining difference dominated by a hallucinated `Music` before the
  first line and one transposed couplet in the chorus;
- the first lyric lands at **13.40 s** while its cue in the reference file opens at **12.00 s** — and
  the second line's cue is also 12.00 s, because that file introduces two lines per 4 s cue. The
  timings you would use for *spelling* are seconds away from the audio; the measured ones are not.

This also surfaced a real limitation worth knowing before you look for it: **the editor does not
display the raw transcription.** Transcribing — like importing an AI source from disk — only puts
the document in the store, because the editor's model is "correct an AI transcript against a
trusted subtitle file". The caption list and the preview fill in when the correction runs. With no
TRUTH file there is nothing to correct, so there is nothing on screen.

### The real end-to-end (the two studios, on the real song)

```bash
cd caption-studio
npm run e2e                    # transcribe only            (~80 s)
npm run e2e -- --align wav2vec # plus forced alignment       (~4 min)
```

`npm run ui` covers the browser wiring against a *stand-in* server, which is the right way to test a
page — and it leaves one gap: nothing there proves the real Python studio emits what this studio
reads. This closes it by removing the stand-in entirely. It starts `audio-studio`'s real HTTP server,
uploads the real 182.5 s track with **this project's real client module**, and feeds the answer to
**this project's real importer**. Nothing is stubbed and no fixture is replayed; every number it
prints was measured on this machine a second earlier.

Its last assertion is the one that matters. The reference `spidy.srt` supplies the *spelling*; the
measurement supplies the *clock*. The two really do disagree about when the opening line starts — the
cue opens at **12.00 s**, the measured onset is **13.18 s** — and after the quality correction the
editor uses **13.40 s**. The measurement wins, which is the exact inversion of the drift this pair of
studios exists to remove. It needs the sibling's virtualenv (`pip install -e ".[asr]"`, plus
`".[align]"` for the alignment leg) and skips the correction leg when the reference data is absent.

### Verify the render against a reference

```bash
cd caption-studio
npm run visual                 # reference: ../referece_material/version10/video.mp4
npm run visual -- --ref overlay  # reference: v10's own transparent overlay .webm
npm run visual -- --samples 12
```

This launches headless Chrome (found automatically, or via `CHROME_PATH`), serves the repository
root, runs the **real** pipeline in the browser (spidy.srt + the Veed JSON → aligner → renderer),
seeks the reference to each block's fully-revealed instant, and compares the two frames by
measuring the lime underline and the glyph cluster in each. It prints a per-frame pass/fail with
the deltas, and exits non-zero on failure, so it is a check rather than something to eyeball.

> Serving the **repository root** is required (`tools/serve.mjs 8000 ..`) so the harness can reach
> `../referece_material/`. The dev server supports byte ranges for exactly this reason — `<video>`
> seeking in Chrome needs 206 responses.

**Result so far:** `video.mp4` turns out to be the plain source video with **no captions burned in**
(0 lime pixels, 0 near-white pixels, 0 blank frames — i.e. it decodes fine and simply has no
captions), so it cannot serve as a parity reference. Against the one reference that does contain
captions — v10's own overlay — our render measures **1.80–2.25× its glyph height**, which is exactly
the deliberate width-vs-height font-size change described below, and nothing else. See
[`docs/KNOWLEDGE-BASE.md`](docs/KNOWLEDGE-BASE.md) §4c for the full numbers, including the discovery
that `0.036` was a hard-coded fallback in the extractor rather than a value read from Veed.

### Fonts, and getting exact parity offline

With no font files shipped, the preview loads **Inter 900** from Google Fonts exactly as the v10
replica did, and falls back to a system face if the network is unavailable (logged as
`font fallback in use`). For fully offline, pixel-stable parity, drop these into
`src/fonts/packaged/` and they are picked up automatically, before any network request:

```
src/fonts/packaged/Inter-900.woff2
```

The loader never hangs and never lies: every attempt races a timeout, and availability is verified
with `document.fonts.check()` — because `document.fonts.load()` resolves successfully even when no
matching face exists, measuring against a silent fallback is how the old project produced text that
"doesn't match".

Two display faces ship the same way, and appear in the Font dropdown once their file is present:

```
src/fonts/packaged/ZyenaHibernal.ttf     → "Zyena Hibernal"   — the face CapCut calls **Hibernal**
src/fonts/packaged/HibernalSentry.ttf    → "Hibernal Sentry"  — Iconian Fonts, shared the word only
```

They are unrelated fonts, and worth being clear about because the name invites the mistake: CapCut's
"Hibernal" is **Zyena Hibernal** (© Tianjin ZHUOMAN Technology Co., Ltd, CapCut `fontId`
7044916245971341825), a marker script; Iconian's "Hibernal Sentry" is an angular sci-fi display face.

Only one of the two can ship, and the difference is the licence, so it is stated plainly:
**Hibernal Sentry is committed** — Iconian permits redistribution, free for non-commercial use, and
the licence text travels with the binary as `HibernalSentry.LICENSE.txt`. **Zyena Hibernal is not** —
it is licensed to CapCut, so the editor renders it here and git is told to ignore it
(`src/fonts/packaged/README.md` says so, and gives the `find` command that pulls CapCut's own copy
out of its local cache instead).

> Node 24 note: passing a bare directory (`node --test tests/unit`) is treated as a module and fails;
> pass a glob (as the `npm test` script does).

## Document map

| File | Purpose |
|---|---|
| `IMPLEMENTATION-PLAN.md` | The full, detailed build plan (architecture, data model, algorithms, UI, testing, phases). |
| `docs/KNOWLEDGE-BASE.md` | Everything learned from the v1–v10 Veed replication work + Veed's real renderer. |
| `docs/DATA-MODEL.md` | *(later)* Concrete TypeScript/JS schemas. |
| `docs/ALGORITHMS.md` | *(later)* Alignment/correction math with worked examples. |

## The one-sentence pitch

> Drop in a video and/or its original audio track, plus (optionally) an accurate SRT/VTT; get
> AI-quality captions that are
> **automatically corrected for spelling and timing**, styled with Veed/CapCut-grade
> templates, fonts and placement controls, and exported as a burn-in or a transparent overlay.

## Guiding principles (learned the hard way)

1. **Two sources, two jobs.** AI captions give *timing*; the SRT/VTT gives *truth* (spelling).
   Never let one silently overwrite the other — always show what changed.
2. **Fractional/normalized coordinates everywhere.** Positions/sizes are fractions of the
   canvas, never pixels, so any resolution works.
3. **One editable data model, many renderers.** Timeline, preview and export all read the
   same caption document; the renderer is a pure function of (document, time).
4. **No silent guessing.** Every alignment decision that is imperfect is surfaced to the user.
5. **Zero build step.** Plain ES modules served over `http://localhost` — runs on Windows 11
   with nothing but a browser and Python/Node.
