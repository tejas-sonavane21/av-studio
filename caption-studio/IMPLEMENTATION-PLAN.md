# Caption Studio — Full Implementation Plan

**Version:** 1.0 (planning)
**Author:** Buffy (for the user)
**Date:** 26 September 2026
**Status:** Design — *no code yet, by explicit request.*
**Companion docs:** [`docs/KNOWLEDGE-BASE.md`](docs/KNOWLEDGE-BASE.md) · [`../VEED-Subtitle-Replication-Complete-Understanding.md`](../VEED-Subtitle-Replication-Complete-Understanding.md)

> This document is deliberately exhaustive. Every module, data shape, algorithm, interaction and
> test is described, including *why* the choice was made and what could go wrong. It is long on
> purpose — read it top to bottom once, then use the table of contents as a checklist.

---

## Table of contents

0. [Glossary & conventions](#0-glossary--conventions)
1. [Vision, goals & non-goals](#1-vision-goals--non-goals)
2. [What "quality" means (the success bar)](#2-what-quality-means-the-success-bar)
3. [Technology decisions & constraints](#3-technology-decisions--constraints)
4. [Repository & folder structure](#4-repository--folder-structure)
5. [The caption document — core data model](#5-the-caption-document--core-data-model)
6. [Module architecture (file by file)](#6-module-architecture-file-by-file)
7. [Ingestion: media, captions, AI transcription](#7-ingestion-media-captions-ai-transcription)
8. [The quality-correction engine (the heart)](#8-the-quality-correction-engine-the-heart)
9. [The rendering engine](#9-the-rendering-engine)
10. [Template & style system](#10-template--style-system)
11. [Font system](#11-font-system)
12. [Placement, anchoring & safe areas](#12-placement-anchoring--safe-areas)
13. [Animation engine](#13-animation-engine)
14. [The interactive editor UI](#14-the-interactive-editor-ui)
15. [Playback & timeline synchronisation](#15-playback--timeline-synchronisation)
16. [Export pipeline](#16-export-pipeline)
17. [Persistence, project files & autosave](#17-persistence-project-files--autosave)
18. [Veed/CapCut import & compatibility](#18-veedcapcut-import--compatibility)
19. [Testing & quality validation](#19-testing--quality-validation)
20. [Milestones & phased delivery](#20-milestones--phased-delivery)
21. [Windows 11 environment & tooling](#21-windows-11-environment--tooling)
22. [Risks & mitigations](#22-risks--mitigations)
23. [Appendices](#23-appendices)

---

## 0. Glossary & conventions

| Term | Meaning |
|---|---|
| **Caption document** | The single editable in-memory object describing everything about the captions (blocks → words → styles → template → placement). The app's source of truth. |
| **Block** | A contiguous on-screen caption chunk (a "cue"), with `start`/`end` and an ordered list of words. |
| **Word / token** | The atomic rendering unit: `{ text, start, end, ... }`. Timing is per word (millisecond precision). |
| **Style range** | A character span inside a block's joined text carrying extra styling (italic, colour, bold, underline…). Mirrors Veed's `styles[]`. |
| **Emphasis / highlight** | The "AI keyword" concept: a style range with `id:"auto-highlight"` → renders as green underline + italic. |
| **Template** | A named preset bundling style + font + placement + display mode + animation. |
| **Text feed** | Veed's internal name for a renderable text element. We adopt the same abstraction. |
| **Alignment** | Matching AI-generated words to trusted SRT/VTT words in time and text. |
| **TRUTH file** | The user-supplied SRT/VTT considered authoritative for *spelling*. |
| **AI source** | Machine transcription (or Veed JSON) considered authoritative for *timing/emphasis*. |
| **Normalized coords** | Positions/sizes expressed as fractions of canvas dimensions (0..1), never pixels. |

**Conventions used throughout this document**

- Times are **seconds as floating-point** in the document model; **milliseconds as integers** in
  exported SRT/VTT. Internally the renderer takes a float `t` (seconds).
- All geometry is **normalized** unless explicitly called `px`.
- `id` strings are stable, URL-safe, and never reused (ULID-style). This matters for undo/redo and
  for diffing project files.
- Every list is ordered unless stated otherwise; ordering is part of the contract.

---

## 1. Vision, goals & non-goals

### 1.1 Vision

A **local-first, browser-based caption studio** that gives the user the same power over captions
that Veed.io and CapCut do, but:

- **free, offline, no watermark, no account, no upload**;
- with a **first-class quality-correction engine** so AI captions become *accurate* captions; and
- **renderer-agnostic and scriptable** (every operation is a pure function over the caption
  document, so we can later add a CLI batch mode or an MCP/automation surface).

### 1.2 Goals (must-haves)

1. **Generate captions** from a video, three ways: (a) import an existing SRT/VTT, (b) on-device AI
   transcription, (c) import an extracted Veed JSON.
2. **Correct AI captions against a TRUTH file (SRT/VTT)**: fix spelling, punctuation and casing
   while keeping AI timing — and *show the user every change* with accept/reject.
3. **Multiple caption styles & templates**, live-switchable.
4. **Font family, weight, size, letter-spacing, line-height and case controls.**
5. **Placement control**: free-drag, 9-point anchor presets, safe-area guides, per-block overrides.
6. **Word-level and line-level editing** with a timeline.
7. **Export**: burned-in video, transparent overlay WebM (for later merging), and SRT/VTT/ASS.
8. **Save/load projects** and undo/redo that never loses work.

### 1.3 Non-goals (explicitly out of scope for v1)

- Multi-track video editing, transitions, effects, colour grading (that is CapCut the *editor*;
  we are building the *caption studio*).
- Server-side rendering / accounts / cloud sync.
- Perfect pixel-parity with Veed's proprietary WASM renderer. We aim for **visually equivalent**,
  verified by a diff harness, not bit-identical.
- Mobile/touch-first UX (desktop-first; touch is a nice-to-have).
- Speech-to-text languages beyond what the chosen engine supports (start English, architect for more).

### 1.4 Users & key scenarios

- **Primary user (you):** has a music video + an accurate lyric SRT; wants Veed/CapCut-quality
  captions without the watermark, and wants the AI *timing* fused with the *correct* lyrics.
- **Scenario A — Correct:** import video + SRT → align to Veed JSON → review corrections → style → export.
- **Scenario B — Generate:** import video only → transcribe → proofread in the editor → style → export.
- **Scenario C — Restyle:** load a saved project, switch template/font/placement, re-export instantly.

---

## 2. What "quality" means (the success bar)

"Lacks complete quality" was the verdict on v10. To avoid repeating that ambiguity, we define
measurable quality dimensions and target numbers. **These become automated tests.**

| Dimension | Definition | Target |
|---|---|---|
| **Text accuracy** | % of words exactly equal to the TRUTH file after correction | ≥ 99 % |
| **Timing accuracy** | mean absolute start-time error vs the AI/Veed word timing | ≤ 40 ms |
| **No drift** | caption drift (end-of-block error) never accumulates across a block | ≤ 120 ms at block end |
| **Containment** | % of words whose midpoint lands inside the correct block | ≥ 98 % |
| **No overflow** | % of rendered lines wider than the safe area | 0 % |
| **No orphans** | blocks with zero words / words outside all blocks | 0 |
| **Gap fidelity** | instrumental/gap regions contain no stretched words | 100 % preserved |
| **Visual parity** | per-frame diff vs a Veed reference render (SSIM on the caption layer region) | ≥ 0.95 |

The **diff harness** (§19.3) makes these numbers real: it renders a known clip and compares to the
reference frames already captured from the original Veed video.

---

## 3. Technology decisions & constraints

### 3.1 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | **Vanilla JavaScript (ES2022), ES modules** | No build step; runs from `localhost` on Windows; the old project proved this works. |
| Rendering | **Canvas 2D** (preview + overlay) with an optional **WebGL2** path later | Canvas 2D is sufficient, debuggable and stable; the plan keeps a renderer interface so WebGL can replace it. |
| UI | **Hand-written DOM + CSS**, no framework | Zero dependencies, no build; matches project convention. A tiny reactive store (~100 lines) replaces a framework. |
| State | Custom **immutable-ish store with command/patch log** | Enables undo/redo, autosave and deterministic tests. |
| Dev server | `python -m http.server 8000` **or** `npx serve` | `file://` breaks `captureStream`; one of these is always available on Windows. |
| Tests | Plain **Node test runner** (`node --test`) + a headless-Chrome visual harness | No build step; Node is already the only dependency present. |
| AI transcription | **`@huggingface/transformers` (transformers.js) with Whisper** running locally in a Web Worker, loaded from a pinned local copy | True offline; no API keys. Fallback: **browser Web Speech API** and **import-only** mode. |
| Video decode | native `<video>` element | Simplest, hardware-accelerated. |
| Export burn-in | **MediaRecorder** (`canvas.captureStream`) + optional **FFmpeg.wasm** for muxing | MediaRecorder for the graphics; FFmpeg.wasm only if we must re-mux audio. |
| Persistence | **IndexedDB** (autosave) + **File System Access API** with `<a download>` fallback | Survives reloads; exports download normally. |

### 3.2 Hard constraints

- **No network at runtime** for core features (fonts may be bundled; optional online font search).
- **Zero build step** — a user must be able to open the folder and run it.
- **Windows 11 first** — paths, dev-server commands and scripts must be Windows-friendly.
- **The Codebuff terminal is unavailable on this machine** (it requires Git Bash, which is not
  installed). Therefore *automated* test runs by the agent are limited; the plan includes manual
  and browser-console verification paths. Optional fix: install Git for Windows, or point
  `CODEBUFF_GIT_BASH_PATH` at `bash.exe`.

### 3.3 Dependency policy

- **Runtime: zero npm dependencies.** Anything needed is vendored into `vendor/` (e.g. the
  transformers.js bundle + a small Whisper model) so the app runs offline.
- **Dev: only `node:test`** (built-in). No Jest/Vitest/Playwright unless the user opts in.
- Every vendored asset is recorded in `vendor/VENDOR.md` with version + licence + source URL.

### 3.4 Browser target

Chromium (Chrome/Edge) first — required for `captureStream` + VP9-alpha `MediaRecorder`.
Firefox/Safari get a degraded path (no transparent overlay; burn-in only) with a clear UI notice.

---

## 4. Repository & folder structure

```
caption-studio/
├─ README.md                     ← what this is (done)
├─ IMPLEMENTATION-PLAN.md        ← this file (done)
├─ docs/
│  ├─ KNOWLEDGE-BASE.md          ← v1–v10 learnings (done)
│  ├─ DATA-MODEL.md              ← filled in during Phase 1
│  ├─ ALGORITHMS.md              ← alignment/correction math + worked examples
│  ├─ UI-SPEC.md                 ← wireframes, panel behaviour
│  └─ DECISIONS.md               ← ADR log (why we chose X)
├─ index.html                    ← the app shell (single page)
├─ styles/
│  ├─ tokens.css                 ← design tokens (colours, spacing, dark theme)
│  └─ app.css                    ← layout + components
├─ src/
│  ├─ main.js                    ← bootstrap, wires store ↔ UI ↔ renderer
│  ├─ store/
│  │  ├─ store.js                ← state container + subscribe/dispatch
│  │  ├─ actions.js              ← named commands (addBlock, setStyle, …)
│  │  ├─ history.js              ← undo/redo patch stack
│  │  └─ selectors.js            ← derived queries (active block at time t, …)
│  ├─ model/
│  │  ├─ schema.js               ← canonical shapes + defaults + validators
│  │  ├─ document.js             ← create/normalize/validate a caption document
│  │  ├─ id.js                   ← ULID-style id generator
│  │  └─ migrate.js              ← version up-migrations for project files
│  ├─ io/
│  │  ├─ srt.js                  ← SRT parse/serialize
│  │  ├─ vtt.js                  ← VTT parse/serialize
│  │  ├─ ass.js                  ← ASS (advanced styling) export
│  │  ├─ veed-json.js            ← import/export Veed master JSON
│  │  ├─ capcut-json.js          ← import/export CapCut-style draft JSON (best effort)
│  │  └─ project-file.js         ← .caproj save/load (JSON + assets manifest)
│  ├─ align/
│  │  ├─ normalize.js            ← text normalisation (case, punctuation, unicode)
│  │  ├─ tokens.js               ← tokenisation + word metadata
│  │  ├─ rolling.js              ← rolling-cue dedup (v10 F1 generalised)
│  │  ├─ dtw.js                  ← sequence alignment core
│  │  ├─ anchors.js              ← high-confidence anchor detection
│  │  ├─ aligner.js              ← orchestrates the alignment pipeline
│  │  ├─ corrections.js          ← produce a list of typed corrections
│  │  └─ report.js               ← machine-readable alignment report
│  ├─ transcribe/
│  │  ├─ worker.js               ← Web Worker: Whisper via transformers.js
│  │  ├─ whisper.js              ← main-thread controller (progress, chunking)
│  │  └─ webaudio.js             ← decode audio + resample to 16 kHz mono
│  ├─ render/
│  │  ├─ renderer.js             ← Renderer interface + factory
│  │  ├─ canvas2d.js             ← Canvas 2D implementation
│  │  ├─ layout.js               ← wrapping, line breaking, metrics cache
│  │  ├─ draw-text.js            ← text feed → pixels (display modes)
│  │  ├─ decorations.js          ← underline, box, outline, shadow, gradient
│  │  ├─ emoji.js                ← emoji → image stickers
│  │  ├─ animation.js            ← animation presets + easing
│  │  └─ time.js                 ← visibility/reveal state at time t
│  ├─ templates/
│  │  ├─ index.js                ← registry + lookup
│  │  ├─ defs/*.js               ← one file per template definition
│  │  └─ merge.js                ← template ⊕ overrides resolution
│  ├─ fonts/
│  │  ├─ registry.js             ← font family catalog + metadata
│  │  ├─ loader.js               ← @font-face injection / FontFace API
│  │  └─ packaged/               ← bundled woff2 files (Inter, etc.)
│  ├─ editor/
│  │  ├─ timeline.js             ← timeline rendering + scrubbing
│  │  ├─ blocklist.js            ← caption block list panel
│  │  ├─ wordlist.js             ← word-level editor
│  │  ├─ inspectors.js           ← style/inspectors panels
│  │  ├─ canvas-overlay.js       ← on-canvas drag handles, guides
│  │  ├─ corrections-panel.js    ← review/accept/reject AI↔TRUTH changes
│  │  └─ shortcuts.js            ← keyboard map
│  ├─ export/
│  │  ├─ burnin.js               ← MediaRecorder burn-in recorder
│  │  ├─ overlay.js              ← transparent overlay recorder
│  │  ├─ frames.js               ← offline frame-by-frame render (deterministic)
│  │  └─ ffmpeg.js               ← optional FFmpeg.wasm merge helper
│  └─ util/
│     ├─ events.js, math.js, dom.js, log.js, format.js, storage.js
├─ tests/
│  ├─ unit/*.test.js             ← node:test unit tests (parsers, aligner, layout)
│  ├─ fixtures/*.json            ← golden inputs/outputs
│  └─ visual/                    ← browser harness page + reference frames
├─ vendor/
│  ├─ VENDOR.md                  ← every third-party file, version, licence
│  ├─ transformers/              ← pinned transformers.js + whisper model (optional)
│  └─ fonts/                     ← bundled woff2
└─ projects/                     ← user-saved .caproj files (gitignored)
```

**Why this shape:** everything under `src/` is one concern per file; `align/` and `render/` are the
two engines that matter most, so they get the most files. The app is importable as modules, so
`tests/unit` can import `align/*` and `io/*` directly under Node with no bundler (all Node-only
differences isolated behind feature checks).

---

## 5. The caption document — core data model

The single object the whole app edits. Versioned from day one.

```jsonc
{
  "schemaVersion": 1,
  "id": "proj_01J...",
  "name": "Spider-Man Hero — corrected",

  "canvas":  { "width": 1280, "height": 720, "fps": 25 },

  "media": {
    "videoRef": "assets/video.mp4",     // relative path inside the project bundle
    "duration": 180.0,
    "audioRef": null
  },

  "sources": {                          // provenance, for auditing & re-alignment
    "ai":    { "kind": "veed-json", "ref": "sources/veed_master_v3.json", "importedAt": 1695... },
    "truth": { "kind": "srt",       "ref": "sources/spidy.srt",            "importedAt": 1695... }
  },

  "defaults": {                         // inherited by every block unless overridden
    "templateId": "veed-auto-highlight",
    "font":      { "family": "Inter", "weight": 900, "size": 0.036, "italic": false,
                   "letterSpacing": 0, "lineHeight": 1.15, "case": "none" },
    "fill":      { "color": "#ffffff", "opacity": 1 },
    "stroke":    { "color": "#000000", "width": 0 },
    "shadow":    { "color": "rgba(0,0,0,0.85)", "blur": 10, "offsetX": 3, "offsetY": 3, "onDecoration": false },
    "display":   "NORMAL",              // NORMAL | DROPSHADOW | BLOCK | LINE_BLOCK_ROUND | LINE_BLOCK_HARD | OUTLINE | OUTLINED
    "wrapWidth": 0.36,                  // normalized; 0 = no wrap
    "maxLines":  3,
    "align":     "center",              // left | center | right
    "anchor":    { "posX": 0.772, "posY": 0.848, "gravity": "center", "preset": "bottom-right" },
    "animation": { "in": "reveal", "inDur": 0.12, "out": null, "loop": null },
    "emphasis":  { "styleId": "auto-highlight", "decoration": "underline",
                   "decorationColor": "#22c55e", "italic": true, "weightBoost": 0 },
    "emoji":     { "enabled": false, "size": 0.08 }
  },

  "blocks": [
    {
      "id": "blk_01J...",
      "start": 15.20, "end": 16.72,
      "text": "Just an ordinary boy",              // derived, cached; rebuilt from words
      "overrides": { "font": { "size": 0.04 } },   // sparse patch on top of defaults
      "styles": [                                  // char ranges into `text`
        { "from": 5, "to": 14, "id": "auto-highlight",
          "style": { "italic": true, "color": "#ffffff", "bold": false, "underline": true } }
      ],
      "words": [
        { "id": "w_01J...", "text": "Just",      "start": 15.20, "end": 15.36, "charFrom": 0,  "charTo": 4,  "emphasis": false, "emoji": null, "confidence": null },
        { "id": "w_01J...", "text": "an",        "start": 15.36, "end": 15.48, "charFrom": 5,  "charTo": 7,  "emphasis": false, "emoji": null },
        { "id": "w_01J...", "text": "ordinary",  "start": 15.48, "end": 16.10, "charFrom": 8,  "charTo": 16, "emphasis": true,  "emoji": null },
        { "id": "w_01J...", "text": "boy",       "start": 16.10, "end": 16.72, "charFrom": 17, "charTo": 20, "emphasis": false, "emoji": null }
      ],
      "placement": null,                           // optional per-block anchor override
      "locked": false
    }
  ],

  "corrections": [                                 // the audit trail from the aligner
    { "id": "cor_...", "blockId": "blk_...", "wordId": "w_...",
      "type": "replace", "from": "crush", "to": "catch",
      "source": "truth", "applied": true, "confidence": 0.92 }
  ],

  "meta": { "createdAt": 1695..., "updatedAt": 1695..., "app": "caption-studio/0.1.0" }
}
```

### 5.1 Field-by-field notes

- **`schemaVersion`** — bumped on any breaking change; `model/migrate.js` maps old → new.
- **`canvas`** — normalized geometry means the same document renders at any output size. `fps`
  is the timeline/export rate.
- **`media.videoRef`** — a *relative path* inside a project bundle, not a blob URL, so a saved
  project is reproducible. In-session blob URLs live only in the store's ephemeral slice.
- **`sources`** — critical for the "two sources, two jobs" principle: re-running alignment needs
  both inputs, and the report tells the user which was which.
- **`defaults`** — every block inherits; per-block `overrides` are **sparse patches** (only what
  changed), which keeps files small and diffs readable.
- **`blocks[].text`** — **derived**, never hand-edited; rebuilt by `document.rebuildText()`.
  Invariant: `text === words.map(w=>w.text).join(' ')` and every word's `charFrom/charTo` matches
  its span in `text`. A validator enforces this on every load and every mutation.
- **`styles[]`** — char ranges (like Veed), resolved to words via overlap at render time. Kept as
  ranges (not per-word flags) because that is lossless and matches Veed's own model.
- **`words[].emphasis`** — a *resolved cache* of "is this word covered by the emphasis style",
  recomputed whenever `styles` or words change. Redundant by design (fast render, easy export),
  validated for consistency.
- **`corrections[]`** — the audit trail. Every AI→TRUTH change is recorded with confidence and
  `applied` flag. Undo of a correction flips `applied`; nothing is deleted, so the history survives.
- **`id`s** — stable across edits. Renaming a word does not change its id (important for anchors
  and for the corrections trail).

### 5.2 Invariants (enforced by `model/document.js validate()`)

1. Blocks are sorted by `start` and **do not overlap** (overlaps are a data corruption → error).
2. Each block's `words` are sorted by `start` and tile `[block.start, block.end]` without going out
   of bounds.
3. `text` equals the space-joined words; `charFrom/charTo` are consistent.
4. Style ranges are within `text` length and non-inverted.
5. Every referenced `templateId`, `font.family` and `styleId` exists in a registry.
6. `emphasis` flags equal the overlap of the emphasis style with each word.
7. No `NaN`/`Infinity`/negative durations anywhere.

Validation returns a list of typed issues; the UI blocks export on `error`-level issues and warns
on `warning`-level ones.

---

## 6. Module architecture (file by file)

The data flow:

```
            ┌────────────┐   import    ┌──────────────┐
 video ───▶ │ transcribe │ ──────────▶ │              │
 srt/vtt ─▶ │  (io/*)    │             │  caption     │  ──▶ store ──▶ UI panels
 veed json▶ └────────────┘             │  document    │  ──▶ render.canvas2d ──▶ preview
                                       │  (model/*)   │  ──▶ export.* ──▶ files
   truth + ai ──▶ align/* ──corrections─┘              │
```

Responsibilities:

| Module | Responsibility | Depends on |
|---|---|---|
| `model/*` | Canonical shapes, validation, migration, text rebuild | nothing |
| `io/*` | Parse/serialise every external format | `model` |
| `align/*` | Dedup, tokenise, align, produce typed corrections + report | `io`, `model` |
| `transcribe/*` | Media → word-timed AI blocks | `model` |
| `render/*` | caption document + time → pixels | `model` |
| `templates/*` | Named style/placement/animation presets | `model` |
| `fonts/*` | Family catalog + loading | nothing |
| `store/*` | State + commands + undo/redo + autosave | `model` |
| `editor/*` | DOM UI bound to the store | `store` |
| `export/*` | Deterministic recording to files | `render` |

**Rule:** dependencies point *inward* — `render`, `editor` and `export` may depend on `model`,
never the reverse. `model` imports nothing from `src/` except `util`.

---

## 7. Ingestion: media, captions, AI transcription

### 7.1 Media

- The user chooses a video with `<input type=file>` or drag-and-drop.
- We read `duration`, `videoWidth`, `videoHeight` from the element's metadata.
- `canvas` dimensions are set to the video's native size by default (the old project used a fixed
  1280×720; the new one adapts, with an optional "force output size" control).
- Blob URLs are created for playback; the file handle (if File System Access API available) is kept
  for autosave.

### 7.2 SRT parsing (`io/srt.js`)

Detailed rules (generalising the v10 parser, which only handled the happy path):

1. Normalise line endings (`\r\n`, `\r`, `\n` → `\n`). Strip a UTF-8 BOM.
2. Split into cue chunks on **blank lines** (`/\n\s*\n/`).
3. For each chunk: optional numeric index line, then the timing line containing `-->`, then text
   lines. Tolerate missing indices and stray blank lines.
4. Timing: accept `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS,mmm` and hour-less variants.
5. Strip inline markup `<i>…</i>`, `{\an8}`, `{\pos(...)}` (ASS-style tags occasionally appear in
   SRT) but **record what was stripped** in a `cue.tags` field so it can be re-emitted on export.
6. Preserve multi-line text as separate lines; the tokeniser decides how that maps to a block.
7. Return `[{ index, start, end, lines[], tags }]` and a `warnings[]` array.
8. **Rolling-cue detection is *not* done here** — `align/rolling.js` does it, because it needs the
   AI source to decide how to align.

### 7.3 VTT parsing (`io/vtt.js`)

Same shape as SRT plus:
- `WEBVTT` header, `NOTE`/`STYLE`/`REGION` blocks skipped.
- Cue identifiers on the line before the timing line.
- Timestamp with settings after the end time (`align:start position:10%`) parsed into `cue.settings`.
- Voice spans `<v Name>` and `<c.class>` tags stripped but recorded.

Both parsers are pure functions (string in → object out), so they are trivially unit-testable.

### 7.4 AI transcription (`transcribe/*`)

**Primary engine: Whisper via transformers.js in a Web Worker.**

- `webaudio.js` decodes the video's audio track to a `Float32Array`, downmixes to mono, resamples
  to **16 kHz** (Whisper's requirement) using an `OfflineAudioContext`.
- Audio is processed in **30-second chunks with a 5-second overlap**; chunk outputs are stitched by
  matching overlapping words (same normalised text within a small time window) so no word is duplicated.
- The model (`whisper-base` or `whisper-small`, quantised) is **vendored locally** in `vendor/`
  (~40–150 MB depending on size) so it runs offline. Model choice is configurable: *tiny* (fast),
  *base* (balanced), *small* (accurate).
- Whisper with **`word_timestamps: true`** yields per-word `{ text, start, end, probability }`.
  We write straight into the caption document's `words[]`, using `probability` as `confidence`.
- Progress events (percent, chunk index) drive a progress bar. Cancellation is supported.
- Runs in a Worker so the UI never freezes.

**Fallbacks (kept deliberately, in priority order):**

1. **Import an existing AI source** (SRT/VTT/Veed JSON) — works with zero AI at all. This is the
   main path for the music-video use case.
2. **Web Speech API** (`SpeechRecognition`) — real-time, no model download, but lower accuracy and
   *no reliable word timings*; we interpolate word timings from the segment. Clearly labelled "draft".
3. **External-transcript import** — paste a transcript (plain text or JSON with times) and align it
   to the media purely by the SRT/DTW machinery. This is where the correction engine earns its keep.

### 7.5 Veed JSON import (`io/veed-json.js`)

- Accepts `veed_master_v1/v2/v3` shapes (detected by presence of `canvas`/`style`/`subtitles`).
- v1: no `styles` → no emphasis ranges (warn the user).
- v2/v3: char ranges imported verbatim, then normalised (`from>0 → +1` leading-space convention,
  clamp) exactly as v10 **F5**.
- Blocks sorted chronologically if unsorted (defensive; v10 learned this the hard way).
- Word emojis preserved in `words[].emoji` but **not rendered** unless the template enables them.
- Result: a caption document with `defaults.templateId = "veed-auto-highlight"` and `sources.ai`
  pointing at the file.

### 7.6 Import flow summary

```
[Import] choose file
   ├─ .srt/.vtt → io parser → "TRUTH" slot (and, if no AI source, also used as the AI timing)
   ├─ veed_master*.json → veed-json importer → "AI" slot
   └─ .caproj → project-file loader → replaces whole document
[Generate] (no AI source) → transcribe → AI slot
[Correct] both slots present → align/* → corrections + report
[Apply] → corrected blocks in the document (reversible via corrections[])
```

---

## 8. The quality-correction engine (the heart)

This is the feature the old project lacked and the reason to build Caption Studio. It is a
**pipeline of pure functions** in `src/align/`.

### 8.1 Inputs and outputs

- **Input A (AI):** word-timed blocks (from Veed JSON or Whisper).
- **Input B (TRUTH):** line-timed cues (SRT/VTT) — authoritative text.
- **Output:** a *corrected* block list (TRUTH spelling + AI timing/emphasis) **plus** an explicit,
  inspectable list of `corrections[]` (every change, with confidence and reason).
- The engine **never silently rewrites**. Every substitution is a correction the user can reject.

### 8.2 Stage 1 — Text normalisation (`normalize.js`)

Define a deterministic normal form used *only for matching* (never for display):

- Unicode NFKC normalisation.
- Curly → straight quotes; em/en dashes → `-`; ellipsis → `...`; non-breaking space → space.
- Lowercase.
- Strip punctuation **for the matching key** but keep a parallel "punctuation skeleton" so we can
  restore it from TRUTH.
- Collapse whitespace.

`normalize(w)` returns `{ key, skeleton }`. The key is what DTW compares; the skeleton tells us
whether TRUTH differs from AI *only* in punctuation (a `punctuation` correction, not a `replace`).

### 8.3 Stage 2 — Rolling-cue resolution: the **birth-cue rule** (`rolling.js`)

Generalises v10 **F1**, but with a corrected timing model.

> **Refinement (implemented):** the plan originally said an occurrence spans *first-appearance
> start → last-appearance end*. Inspecting the real `spidy.srt` showed that is wrong: a line like
> `C` appearing in cues 1–3 would then span ~12 s and smear one line across three AI blocks,
> destroying the alignment signal. The correct model is the **birth cue** — *a line's window is the
> cue in which it first appears*; later appearances are on-screen context, not new lyrics.

The algorithm:

1. Walk the TRUTH cues in order, tracking the set of line keys present in the **previous** cue.
2. For each cue, the **new lines** are the lines whose normalised key was *not* in the previous
   cue. (In a rolling file this is the freshly-sung line — usually exactly one; the first cue may
   have several, and a final cue may have none.)
3. Each new line becomes an **occurrence**; if a cue has several new lines (e.g. the opening cue),
   the cue's span is split evenly between them.
4. A line that **returns after being absent** (the chorus at 2:36) is *new* at its return cue and
   correctly forms a **new occurrence** — v9's failure was deduplicating such lines globally.
5. Output: ordered occurrences `{ line, key, start, end, cueIndex }`, sorted by start and
   **non-overlapping** (v10's span rule produced overlapping occurrences; the birth-cue rule cannot).

Then `flattenOccurrences()` builds a **monotonic** TRUTH word stream with line-relative
interpolation (v10 **F4**):
- A line's duration is split across its words proportionally to character weight (v10 **F4**);
- word timings are therefore strictly non-decreasing across the whole song;
- words carry `mid = (start+end)/2` for the DTW time term.

**Worked example for `spidy.srt`:** the opening cue introduces **two** lines (`Just an ordinary
boy…`, `Head in the books…`) so its 4 s is split; every later cue introduces exactly one line; the
final cue introduces none. The result is ~40 timed occurrences (~1 per lyric line, *including*
chorus reprises as separate occurrences) and a strictly monotonic word stream — audited data rather
than the implicit effects v10 relied on. The integration test asserts monotonicity and coverage.

### 8.4 Stage 3 — Anchors (`anchors.js`)

Before running DTW, find **high-confidence anchors**: pairs (AI word, TRUTH word) that are almost
certainly the same. Anchors dramatically improve alignment and localise errors.

An anchor requires **all** of:

- Normalised keys are equal (after removing punctuation-only differences).
- The word is **not a stop-word** (a configurable list: `a, an, the, and, or, of, to, I, …`).
- **Time is only a tie-breaker, never a gate.** A key that occurs exactly **once** in TRUTH (and
  once in the AI stream) anchors outright. A **repeated** key (the chorus) anchors on its
  nearest-in-time occurrence, and only when that occurrence is clearly closer than the runner-up.
- A generous `maxDrift` (default `max(4·timeTol, 0.15·trackSpan)`, i.e. tens of seconds) still
  rejects absurd matches, but it is a sanity bound, not a precision test.

> **Calibration (measured, not assumed).** §8.4 originally required the two words to be within
> **±300 ms**. Running the real reference pair (Veed `veed_master_v3…json` vs `spidy.srt`) produced
> **0 anchors**, because TRUTH word times are *synthesised*: a rolling SRT cue covers 2–4 s and its
> new line is spread proportionally across that cue, so a TRUTH word sits **3 s → 7 s away** from the
> AI word (offset varies over the track). `|Δ|` percentiles on the unique-key pairs: min 3.11 s,
> p50 5.37 s, max 7.10 s — *none* within 300 ms, none within 3 s. A tight window cannot work here;
> equality of keys plus ordering is what carries the signal. With the rule above the same pair yields
> **135 anchors** on 233 AI / 255 TRUTH words.

Anchors are then *chained*: candidates are reduced to a **strictly increasing chain by a weighted
LIS** (weight = unique-in-TRUTH ≫ unique-in-AI > time closeness), so a doubtful anchor loses to a
confident one instead of corrupting the alignment. Each gap between consecutive anchors becomes a
**segment** to align independently, turning a global sequence-alignment problem into many small,
reliable ones.

### 8.5 Stage 4 — DTW / sequence alignment (`dtw.js`)

Within each segment (between anchors), align the AI word sequence to the TRUTH word sequence with a
**banded dynamic-time-warp**:

- Cost between AI word *i* and TRUTH word *j*:
  `cost = (1 − similarity(key_i, key_j)) * W_text + (|Δt| / T_norm) * W_time`
  where `similarity` is **normalised Levenshtein** (or Jaro-Winkler — cheaper, better for short
  words), `T_norm` is the segment duration in seconds, and `Δt` is the **relative** mid-time
  difference — both streams are re-based on their own segment start (`(mid_i − originAI) −
  (mid_j − originTRUTH)`). Defaults `W_text = 0.7`, `W_time = 0.3`.

  The re-basing matters: TRUTH carries a systematic offset that drifts by seconds (see §8.4), so an
  absolute comparison would penalise *every* correct pairing inside a short segment, where a few
  seconds is a large fraction of `T_norm`. Comparing timing *shape* instead keeps the term useful.
- Allowed operations: **match**, **substitute**, **insert (TRUTH-only)**, **delete (AI-only)**.
  - Insert = a TRUTH word with no AI counterpart (AI missed it) → interpolate its time between
    neighbours.
  - Delete = an AI word with no TRUTH counterpart (AI hallucinated or TRUTH lacks it) → keep it as
    a low-confidence word, flagged, or drop it depending on user policy.
- **Band constraint:** `|i − j| ≤ max(3, ceil(0.15 · segmentLength))`. Linear-time-ish, prevents
  pathological warping, and is exactly what the old heuristic *lacked*.
- Backtrack to produce an alignment path.

**Why DTW beats v10's midpoint containment:** v10 assigned each TRUTH word to the *one* AI block
whose window contained its midpoint. When tokenisation differed ("the ultimate toll," vs "the
ultimate.") that assignment was arbitrary and unverifiable. DTW aligns *sequences*, so a single
insertion in one place no longer corrupts everything after it — the classic failure mode with
repeated lyrics.

### 8.6 Stage 5 — Timing assignment (`aligner.js`)

For each aligned pair:

- **1 AI word ↔ 1 TRUTH word:** adopt the AI word's `start`/`end` *unchanged* (AI owns timing).
  The TRUTH word supplies the spelling.
- **1 AI ↔ N TRUTH (split):** split the AI word's interval across the N TRUTH words proportionally
  to character length (a single AI token often covers several TRUTH tokens).
- **N AI ↔ 1 TRUTH (merge):** the TRUTH word spans the union of the AI words' intervals.
- **TRUTH-only (insert):** place it **between its neighbouring AI words**, never from its own TRUTH
  time (which drifts seconds early and would drag the block backwards over the previous one). Bounds
  come from the neighbours, the block's own AI envelope, and a floor at the end of the previously
  emitted block, so blocks stay strictly non-overlapping. Mark `confidence: low`.
- **AI-only (delete/keep):** time kept; word kept but flagged (and optionally dropped).
- **Gap preservation:** if the AI timeline has a hole (like the 22-second instrumental break), it is
  **preserved** — no word is stretched across it. A segment with no anchors and no DTW path becomes
  a *gap*; blocks there are simply absent. This directly encodes v10 **F4a**'s cluster splitting.
- After assignment: enforce monotonic non-decreasing times; clamp to block bounds; **recompute block
  `start`/`end`** from its words (with a small configurable padding, mirroring Veed's chunking).

### 8.7 Stage 6 — Emphasis transfer (`aligner.js` + `corrections.js`)

- AI emphasis (Veed `styles[]` char ranges, or Whisper confidence spikes) is attached to **AI word
  indices**.
- During alignment we recorded which AI word(s) each TRUTH word maps to. Emphasis transfers by that
  mapping (not by temporal proximity, which v9 used and which had no meaning after text replacement —
  v10 **F5**).
- If an emphasis range covers AI words that map to several TRUTH words, all of them get the emphasis
  style range; if it maps to none (deleted word), the range is dropped and a warning is logged.

### 8.8 Stage 7 — Corrections & report (`corrections.js`, `report.js`)

Every change is emitted as a typed correction:

| `type` | Meaning | Example |
|---|---|---|
| `replace` | AI word text ≠ TRUTH word text | `crush` → `catch` |
| `punctuation` | Only punctuation/casing differs | `shadow` → `shadows,` |
| `insert` | TRUTH word missing from AI | `toll` inserted in "the ultimate toll," |
| `delete` | AI word absent from TRUTH | AI hallucinated word |
| `split` | One AI word → several TRUTH words | "don't" → "do not" |
| `merge` | Several AI words → one TRUTH word | "gon na" → "gonna" |
| `timing` | Time adjusted/interpolated | inserted word |
| `emphasis` | Emphasis moved to different words | keyword coverage changed |

Each correction stores: `blockId`, `wordId`, `from`, `to`, `type`, `confidence` (0–1),
`applied`, `reason` (which stage produced it).

The **report** is the machine-readable audit:

```jsonc
{
  "sourceWords": 143, "truthWords": 140,
  "anchors": 96, "aligned": 138, "inserted": 2, "deleted": 3,
  "replacements": 7, "punctuationOnly": 4,
  "gaps": [ { "start": 135.16, "end": 159.38 } ],
  "lowConfidenceSegments": [ { "start": 61.2, "end": 63.4, "score": 0.41 } ],
  "unmatchedAi": [ { "text": "yeah", "time": 88.2 } ],
  "unmatchedTruth": [ ]
}
```

The UI shows this as a **corrections panel**: a list of every change with a coloured diff, a
confidence bar, and per-item *accept / reject / accept-all* controls. Low-confidence segments are
highlighted on the timeline so the user can scrub straight to the risky parts.

### 8.9 Policy switches (user-facing)

| Setting | Default | Effect |
|---|---|---|
| Trust level | TRUTH wins for text, AI wins for timing | the core contract |
| Aggressiveness | balanced | DTW band width + stop-word list strictness |
| Insert missing words | on | create words AI missed |
| Delete extra words | off | keep AI-only words (flagged) |
| Punctuation policy | adopt TRUTH | use TRUTH's punctuation/casing verbatim |
| Gap threshold | 2.5 s | gaps larger than this are preserved, never stretched |
| Min confidence | 0.5 | corrections below this are flagged, not auto-applied |

### 8.10 Re-alignment & idempotence

- Alignment is **re-runnable**: the document keeps `sources`, so the user can change policy and
  re-run. Corrections are matched to existing words by `(blockId, wordId)` so manual edits survive.
- Determinism: given the same inputs, policy and version, the output must be byte-identical
  (no `Date.now()`, no `Math.random()` in the engine; ids are generated from a seeded counter).
  This is required for golden tests.

---

## 9. The rendering engine

> **Status: built and verified.** `render/*` and `fonts/*` exist, `168/168` tests pass, and
> `tests/unit/render-parity.test.js` transcribes v10's render loop and asserts our painted
> positions match it fragment-by-fragment. The interface below gained three members during
> implementation: `resize({width,height,dpr})` (DPR-aware backing store), `fit(document, box)`
> (aspect-preserving preview sizing) and a `size` getter.

### 9.1 The renderer interface

`render/renderer.js` defines a contract so Canvas2D can later be swapped for WebGL2:

```js
// Renderer
//   attach(canvas)
//   ensureFonts(document)        → Promise
//   measure(textFeed)            → { width, height, lines[] }
//   draw(document, time, opts)   → void      // opts: { preview, guides }
//   clear()
//   dispose()
```

The **only** input to drawing is `(captionDocument, time, opts)`. No renderer state survives a
frame. This makes offline frame rendering (§16.3) and the visual-diff harness possible.

### 9.2 The per-frame pipeline

```
for each block where block.start - lead <= t <= block.end + tail:
    feed = resolve(textFeedFor(block))          // defaults ⊕ block.overrides
    layout = layout.wrap(feed)                  // cached by (text, font, wrapWidth)
    drawText(feed, layout, t)                   // progressive reveal + display mode
    drawDecorations(feed, layout, t)            // underline/box/outline
    drawEmoji(feed, layout, t)                  // if enabled
```

Order matters: shadow → fill → stroke → decoration → emoji, so the underline sits above the text
but keeps its own shadow suppression (v10 spec).

### 9.3 Text layout & wrapping (`render/layout.js`)

The old replica had **no wrapping** — a real gap. Veed wraps to `wrapWidth` with `getWrappedLines()`.
Our implementation:

1. **Measure**: `ctx.measureText(word.text).width` per word, cached in a `Map` keyed by
   `(font, size, letterSpacing, text, case)`. Cache is invalidated on font-load or style change.
   Include `letterSpacing` manually (canvas `letterSpacing` is Chromium-only, so compute it):
   `width = measure(text) + letterSpacing * (len − 1)`.
2. **Wrap** to `wrapWidth × canvas.width`: greedily add words to the current line until adding the
   next would exceed the limit; break before it. If a single word exceeds the width, scale that
   word (or hard-break it) and warn. Respect `maxLines`; if exceeded, reduce font size by 5 % and
   retry (max 3 attempts).

   > **Refinement (implemented).** The plan originally said "then clip with a warning". Clipping
   > silently deletes lyrics, so instead a block that still exceeds `maxLines` after 3 attempts
   > keeps **every** line and reports the overflow in `layout.warnings`, which the UI can surface.
   > The quality target (0 % overflow) remains measurable from those warnings.
   >
   > `wrapWidth` is a fraction of canvas **width**, like `fontSize` — confirmed in Veed's own
   > `getTextProps()` (see §11.3). The default is **0.9**, not 0.36: 0.36 looks like a typo carried
   > over from `fontSize: 0.036`, and at the corrected font size it wraps lines that Veed renders on
   > one line. 0.9 is v10's proven overflow cap, so every line v10 kept on one line still fits on
   > one line while longer text wraps rather than being shrunk.
3. **Align** lines: `left` / `center` / `right` relative to the anchor; compute per-line x.
4. **Vertical layout**: total height = `lines.length × fontSize × lineHeight`; distribute lines.
5. Return `{ lines: [{ words[], width, x, y }], blockWidth, blockHeight }`.

The layout function is **pure** and unit-tested against fixed metrics (in tests we inject a fake
`measureText` so results are deterministic without a browser).

### 9.4 Word timing & progressive reveal (`render/time.js`)

For each word at time `t`:

- `revealed = t >= word.start` (progressive reveal — v8/v10 spec).
- **Critical detail from v10:** invisible words still consume layout space, so the line never
  reflows as words appear. We therefore lay out the *full* line and draw each word only when
  revealed.
- Word "active" window = `[word.start, word.end]`. Only karaoke-style templates use it.
- **Emphasis decorations are *not* limited to that window.** They are on screen from
  `word.start` to the **end of the block**: v10 draws the underline whenever the word is revealed
  (`if (isRevealed) … if (isHighlighted) underline`), and the block itself is only drawn while it
  is active. So the lime bar stays put for the rest of the caption instead of blinking off when the
  word stops being spoken. That is what "static underline, not karaoke" means concretely, and it is
  what `render/time.js` implements (`emphasis = revealed && word.emphasis`).
- Animation presets may add per-word transforms (scale/opacity/offset) on top of reveal; they are
  evaluated here and passed to the draw calls.

### 9.5 Display modes (`render/draw-text.js`)

Ported concept-by-concept from Veed's rasteriser (see Knowledge Base §4):

| Mode | Drawing |
|---|---|
| `NORMAL` | plain fill |
| `DROPSHADOW` | fill + offset blurred copy (or canvas `shadowBlur`) |
| `BLOCK` | one rounded box behind the whole block |
| `LINE_BLOCK_ROUND` | one rounded box per line, `radius = fontSize × 0.2`, padding around text |
| `LINE_BLOCK_HARD` | sharp-cornered per-line boxes |
| `OUTLINE` | fill + thick stroke (stroke first, then fill) |
| `OUTLINED` | stroke only (hollow text) |
| `none` | invisible (still occupies layout, useful for testing) |

Box modes honour `lineHeight × 1.5` line advance (matching Veed).

**Implemented addition:** the box styling lives in a new `box` field on the style
(`{ color, opacity, radius, paddingX, paddingY }`, the last three in **em** so they scale with the
font). It is used by `BLOCK`, `LINE_BLOCK_ROUND`/`_HARD` and by the `highlight` emphasis variant,
which CapCut-style templates need. `LINE_BLOCK_HARD` forces `radius: 0`. The paint order is
boxes → highlight backdrops → text → **underlines** → emoji, so the underline crosses the glyphs
(verified look) while a highlight stays behind the text rather than hiding it.

### 9.6 Decorations (`render/decorations.js`)

- **Underline** (the Veed emphasis): `thickness = max(4, fontSize×0.12)`,
  `y = lineBaseline + fontSize×0.55`, `width = word width`; drawn per-emphasised-word, opaque
  `#22c55e`. Shadow **suppressed** on the underline.
- **Background highlight**: rounded rect behind the word (CapCut "highlight" style).
- **Text stroke/outline**, **gradient fill**, **drop shadow** as separate decoration objects so a
  template can mix them.
- All decorations are drawn in **canvas pixel space after applying the layout transform**, so they
  stay crisp.

### 9.7 Emoji (`render/emoji.js`)

- If `emoji.enabled`, each word's emoji becomes an **image sticker** above/below the word
  (matching Veed: `size = 0.08 × canvas`, `zIndex 999`, aspect-corrected).
- Images load from a **local cache** (`fonts/`-style asset dir) with a network fallback to Veed's
  CDN; failures degrade silently (no broken glyphs).
- Default OFF, mirroring the verified source video.

### 9.8 Shadows, DPR and crispness

- Canvas backing store is `canvas.width × devicePixelRatio`, CSS size is logical. All drawing is in
  logical units; the context is pre-scaled once per frame.
- For export at the video's native resolution we create the recording canvas at
  `videoWidth × videoHeight` regardless of the preview canvas — export must not depend on the
  window size.
- Shadow blur is scaled by DPR so it looks the same on all displays.

---

## 10. Template & style system

> **As built (Phase 4).** This section was revised once the code existed. Two of the original draft's
> rules were changed, and both changes are the kind that only become visible when you try to make the
> behaviour idempotent — they are marked **changed** below.

### 10.1 What a template is

A template is **data, not code**: a named, complete style patch plus provenance. No template can do
anything a hand-written style object could not, which is what keeps a template-produced style and a
user-edited style interchangeable (and therefore export reproducible).

```js
// src/templates/defs/veed-auto-highlight.js
export default {
  id: 'veed-auto-highlight',
  name: 'Veed — Auto Highlight',
  origin: 'veed',
  description: '…',
  defaults: {
    font:   { family: 'Inter', weight: 900, size: 0.036, sizeUnit: 'w', italic: false, lineHeight: 1.15, case: 'none' },
    fill:   { color: '#ffffff', opacity: 1 },
    shadow: { color: 'rgba(0,0,0,0.85)', blur: 10, offsetX: 3, offsetY: 3, onDecoration: false },
    display:'NORMAL',
    anchor: { posX: 0.772, posY: 0.848, gravity: 'center', preset: 'bottom-right' },
    emphasis: { decoration: 'underline', decorationColor: '#22c55e', italic: true },
    animation: { in: 'reveal', inDur: 0.12 }
  }
};
```

One source of truth per template: each one lives in its own file under `templates/defs/` and is
listed exactly once in `templates/index.js`. Nothing in the app hard-codes a template's values.

**Validation happens at import.** `validateTemplate()` checks the id (kebab-case), `name`, `origin`,
that `display`/`reveal`/`emphasis.source` are real vocabulary, that `sizeUnit` is `w`/`h` and
`wrapWidth` is in `(0, 1]` — and, the check that earns its keep, that the font family exists in
`fonts/registry.js`. A typo like `Montserat` therefore fails loudly at module load instead of
silently rendering a fallback face.

### 10.2 The template set as shipped (10)

| id | Origin | Look |
|---|---|---|
| `veed-auto-highlight` | veed | **The verified original** — white Inter 900, lime underline + italic on AI keywords, bottom-right. |
| `veed-bold-clean` | veed | heavy white, no decoration, lower-third. |
| `veed-karaoke` | veed | white on a violet highlight block that **follows the playhead** (`emphasis.source: 'active'`). |
| `capcut-basic-white` | capcut | plain white, centred lower-third, no emphasis. |
| `capcut-yellow-pop` | capcut | bold yellow fill, black stroke, per-word pop. |
| `capcut-white-box` | capcut | rounded box behind each line (`LINE_BLOCK_ROUND`). |
| `capcut-neon` | capcut | outlined display caps (`OUTLINED`). |
| `cinematic-elegant` | generic | wide letter-spacing, thin weight, fade in/out. |
| `minimal-lower-third` | generic | small, **left**-aligned (`gravity: 'bottom-left'`), shown whole (`reveal: 'all'`). |
| `shorts-impact` | generic | large centred all-caps, one line at a time. |

Ordering is Veed → CapCut → generic, so the parity template is also the first option and "which one
matches the reference?" has an obvious answer. `templatesByOrigin()` returns the same grouping the
picker renders; `templateSwatch(id)` derives a card's colours and font *from the template's own
defaults* rather than hand-writing them beside them, so a card cannot drift out of date.

Origins are also what makes `emphasis.source` worth having: Veed's look marks the **AI keywords**,
CapCut's karaoke look marks the **word being spoken**. Same renderer, one flag.

### 10.3 Resolution rules (`templates/merge.js`)

```
effective = createDefaultStyle()
          ⊕ document.defaults        (the chosen template + any style edits)
          ⊕ block.overrides          (a sparse patch for one block)
          ⊕ { anchor: block.placement }   (kept as its own field, not in the override bag)
```

**Changed: the base is a fresh `createDefaultStyle()`, not the live defaults.** Applying a template
must be idempotent and order-independent — `apply(T1); apply(T2)` has to equal `apply(T2)`. If the
merge target were the current defaults, a stale value from T1 would leak through every key T2 does
not mention and switching back and forth would accumulate junk. Merging over a fresh parity base
makes each template a *complete* style, so switching twice is the same as switching once. It also
means the parity template describes the default style **exactly**, and `isTemplateUnmodified(doc)` is
therefore true for a document that has never been edited.

**Changed: the resolver memoises on content, not on a version counter.** `createStyleResolver()`
hashes `{defaults, overrides, placement}` and keeps an LRU of the last 128 resolved styles, so a
cache hit and a cache miss are indistinguishable from the outside — only the number of merges
changes. A version counter was rejected because it is one more thing an edit path can forget to
bump, while a content hash cannot go stale.

Other rules, unchanged:

- Merge is **deep for plain objects, replace for arrays and scalars.**
- `null`/`undefined` mean "inherit" — which is what makes an override sparse (`{ font: { size } }`
  without restating the family) and "reset this block" a single assignment. Note the consequence:
  `mergeDeep` never *copies* a null key, so a merged style legitimately omits `animation.out: null`.
- `anchor` is **atomic** (`model/schema.js#resolveAnchor`). A block that supplies its own position —
  as a `placement` or an explicit override — must not inherit the document's `preset` id, or a block
  dragged to the middle would still claim to be `bottom-right`. `gravity` *is* inherited, because a
  sparse `{ posX: 0.2 }` still needs a vertical rule to mean anything.

### 10.4 Per-block vs global styling

- Global style edits write to `document.defaults` (affect every block).
- When a block is selected, edits write to `block.overrides` (sparse), and dragging writes
  `block.placement`.
- **"Apply look to all captions"** = `promoteBlockToDocument()`: it folds the block's overrides *and*
  its position into the defaults and clears them from the block, so the block and its siblings are
  identical again. The patch is captured **before** the block is cleared, or the promoted values
  would be wiped from both places.
- **"Reset this block"** = `clearBlockOverrides()`; **"Reset position"** = `clearBlockPlacement()`;
  the position preset list has an explicit *inherit* entry for the same reason.
- A block row in the list shows an `override` chip and the preset id it is sitting on, so a per-shot
  tweak is visible without opening the inspector.
- Editing a *template-derived* style does not clear `templateId`: the picker shows
  "Veed — Auto Highlight · edited", exactly as Veed and CapCut do. A per-block override deliberately
  does **not** mark the document as edited, because the document style has not changed.

### 10.5 What is not built yet

Inline text editing (the caption text is still corrected, not hand-edited), a per-field "override"
chip next to each inspector control, and save/load of a project file for the style+
placement state. All three are additive: the data they need (`overrides`, `placement`, `templateId`)
already round-trips through the document.

---

## 11. Font system

### 11.1 Requirements

- Choose **family**, **weight**, **size**, **italic**, **letter-spacing**, **line-height**, **case**.
- Family list must include at least: Inter, Roboto, Open Sans, Montserrat, Poppins, Bebas Neue,
  Anton, Archivo, Oswald, Lato, Nunito, Source Sans 3, and a couple of handwriting/display faces.
- Work **offline** (bundled woff2) and allow **online search** (Google Fonts API) as an opt-in.
- Loading must be asynchronous but blocking for measurement: we `await document.fonts.load(...)`
  before laying out text with a new font, then invalidate the measure cache.

### 11.2 `fonts/registry.js`

Each entry:

```js
{ family: 'Inter', weights: [400,700,900], italics: true, category: 'sans',
  source: { kind: 'packaged', files: { '400':'Inter-400.woff2', '900':'Inter-900.woff2' } },
  metrics: { capHeight: 0.727, xHeight: 0.52, ascent: 0.969, descent: 0.242 } }
```

`metrics` (relative to em) let us compute precise baselines and underline positions without
per-font hacks, and let the layout engine reserve correct vertical space. They are estimated once
(offscreen measurement) and stored.

> **Measured, not assumed.** Veed's own bundle settles the width-vs-height question:
> `getTextProps()` returns `wrapWidth … * pretendedCanvasSize.width` **and**
> `fontSize … * pretendedCanvasSize.width`. Both size inputs are fractions of canvas **width**.
> The v10 replica used `canvas.height × 0.036` (`25.92 px` at 1280×720) where Veed uses
> `canvas.width × 0.036` (`46.08 px`) — a **×1.78** discrepancy, and a very plausible cause of the
> old "the font doesn't match" complaint. `font.sizeUnit: 'w'` is therefore the default; `'h'`
> reproduces the old behaviour for comparison.

### 11.3 Loading

- Packaged: inject `@font-face` rules pointing at `fonts/packaged/*.woff2`.
- Online (opt-in): fetch the CSS from Google Fonts, then the woff2 files; cache the CSS and file
  mapping in IndexedDB for offline reuse.
- `document.fonts.load('900 100px Inter')` then `document.fonts.ready`.
- The renderer **never measures before the font promise resolves**; the UI shows a small "loading
  font…" state to prevent layout with a fallback face (a real v1–v10 source of "the font doesn't
  match").
- **Font-size normalisation:** adopt Veed's own behaviour — `size` is a fraction of canvas
  **width** for Veed-parity templates (`sizeUnit: 'w'`) and of **height** where a template says so
  (`sizeUnit: 'h'`). This directly addresses the ×1.78 discrepancy found in Veed's `getTextProps()`.

### 11.4 Case handling

- `case`: `none | upper | lower | title | sentence`.
- Applied at **layout time** (not stored), so the underlying text stays editable and export can
  choose either form. Word char-offsets are unaffected because case-mapping preserves length in
  these locales (validated; otherwise fall back to per-word mapping).

---

## 12. Placement, anchoring & safe areas

### 12.1 Model

- Every block has an **anchor point** in normalized coords `(posX, posY)` and a **gravity**
  (how the text box sits relative to the anchor): `top|center|bottom` × `left|center|right`
  (9 combinations), matching Veed's `align`/anchor semantics.
- Text is laid out then positioned so the text box's gravity point coincides with the anchor.
- Default anchor is `(0.772, 0.848)` gravity `center` (the verified Veed position).

### 12.2 Presets

A 3×3 grid of placement presets (top-left … bottom-right) plus:
- "lower third", "centred", "top banner", "bottom banner", "full-centre" presets;
- safe-area presets for different aspect ratios (16:9, 9:16, 1:1, 4:5).

### 12.3 On-canvas interaction (`editor/canvas-overlay.js`)

> **As built (Phase 4).** Implemented: drag to move, snapping, keyboard nudge, per-block placement.
> Resize/rotate handles and the `Alt` override are not built yet (see below).

- Geometry is in `render/placement.js` — **pure, no DOM, no canvas** — and the overlay is only an
  event adapter over it. Every rule that could be wrong is therefore unit-testable without a browser.
- An absolutely-positioned overlay `<canvas>` covers the preview canvas and owns pointer input.
  *(It must be `.stage > .overlay-canvas` in CSS: the shared `.stage canvas { position: relative }`
  rule otherwise wins on specificity and leaves the overlay as a second, relative grid item below
  the preview — which looks fine and receives no events at all.)*
- **Drag body** → move the anchor. The grab offset (pointer − anchor at pointer-down) is held for the
  whole drag, so the text stays under the cursor instead of jumping so its anchor meets the pointer.
- **Snapping snaps the box's edges, not the anchor point.** The user is looking at the box, and the
  box centre coincides with the anchor only under `gravity: 'center'`. Each axis tests the box's
  left/centre/right (and top/middle/bottom) edges against the guides and moves the anchor by whatever
  delta lands the winning edge on the line. Targets: canvas centre, thirds, title/action-safe edges,
  canvas edges, and every other visible block's box edges. Tolerance 8 px; guides are drawn on the
  overlay while dragging (bright for the line that won, faint for the rest).
- **Clamping slides the box, never resizes it**, and an over-wide box is centred instead of pushed
  off one edge. Snap runs first so the clamp cannot pull a snapped box back off its guide.
- Arrow keys nudge by **0.5 % of the canvas** (`Shift` = ×4) — a fraction rather than a pixel, so a
  nudge means the same thing at every preview size and on every display (6.4 px on a 1280-wide frame).
  Arrow keys inside a text field are left alone.
- Placement is **per block by default** (`block.placement`), because that is the common edit; "inherit"
  in the position list returns the block to the document anchor, and "Apply look to all captions"
  makes a per-block position global.

Not built yet: resize handles (corner → font size, side → wrap width), a rotate handle, `Alt` to
suspend snapping, and the multi-block anchor overlay described in §12.5.

### 12.4 Safe areas & guides

- Guides for a configurable target aspect (default the video's): title-safe (90 %) and action-safe
  (93 %) rectangles.
- A live **overflow warning** if any rendered line crosses the action-safe area.
- Optional "broadcast safe" preset.

### 12.5 Multi-block placement view

A toggle overlays the anchor of *every* block, so global adjustments are visible at a glance.

---

## 13. Animation engine

Derived from Veed's named keyframe table (Knowledge Base §4), implemented in `render/animation.js`.

### 13.1 Model

```js
{ in: 'reveal', inDur: 0.12, out: null, outDur: 0.1, loop: null }
```

Animations are **scopes**: `block` (whole block), `word` (per word), `glyph` (per character).

### 13.2 Preset interface

```js
registerAnimation('fade', {
  scope: 'block',
  // t = 0..1 progress within the animation window
  apply(ctx, node, t) {
    node.opacity *= ease('quadOut', t);
  }
});
```

Each preset is a pure function over a `node` (transform/opacity/clip) plus `ease(name, t)`.
Built-in easings: `linear, quadIn/Out, cubicIn/Out, expoOut, sinOut, squareIn, backOut`.

### 13.3 Presets to implement in v1

`fade, slideUp/Down/Left/Right, zoomIn, bounce, pop (scale), typewriter, reveal, karaoke,
highlight, boxHighlight, typewriterCursor`. Additional Veed names are added as presets later —
the registry makes this a ~20-line file each.

### 13.4 Timing

- **In** animation runs over `[word.start, word.start + inDur]` (word scope) or
  `[block.start, block.start + inDur]` (block scope).
- **Out** over the last `outDur` of the scope's end.
- **Loop** runs continuously.
- The progressive **reveal** is not an animation preset per se — it is the default visibility rule
  in `render/time.js`; presets compose on top of it.

### 13.5 Performance

- Animations are only evaluated for words/blocks on screen.
- Transform computation allocates nothing per frame (reused scratch objects).

---

## 14. The interactive editor UI

### 14.1 Layout (desktop, 3 zones + toolbar)

```
┌──────────────────────────────────────────────────────────────┐
│ Toolbar: Import · Generate · Correct · Template ▾ · Font ▾ ·  │
│          Undo/Redo · Save · Export ▾                          │
├───────────────┬──────────────────────────────┬───────────────┤
│ Left panel    │        Preview + overlay      │ Right panel   │
│  • Sources    │   (video behind, captions,    │  • Style      │
│  • Blocks     │    guides, selection box)     │  • Font       │
│  • Corrections│                               │  • Placement  │
│  • Templates  │                               │  • Animation  │
├───────────────┴──────────────────────────────┴───────────────┤
│ Timeline: video track + caption blocks + correction markers    │
└──────────────────────────────────────────────────────────────┘
```

- All three panels are **collapsible**; layout is remembered per project.
- Dark theme by default (design tokens in `styles/tokens.css`).

### 14.2 Panels

**Sources panel** — load/unload video, AI source, TRUTH source; shows provenance badges and a
"re-align" button. Shows the alignment report headline (matched %, corrections count).

**Blocks panel** — scrollable list of blocks; each row shows time range + text preview + a warning
dot if any correction is pending. Click selects + seeks; double-click edits inline. Supports
multi-select (shift/ctrl) and bulk operations (shift times, apply style, merge/split blocks).

**Corrections panel** — the star feature. A list of every correction with a **word-level diff**
(`cru~~sh~~ → **catch**`), confidence bar, reason, and Accept/Reject buttons; a filter
(`all / conflicting / low-confidence / unresolved`); and "Accept all" / "Reject all" / "Revert".
Clicking a correction seeks the video and flashes the word.

**Style / Font / Placement / Animation inspectors** — form controls bound to the store; each field
shows an "inherited vs overridden" indicator.

**Timeline** — three stacked lanes: waveform/scrubber, caption blocks (draggable/resizable),
correction/low-confidence markers. Zoom + horizontal scroll; playhead; click-to-seek; drag block
edges to retime (with snapping to word boundaries).

### 14.3 Editing operations (all undoable commands in `store/actions.js`)

- Edit word text; split a word into two; merge adjacent words.
- Retime a block (drag) or a word (drag within timeline lane).
- Merge two blocks; split a block at a word.
- Add/remove a word; insert a block at the playhead.
- Apply/replace a style range; toggle emphasis on a word.
- Apply a template; reset to template; apply-to-all.
- Accept/reject corrections; re-run alignment with new policy.
- Change font/size/placement/animation globally or per block.

Every command produces a **patch** (JSON-diff style) so history is compact and replays deterministically.

### 14.4 Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | play/pause |
| `← / →` | nudge playhead 1 frame (`Shift`: 1 s) |
| `, / .` | previous/next word boundary |
| `Enter` | edit selected word |
| `Tab` | next word |
| `Del` | delete word (with confirm) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo/redo |
| `Ctrl+S` | save project |
| `Ctrl+E` | export dialog |
| `G` | toggle guides |
| `Alt+drag` | bypass snapping |
| `+/-` | font size up/down |

### 14.5 Accessibility & polish

- Focus rings on all controls; ARIA labels; full keyboard operability.
- Respect `prefers-reduced-motion` (animations in the preview can be previewed on demand).
- Non-blocking toast notifications for auto-actions ("Re-aligned: 7 corrections, 2 low-confidence").
- A **first-run walkthrough** overlay explaining the two-source concept.

### 14.6 Undo/redo (`store/history.js`)

- History is a stack of patches with a pointer; new edits truncate the redo branch.
- Coalescing: rapid same-field edits (typing, dragging) merge into one entry within 500 ms.
- History is per-document and capped (default 200 entries, configurable).
- Undo of an *alignment* restores the pre-alignment document **and** the corrections list, so the
  report stays truthful (corrections marked `applied:false`).

---

## 15. Playback & timeline synchronisation

- A single `requestAnimationFrame` loop drives both playback state and rendering.
- The **source of truth for time is `video.currentTime`** (not `performance.now()`); on each frame
  we read it and render. This keeps captions locked to the video even if frames drop.
- Preview can also run **without a video** (audio-only or metadata-only) using a virtual clock.
- Playback controls: play/pause, loop-a-selection, speed (0.25–2×), step frame.
- The caption render is **always** a function of the current time; scrubbing while paused re-renders
  immediately.
- Performance target: **60 fps** for ≤6 on-screen blocks; the measure cache plus per-block layout
  cache makes this comfortable. A frame-budget profiler overlay (toggle) shows ms spent in layout
  vs draw.

---

## 16. Export pipeline

### 16.1 Formats

| Output | Description |
|---|---|
| **Burn-in video** | MP4/WebM with captions composited over the video. |
| **Transparent overlay** | WebM (VP9) with alpha — the v1–v10 workflow for later FFmpeg merge. |
| **SRT** | corrected captions, line-level, standard. |
| **VTT** | corrected captions with optional word timings. |
| **ASS/SSA** | styled export (colour, outline, position) for players/FFmpeg `subtitles` filter. |
| **JSON project** | `.caproj` (the document + asset manifest). |
| **Veed JSON** | re-emitted `veed_master_v*` shape for round-tripping. |

### 16.2 Burn-in recording (`export/burnin.js`)

1. Create an offscreen canvas at the video's native size (not the preview size).
2. `stream = canvas.captureStream(fps)`.
3. `recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 25_000_000 })`.
4. Play the video **from 0**; each frame draw `drawImage(video)` then render captions at
   `video.currentTime` then `stream.requestFrame()` (or rely on the stream's frame capture).
5. Auto-stop at `video.ended`. Save the blob.
6. Warn if the tab loses focus (Chromium throttles throttling); show a "keep this tab visible"
   banner.
7. **Audio** is not captured by a canvas stream. Two paths:
   - *Simplest*: record captions-only and merge with the original video's audio in FFmpeg.
   - *Full*: use `AudioContext.createMediaElementSource(video)` + `MediaStreamDestination`, combine
     with the canvas video track via `new MediaStream([video, audio])`, so the recording has audio.
     This is the default for burn-in.

### 16.3 Deterministic offline rendering (`export/frames.js`)

MediaRecorder is real-time and browser-dependent. For maximum quality we also implement:
- A **frame-stepping renderer** that, for `t = 0, 1/fps, …`, renders the composited frame to a
  canvas and encodes each as PNG (or feeds `VideoEncoder`/WebCodecs where available).
- WebCodecs path: `VideoEncoder` + `VideoFrame` → muxed via a minimal WebM/MP4 muxer, giving
  **exact fps and no dropped frames**.
- PNG-sequence + FFmpeg path: export frames plus the corrected SRT, and provide a ready-made
  FFmpeg command (documented) — the most robust, and fully offline.

### 16.4 Overlay recording (`export/overlay.js`)

Same as burn-in but the canvas is **transparent** (no video drawn) and the background stays alpha,
so the WebM carries the caption layer only. A "preview behind" toggle is forced **off** before
recording (v10 lesson) to guarantee a fully transparent first frame.

### 16.5 Merge helper (`export/ffmpeg.js`)

- Optional FFmpeg.wasm integration for in-browser merging of overlay + video + audio.
- Also emits a copy-pasteable **native FFmpeg command** (Windows-friendly) so the user can merge
  offline with full control — the exact command is generated from the chosen inputs:
  ```
  ffmpeg -i video.mp4 -i overlay.webm -filter_complex "[0:v][1:v]overlay=0:0" ^
         -map 0:a -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy final.mp4
  ```
  (`^` line continuation is cmd.exe syntax; the UI also offers a PowerShell `` ` `` variant.)

### 16.6 Export dialog

Options: resolution (native / custom), fps, quality (bitrate/CRF), include audio, output format,
filename, and a link to the FFmpeg command. Persists choices between sessions.

---

## 17. Persistence, project files & autosave

### 17.1 `.caproj` bundle

A project is either:
- **Single JSON file** (`.caproj`, actually JSON) referencing external asset paths, or
- **Folder bundle** (via File System Access API) containing `project.json`, `assets/video.mp4`,
  `sources/*`, and `exports/`.

Single-file is the default (portable); folder bundle is opt-in (large videos).

### 17.2 Autosave

- Debounced (every 2 s after a change) write to **IndexedDB** (`caption-studio` DB, one record per
  project).
- A "restore last session?" prompt on load.
- Video blobs are cached in IndexedDB **only if** the user opts in (they can be large); otherwise
  the user re-selects the file, which is detected by name+size.

### 17.3 Versioning & migration (`model/migrate.js`)

- `schemaVersion` drives stepwise up-migrations (`v1→v2→v3`), each a pure function with its own test.
- Unknown future versions load read-only with a clear message.

---

## 18. Veed/CapCut import & compatibility

### 18.1 Veed

- Import: the existing `extraction_engine.js` (kept in the knowledge base) still works; the importer
  consumes its output. We generalise to any `template-*-sub` preset by reading the `style`/`styles`
  fields rather than assuming `template-027-sub`.
- Export: emit the same JSON shape for round-tripping.

### 18.2 CapCut

CapCut's draft format is proprietary JSON (`draft_content.json` etc.). We implement **best-effort**:
- Import: map CapCut text segments → blocks/words if the file exposes per-word or per-segment data.
- Export: write a CapCut-shaped draft for text materials (documented as experimental).
- This is explicitly **experimental** and gated in the UI; parity is not guaranteed.

### 18.3 Format-detection

`io/project-file.js` sniffs the JSON's top-level keys (`canvas`/`style`/`subtitles` → Veed;
`materials`/`tracks` → CapCut; `schemaVersion` → our own) and routes to the right importer.

---

## 19. Testing & quality validation

Because the agent's terminal is unavailable on this machine, the plan supports both automated
(where possible) and manual verification.

### 19.1 Unit tests (`node --test`, `tests/unit`)

Pure modules are fully testable in Node:
- `io/srt`, `io/vtt`: fixtures with edge cases (BOM, CRLF, missing index, hour-less times, tags).
- `align/*`: the worked examples below become golden tests.
- `render/layout`: with an injected fake `measureText`.
- `store/history`: undo/redo determinism.
- `model/document`: invariant validation (fuzz by generating random documents and asserting no
  silent corruption).

**Golden alignment fixtures** (from this project's real data):
1. Rolling `spidy.srt` → 24 occurrences, ~140 words.
2. Veed `crush` → TRUTH `catch` produces exactly one `replace` correction.
3. The 22 s gap `135.16–159.38` stays text-free.
4. `the ultimate.` (AI) vs `the ultimate toll,` (TRUTH) → one `insert` of `toll` + one
   `punctuation` correction, with no drift after it (the classic DTW win).

### 19.2 Property-based checks

- Alignment output is monotonic in time.
- Re-running alignment is idempotent (byte-identical).
- No word lies outside its block; no overlapping blocks.
- Round-trip: parse → serialise → parse equals the original (for SRT/VTT).

### 19.3 Visual regression (`tests/visual`)

- A harness page renders a fixed document at fixed times to a canvas and draws the grid.
- Reference PNGs are captured once (from the original Veed video for the parity template).
- Comparisons use **SSIM over the caption region** with a threshold (≥0.95 target).
- Since headless Chrome automation isn't guaranteed here, the harness also renders a
  **side-by-side HTML report** the user can open and eyeball, plus a "download diff" button.

### 19.4 Manual QA checklist (per release)

- Import each format; confirm no silent data loss.
- Align; confirm corrections are listed and every one is reversible.
- Switch every template; confirm no overflow and no crash.
- Font load → measure → layout ordering (no flash of fallback font).
- Placement drag/snap/nudge; per-block vs global.
- Render a 30 s clip burn-in and overlay; play both.
- Export SRT/VTT/ASS; re-import and diff.
- Undo/redo across all operations; reload and confirm autosave restore.

### 19.5 Performance benchmarks

- Layout of 6 blocks @ 60 fps on a mid-range PC; log frame time.
- Alignment of a 3-minute song < 2 s.
- Export frame-step throughput recorded per machine.

---

## 20. Milestones & phased delivery

Each phase ends with something runnable and testable. **No phase starts before the previous is
demonstrated.**

**Progress: Phases 0, 1, 2, 3 and 4 are complete and verified** — 246/246 unit tests, 33 browser
checks (`npm run ui`), and the reference-data verification in §4c of the Knowledge Base. The suite is
run with `npm test` from `caption-studio/`.

### Phase 0 — Skeleton (0.5 day)
- Folder structure, `index.html` shell, tokens.css, dev-server instructions, store stub, README.
- *Exit:* app loads, empty editor renders, no console errors.

### Phase 1 — Data model + I/O (1–2 days)
- `model/*` with validation + invariants; `io/srt`, `io/vtt`, `io/veed-json`, `io/project-file`.
- Golden-test the parsers.
- *Exit:* load video + SRT + Veed JSON; see blocks in a plain list; save/load `.caproj`.

### Phase 2 — Renderer v1 (2 days)
- Canvas2D renderer, layout+wrapping, progressive reveal, the **Veed parity template** exactly
  (posX/posY, underline, italic, shadow, no emoji).
- Preview with video behind.
- *Exit:* visually matches the v10 output (which already matched the verified spec) **and** wraps.

### Phase 3 — Alignment engine (2–3 days) ← **the heart**
- normalize, rolling dedup, anchors, DTW, timing assignment, emphasis transfer, corrections, report.
- Golden tests incl. the four fixtures in §19.1.
- Corrections panel with accept/reject.
- *Exit:* load `spidy.srt` + Veed JSON; get corrections; toggle them; confirm the corrected render.

### Phase 4 — Templates, fonts, placement, animation (2–3 days) ✅
- Template registry + the starter set; font registry + loading + metrics; placement presets +
  drag/snap; animation presets.
- *Exit:* switch templates/fonts live; drag captions; animations preview.
- *Delivered:* 10 templates validated at import (§10.2), `templates/merge.js` with a content-keyed
  style resolver (§10.3), `render/placement.js` + `editor/canvas-overlay.js` for drag / snap / nudge
  (§12.3), the template picker and block inspector in `index.html` / `src/main.js`, and
  `tools/ui-smoke.mjs` to drive the editor page in headless Chrome. Deferred to Phase 5: inline text
  editing, the per-field override chip, and save/load of the style + placement state.
- *Not built, noted as such in §12.3:* resize/rotate handles, `Alt` to suspend snapping, and the
  multi-block anchor overlay.

### Phase 5 — Timeline & editing polish (1–2 days)
- Timeline lanes, block list, word editor, keyboard map, undo/redo, shortcuts, bulk ops.
- *Exit:* full edit loop without touching code.

### Phase 6 — Export (1–2 days)
- Burn-in, overlay, SRT/VTT/ASS, FFmpeg command, export dialog, WebCodecs path.
- *Exit:* produce a final video from the music video with corrected captions.

### Phase 7 — Transcription (optional / parallel)
- Whisper worker, audio decode, chunk stitching, progress UI; Web Speech fallback.
- *Exit:* generate captions from scratch on a test clip.

### Phase 8 — Hardening (ongoing)
- Visual regression harness, performance pass, accessibility, `prefers-reduced-motion`, docs.

**Suggested order given the user's priority (quality correction first):**
Phase 0 → 1 → **3 (align engine, headless-testable with good fixtures)** → 2 (render) → 4 → 5 → 6 →
7. Doing alignment before rendering lets us validate the hardest part against golden data with no
browser involved — important because the agent's terminal is unavailable.

---

## 21. Windows 11 environment & tooling

- **Terminal reality check:** Codebuff's `run_terminal_command` on this machine fails with
  *"Bash is required but was not found on this Windows system."* It launches commands through
  **Git Bash**, which isn't installed — so **none** of our commands ran, PowerShell or otherwise
  (a PowerShell command was attempted and the launcher itself failed). Two options:
  1. Install Git for Windows (`winget install --id Git.Git -e`), then the agent can run commands; or
  2. Set `CODEBUFF_GIT_BASH_PATH` to an existing `bash.exe` if one is present.
  Until then, all work is done with the file tools.
- **Dev server (run manually in PowerShell or cmd):**
  ```powershell
  # PowerShell
  cd C:\path\to\caption-studio
  python -m http.server 8000      # then open http://localhost:8000
  # or, if Node is preferred:
  npx --yes serve -l 8000 .
  ```
  ```bat
  :: cmd.exe
  cd /d C:\path\to\caption-studio
  python -m http.server 8000
  ```
  (The project itself never needs a bundler, so no `npm install` is required.)
- **Why a server is mandatory:** `file://` blocks `canvas.captureStream` and Web Workers; captions
  recording and transcription both require `http://localhost`.
- **FFmpeg:** install via `winget install Gyan.FFmpeg` (or use a static build). The app generates the
  exact command; `^` continuation for cmd.exe, `` ` `` for PowerShell.
- **Paths:** the app uses only forward-slash relative paths internally; Windows back-slashes are
  normalised on input.
- **Fonts:** `fonts/packaged/*.woff2` (no C:\Windows font dependency), so the app is portable.
- **Large assets:** keep `video.mp4` and Whisper models out of git (`projects/` and `vendor/` entries
  documented; a `vendor/VENDOR.md` records download instructions).

---

## 22. Risks & mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Alignment still imperfect on repeated lyrics | wrong text/timing | medium | anchors + banded DTW + corrections UI lets the user fix fast |
| Whisper model too large/slow | transcription UX poor | medium | offer tiny/base/small; run in Worker; import-only path always works |
| Transparent VP9 alpha unreliable | overlay has black bg | medium | WebCodecs path + FFmpeg colorkey fallback documented |
| Fonts not bundled in time | wrong look | low | ship Inter first (the parity font), rest optional |
| No automated terminal for the agent | slower verification | high | headless-testable align module + golden fixtures + manual checklist |
| Canvas `letterSpacing` browser differences | minor text width drift | low | compute letter-spacing manually, never rely on `ctx.letterSpacing` |
| Scope creep into a full video editor | project stalls | medium | explicit non-goals (§1.3), phase gates |
| CapCut JSON format undocumented | import/export breaks | medium | mark experimental; never block core features on it |
| Measurement before font load | wrong layout | medium | blocking font promise + measure-cache invalidation |

---

## 23. Appendices

### A. Alignment worked example (the `crush`/`catch` case)

```
AI (Veed):    [I]   [crush] [the]   [falling,]   (t=...)  ...
TRUTH (SRT):  [I]   [catch] [the]   [falling,]
cost matrix (normalised Levenshtein, W_text=0.7, W_time=0.3)
→ match/mismatch path: I=I, crush→catch (substitute, sim=0.6), the=the, falling,=falling,
result: one correction { type:'replace', from:'crush', to:'catch', confidence:0.92 }
times: inherited from the AI words unchanged (AI owns timing)
```

### B. Alignment worked example (`the ultimate.` vs `the ultimate toll,`)

```
AI:    the  ultimate.           (block ends)
TRUTH: the  ultimate  toll,
DTW path: the=the, ultimate=ultimate, (insert: toll,)
→ corrections: punctuation("ultimate." → "ultimate"), insert("toll")
→ times: `toll` interpolated in the gap before the next aligned word; NO drift after it
   (this is the case v9/v10 mishandled by shifting every following word)
```

### C. The Veed parity template — exact numbers (lock these)

| Property | Value |
|---|---|
| font | Inter, weight 900, size `0.036 × canvas.width`, lineHeight 1.15 |
| fill | `#ffffff`, opacity 1 (never dimmed) |
| reveal | word-by-word (`t >= word.start`) |
| emphasis | `underline` `#22c55e`, thickness `max(4, size×0.12)`, `y = baseline + size×0.55`, + italic |
| shadow | `rgba(0,0,0,0.85)`, blur 10, offset (3,3), suppressed on decoration |
| anchor | `(0.772, 0.848)`, gravity center |
| display | `NORMAL` |
| emoji | disabled |
| wrapWidth | `0.36` (tuned to match Veed chunk widths) |

### D. Glossary of external data shapes

See `docs/KNOWLEDGE-BASE.md` §3 (Veed JSON) and §4 (Veed text feed + display modes + animation table).

### E. Decision log (to be filled as ADRs)

- ADR-001: zero-build vanilla ES modules (vs. adding a bundler).
- ADR-002: Canvas2D first, WebGL2 optional later.
- ADR-003: alignment engine ordered before renderer in the milestone plan.
- ADR-004: normalized width-based font sizing for Veed parity.
- ADR-005: corrections are an audited, reversible list — never silent.

---

*End of plan. Review requested before any implementation begins.*
