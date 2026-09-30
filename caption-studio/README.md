# Caption Studio

An interactive, local-first **caption editor + renderer** that replicates the caption
workflow of **Veed.io** and **CapCut** — with a first-class **quality-correction engine**
that cleans up AI-generated captions against a trusted subtitle file (SRT/VTT).

This is a **fresh project**. The previous subtitle-replication work (versions 1–10 in
`../referece_material/`) is parked and treated as a **knowledge base / reference material**.
Everything learned there is distilled into [`docs/KNOWLEDGE-BASE.md`](docs/KNOWLEDGE-BASE.md)
so this folder is self-contained.

> **Status: Phases 0–4 complete and verified.** All engines are built and **246/246 tests pass**:
> the caption document model, the format I/O (SRT/VTT/Veed JSON/project), the
> **quality-correction engine** (rolling-cue resolution → anchors → banded DTW → typed, auditable
> corrections), the **Canvas2D renderer with the Veed parity template**, and the **Phase 4 editing
> layer** — 10 templates (Veed / CapCut / generic), direct-manipulation placement with snapping,
> and sparse per-block overrides. Alignment is validated end-to-end against the real `spidy.srt` +
> `veed_master_v3…json` pair (71 blocks, 135 anchors, 0 document errors, 0 overlaps); the renderer is
> validated by comparing its painted positions against a transcription of v10's own render loop; and
> the editor UI is exercised in real headless Chrome (`npm run ui`, 45 checks). Timeline,
> inline text editing and export are the next phases. See
> [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) §20.

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
| Timeline / inline text editing / export | ⏳ next phases |

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
npm test          # node --test "tests/unit/*.test.js" → 252 tests
npm run ui        # headless-Chrome smoke test of the editor page (45 checks)
```

All test suites are pure Node — no browser, no dependencies. The integration test runs against the
real `../referece_material/version10/` data when present and skips itself otherwise. The renderer
is covered end-to-end through a fake 2D context (`tests/helpers/fake-canvas.js`), with a
deterministic text metric (0.5 em per character, 0.25 em per space) so expected geometry is
calculated by hand rather than mirrored from the implementation.

### Exercise the editor UI

```bash
cd caption-studio
npm run ui        # → headless Chrome over CDP, 45 checks, exits non-zero on failure
```

`src/main.js` is the one module no unit test can reach — it exists only as browser side effects on
`index.html`. This drives the real page in headless Chrome: loads the demo, clicks through every
template tile as a burst (which is how the overlapping-`await` re-entrancy bug was found), edits a
per-block override, promotes and resets it, drags a caption with real mouse events from the
DevTools protocol, and fails on any uncaught exception or `console.error`. It is worth running after
any change to the editor wiring — the two bugs it caught were both invisible in Node:

- a burst of template clicks could settle the UI on a template the document was not on, because
  `font loading` is async and the *last* application to finish won instead of the last one asked for;
- `.overlay-canvas` lost to `.stage canvas` on CSS specificity, so the overlay became a second,
  relative grid item *below* the preview. It looked harmless and received no pointer events at all.

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
