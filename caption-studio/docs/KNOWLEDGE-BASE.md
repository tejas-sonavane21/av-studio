# Knowledge Base — Caption Studio design notes

This document distils the engineering lessons behind Caption Studio: how a caption is
modelled, how it is drawn, how AI-generated captions are corrected against a trusted
subtitle file, and the traps that cost the most time. It is deliberately **vendor-neutral** —
it records design rules, not the internals of any one product.

Read this before the implementation plan.

---

## 1. Purpose

Caption Studio is a local-first caption editor. Its job is to take a machine-generated
caption track (words with approximate timings) plus a trusted subtitle transcript, and
produce a caption document that is correct in spelling, believable in timing, and styled
the way a modern video editor would style it. Three concerns are separated on purpose:

1. **Alignment / correction** — make the words right and place them in time.
2. **Rendering** — draw the caption document deterministically on a canvas.
3. **Editing** — let a human override any of it, per project or per block.

Keeping those three apart is what makes the system testable without a browser and without
a video.

---

## 2. The caption "text feed" model

The most useful abstraction is to treat a caption as a **text feed item** — a flat object
that carries everything needed to draw it, independent of how it was produced:

```
{ x, y, rotation, zIndex, from, to, font, emphasis, display, align, size, textWrap,
  wrapWidth, letterSpacing, lineHeight, color, bg, value, styles[], shadow, outline,
  background, rangeProperties[] }
```

Two conventions from this model carry through the whole codebase:

- **Everything positional is normalized** (a fraction of canvas width/height), never pixels.
  Conversion to pixels happens once, at draw time, using the current canvas size. This is
  what makes the same document render correctly in a small preview and a full-resolution
  export.
- **Style is a sparse patch, not a complete object.** `rangeProperties` / `styles[]` apply
  only the fields they mention, layered over the block's base style. Sparse styles are what
  let one template express "white text, but italic + coloured for the highlighted words".

Modelling a caption as a feed item is what makes multi-style, multi-animation, placement
and wrapping tractable: the renderer only ever has to answer "given this object and this
timestamp, what does it look like?"

---

## 3. Rendering spec — the reference "auto-highlight" look

Frame-by-frame analysis of the reference output established the target look. This is the
*spec*, not a guess:

| Property | Value |
|---|---|
| Text colour | pure white, always fully opaque (inactive words are **not** dimmed) |
| Font | a heavy geometric sans (weight 900) |
| Reveal | **progressive, word by word** — a word is drawn once `time >= word.start`; unrevealed words still advance the layout so the line never reflows |
| Animation | none by default — the text is static |
| Keyword emphasis | a coloured **underline + italic slant** on the AI-highlighted words |
| Underline geometry | thickness `max(4, fontSize × 0.12)`, `y = anchorY + fontSize × 0.55`, width = the word's own measured width, no horizontal padding |
| Drop shadow | dark, soft, offset; **suppressed on the underline** |
| Background box | none in this preset |
| Emoji | not rendered, even when the source data carries emoji tags |

**The most important correction in the project:** early versions drew a background box, a
bounce animation, dimmed inactive words and emojis. All wrong. The real preset is a static
white line with a coloured decoration on the keywords.

### 3.1 The underline outlives its word

The emphasis decoration is drawn whenever the **word** is revealed, and the whole block is
only drawn while `time` is inside `[block.start, block.end]`. So a highlighted word's
underline is on screen for `[word.start, block.end]` — the rest of the caption — **not** the
word's own `[start, end]` window. Gating the decoration on `word.end` makes the bar blink
off mid-line. This is verified by tests because it is invisible in a static screenshot.

### 3.2 Where each value comes from

Font size, position and alignment must come from **real data**, not from metadata that
merely sounds authoritative. Early metadata fields (padding hints, highlight colours) were
misleading and produced a completely different look; the values that survived are the ones
confirmed from the rendered output.

---

## 4. Geometry, in one place

Single line, left-aligned text, middle baseline:

```
totalW      = Σ(wordWidth) + spaceW × (n − 1)
line.x      = anchorX − totalW / 2          // anchorX = canvasWidth  × posX
line.y      = anchorY                        // anchorY = canvasHeight × posY
word[i].x   = line.x + Σ(width + spaceW) for all previous words
```

Unrevealed words still advance the cursor, so the line is laid out once and stays put.

### 4.1 `fontSize` and `wrapWidth` are fractions of canvas **WIDTH**

This is the single highest-impact rendering correction in the project.

- **Font size is width-relative.** `px = canvasWidth × fontSize`. An earlier implementation
  used height (`canvasHeight × 0.036`) and was therefore **×1.78 too small** at 16:9 — which
  is a plausible and long-standing explanation for "the font doesn't match".
- **Wrap width is also width-relative.** A value like `0.36` that looks like a typo for
  `0.036` will wrap lines that should stay on one line, because a ~20-character line at the
  correct font size already spans a large fraction of the frame. The parity style uses `0.9`
  as a proven overflow cap: every line that fits before still fits, while longer text now
  wraps instead of being shrunk.

Both are width-relative in the reference renderer; the earlier height-relative assumption
was a bug, not a design choice.

### 4.2 Box/display styling

The extracted source data never carried a colour for a background box, so the model exposes
a `box` field (`{ color, opacity, radius, paddingX, paddingY }`, the last three em-relative)
rather than hard-coding a black box. This lets templates style the box without touching the
renderer.

---

## 5. Alignment / correction engine

### 5.1 Two sources of truth, and what each is good for

| Source | Good for | Not good for |
|---|---|---|
| AI caption track | per-word timings, which words are highlighted | spelling (often wrong) |
| Trusted subtitle transcript | spelling and wording | timing (line-level only) |

Fusion means: **spelling comes from the transcript, timing and emphasis come from the AI
track.** The quality engine is a first-class feature, not an afterthought — the two sources
disagree often, and silently picking one is how you ship wrong lyrics.

### 5.2 Derived word times are estimates, not a clock

When the transcript is line-level only, any word timing derived from it (cue start + a
proportional spread) is an estimate. Measured against the AI track on real material, the
offset was large and drifting (median several seconds; essentially zero pairs within 300 ms).

Consequences now baked into the design:

- **Anchoring cannot use a tight time window.** A ±300 ms window found *zero* anchors on the
  real data; the shipped rule (equality of normalized keys plus ordering) finds 135. Time is
  only used to break ties between repeated lyrics.
- **DTW's time term must compare shape, not absolute time.** Re-base both streams on their own
  segment start, or a few seconds of offset penalises every correct pairing inside a short
  segment.
- **An inserted word must never take its own estimated time**, which drifts seconds earlier
  than the AI timeline and drags its block backwards over the previous one. Bound it by the
  neighbouring AI words, the block's own envelope, and a floor at the previous block's end.

### 5.3 Robustness rules

These were each learned the hard way and are now invariants:

- **Deduplicate rolling / cumulative cues.** Subtitle formats often repeat the previous lines
  in every cue; without collapsing repeats, every word is emitted several times.
- **Contain, don't scatter.** Map a word to a block only by *midpoint containment*; log
  unmatched words instead of assigning them to a distant nearest block.
- **Never mutate the source word array.** Sorting it mid-iteration reorders the data under the
  loop and corrupts the result.
- **Recompute highlights from the source ranges once per block**, then clamp and flag partial
  overlaps. Do not carry stale emphasis across a remap.
- **Preserve timing gaps.** Long instrumental breaks are text-free; do not stretch words across
  them. Split a span into clusters on large gaps instead.
- **Keep a fallback.** A block with no mapped words keeps its original text rather than being
  blanked.
- **Guard overflow, and report.** Scale a line down if it exceeds ~90 % of the width, and emit
  a human-readable fusion report (anchors, corrections, unmatched words) so quality problems
  are visible instead of silent.

### 5.4 Corrections are typed events

Corrections are recorded as explicit, typed changes (`replace`, `insert`, `delete`) with the
before/after text, so the UI can show a diff and a reviewer can accept or reject each one
rather than trusting an opaque rewrite.

---

## 6. Templates and style merging

Ten templates ship (a faithful "auto-highlight" parity style, a couple more editor-inspired
looks, and several original designs). Five lessons:

### 6.1 A template must be merged over a *fresh* base, never the live defaults

`mergeDeep(currentDefaults, template.defaults)` looks obviously right and is wrong: any key
the next template does not mention leaks through from the previous one, so `apply(T1); apply(T2)`
≠ `apply(T2)` and switching back and forth accumulates junk. Merging over `createDefaultStyle()`
every time makes each template a *complete* style. This makes switching idempotent and
order-independent, and it makes "is this document still on the default template?" answerable
(`true` for a fresh document).

### 6.2 "Null means inherit" has a sharp edge

`mergeDeep` never copies a null-valued key (that is what makes sparse patches work), so
`mergeDeep(style)` ≠ `style` — a merged style legitimately omits keys like `animation.out: null`.
Compare merged styles against other merged values, or field by field; a deep-equal against a
hand-written object fails for reasons unrelated to the bug you are chasing.

### 6.3 An anchor is atomic

Deep-merging `{posX, posY}` over a document anchor also inherits the document's `preset` id, so
a block dragged to the middle still claims to be `bottom-right` and the inspector contradicts
the canvas. `resolveAnchor` now takes the position from exactly one source and inherits only
`gravity` (a sparse `{ posX: 0.2 }` still needs a vertical rule). A unit test caught this; the
eye did not.

### 6.4 Per-block overrides must not look like a document edit

Promoting a block's overrides into the document must capture the patch **before** clearing the
block, or the values are wiped from both places. And the distinction is user-visible: a
per-block override leaves the document on its template, while promotion marks the document
"edited".

### 6.5 Application is asynchronous — order it

Applying a template awaits font loading. A burst of clicks therefore lets the *slowest*
application repaint last: the picker shows one template while the document holds another. The
document mutation is synchronous (it is already correct); only the repaint needs ordering, so a
monotonically increasing token makes every application but the newest a no-op after its
`await`. Same shape as any "last user intent wins" async UI.

---

## 7. Placement and snapping

- **Snap the box, not the anchor point.** Dragging moves the anchor, but the user's eye is on
  the box — and the two coincide only under centre gravity. Snapping the anchor makes a caption
  visibly refuse to line up. Concrete case: a 200 px centred box whose anchor is 97 px from the
  centre line has its **right edge** 3 px from it. Anchor-based snapping with an 8 px tolerance
  finds nothing; box-edge snapping lands the edge exactly on the guide. Same rule vertically
  with top / middle / bottom.
- **Snap before clamping**, so the clamp can never pull a snapped box back off its guide.
- **Per-block placement is a first-class override**, stored as a sparse patch on the block, not
  written back into the document style.

---

## 8. Bugs that only exist in a browser

The editor entry point is invisible to Node, so it is exercised in headless Chrome by a scripted
smoke test. It found two things no amount of reading would have surfaced:

1. **CSS specificity silently disabled the overlay.** A shared element selector
   (`.stage canvas { position: relative }`) beat a class-only rule (`.overlay-canvas
   { position: absolute }`) on specificity, so the overlay stayed a *relative grid item* — a
   second row below the preview — and received no pointer events; the canvas underneath took
   them all. Fix: raise the selector to `.stage > .overlay-canvas`. Generalisation: when a
   shared element selector exists, any class-only rule for a new element of that type is
   fighting on specificity and will lose quietly.
2. **Async re-entrancy in a click handler** — see §6.5.

---

## 9. Operational constraints

- **`file://` breaks canvas recording.** Serve over `http://localhost`; a tiny static server with
  HTTP range support is enough for video seeking.
- **Hidden tabs are throttled.** Browsers throttle `requestAnimationFrame` / `MediaRecorder` to
  ~1 FPS when the tab is hidden or minimised, so the tab must stay focused while recording.
- **Transparent overlay recording** uses `canvas.captureStream()` + `MediaRecorder`; alpha
  support is browser-dependent, so keep a colorkey compositing fallback.
- **`node --test` with a bare directory fails on Node 24** (it is treated as a module). Pass a
  glob: `node --test "tests/unit/*.test.js"`.
- **Killing a background server on MINGW is not `kill $!`.** The bash job PID is not the OS PID,
  so `kill $!` exits 0 while the process keeps the port, and a stray server silently shadows the
  next run. Find the real PID by port and kill that.
- **Don't parse a request target with `new URL()` in the dev server.** A target starting with `//`
  is read as protocol-relative and throws, and malformed escapes throw too; either one kills the
  server mid-request. Decode the target by hand, answer `400` on bad input and `403` for anything
  that normalises outside the project root.
- **Verifying the editor needs a browser, so it is scripted.** A headless-Chrome smoke test drives
  the real page over CDP, clicks the demo, exercises the template picker and the inspector, drags
  a caption with genuine input events, and fails on any uncaught exception or console error.

---

## 10. Verification strategy

- **Unit tests run in Node** and cover the pure logic: tokenizing, normalization, DTW, anchors,
  corrections, the document schema, layout math, decorations, animation, templates, merging and
  placement. Rendering is tested against a fake canvas that records the painted positions, so the
  exact geometry (word x-positions, underline rects) is asserted without a browser.
- **A parity test transcribes the reference geometry formula** and compares it with what the
  renderer actually paints, so a regression in the draw path fails a fast unit test.
- **A browser smoke test** covers the wiring the unit tests cannot see (see §9).
- **A visual harness** runs the real pipeline in headless Chrome and measures the render against a
  reference frame. It is only as good as the reference: if the reference clip contains no captions,
  the harness correctly reports `no-reference-caption` rather than inventing a pass. Visual parity
  against a true reference output remains outstanding until such a reference exists.
