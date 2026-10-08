/**
 * renderer.test.js — the whole draw pipeline, driven through a fake canvas.
 *
 * This is the test file that would be impossible without `tests/helpers/fake-canvas.js`, and it is
 * the closest thing to "seeing" the render without a browser. It asserts on *recorded draw calls*:
 * which strings were painted, where, and with which font — plus the two behavioural rules the whole
 * renderer exists to get right:
 *
 *   - unrevealed words occupy space but are not painted (no reflow),
 *   - the lime underline appears with its word and stays for the rest of the block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDemoDocument } from '../../src/model/demo.js';
import { createDefaultStyle } from '../../src/model/schema.js';
import { createRenderer, assertRenderer, RENDERER_API, RENDERER_KINDS } from '../../src/render/renderer.js';
import { SAFE_AREAS, createCanvas2DRenderer } from '../../src/render/canvas2d.js';
import { createFakeCanvas, createContextlessCanvas } from '../helpers/fake-canvas.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);

/** A renderer attached to a fake canvas, sized to the demo document. */
function setup(doc = createDemoDocument()) {
  const canvas = createFakeCanvas();
  const renderer = createRenderer('canvas2d');
  renderer.attach(canvas);
  renderer.resize({ width: doc.canvas.width, height: doc.canvas.height, devicePixelRatio: 1 });
  return { doc, canvas, renderer, ctx: canvas.getContext('2d') };
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test('the factory returns an object satisfying the documented contract', () => {
  const renderer = createRenderer('canvas2d');
  assert.equal(renderer.kind, 'canvas2d');
  assert.equal(assertRenderer(renderer), renderer);
  for (const method of RENDERER_API) assert.equal(typeof renderer[method], 'function', method);
});

test('an unknown renderer kind fails loudly and helpfully', () => {
  assert.throws(() => createRenderer('webgl2'), /unknown renderer "webgl2"/);
  assert.throws(() => createRenderer('webgl2'), /canvas2d/);
  assert.deepEqual(RENDERER_KINDS, ['canvas2d']);
});

test('assertRenderer rejects an incomplete object', () => {
  assert.throws(() => assertRenderer({ attach() {} }), /missing: resize/);
  assert.throws(() => assertRenderer(null), /not a renderer/);
});

test('attach requires a real canvas-like element', () => {
  const renderer = createRenderer('canvas2d');
  assert.throws(() => renderer.attach(null), /a <canvas> element is required/);
});

test('attaching to a canvas with no 2D context fails immediately, not mid-frame', () => {
  const renderer = createRenderer('canvas2d');
  assert.equal(createContextlessCanvas().getContext('2d'), null);
  assert.throws(() => renderer.attach(createContextlessCanvas()), /no 2D context/);
});

test('createCanvas2DRenderer is importable directly', () => {
  assert.equal(typeof createCanvas2DRenderer, 'function');
});

// ---------------------------------------------------------------------------
// sizing + DPR
// ---------------------------------------------------------------------------

test('resize sets a DPR-scaled backing store, CSS size, and resets the transform on draw', () => {
  const { renderer, canvas, doc } = setup();
  renderer.resize({ width: 1280, height: 720, devicePixelRatio: 2 });
  assert.equal(canvas.width, 2560);
  assert.equal(canvas.height, 1440);
  assert.equal(canvas.style.width, '1280px');
  assert.equal(canvas.style.height, '720px');

  renderer.draw(doc, 15.5);
  const transform = canvas.getContext('2d').transform;
  assert.deepEqual(transform, [2, 0, 0, 2, 0, 0], 'the context is pre-scaled once per frame');
  // and all drawing is therefore in logical units
  const first = canvas.getContext('2d').drawnText[0];
  assert.ok(first.x > 0 && first.x < 1280, 'logical coordinates, not device pixels');
});

test('fit keeps the document aspect ratio inside a box', () => {
  const { renderer } = setup();
  const size = renderer.fit(createDemoDocument(), { width: 640, height: 480 });
  assert.equal(size.width, 640);
  assert.equal(size.height, 360); // 16:9
  // a tall box: the 16:9 document is limited by its WIDTH, so height is the derived dimension
  const tall = renderer.fit(createDemoDocument(), { width: 300, height: 400 });
  assert.equal(tall.width, 300);
  close(tall.height, 300 / (16 / 9), 1);

  // a box thinner than the document's aspect: height becomes the limiting dimension
  const wide = renderer.fit(createDemoDocument(), { width: 1000, height: 200 });
  assert.equal(wide.height, 200);
  close(wide.width, 200 * (16 / 9), 1);
});

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

test('draw paints the active block and reports what it did', () => {
  const { doc, renderer, ctx } = setup();
  const result = renderer.draw(doc, 15.4);
  assert.equal(result.blocks, 1);
  assert.equal(result.width, 1280);
  assert.equal(ctx.drawnText.length, 2, 'only "Just" and "an" are revealed at 15.4');
  assert.deepEqual(ctx.drawnText.map((t) => t.text), ['Just', 'an']);
});

test('draw paints nothing when no block is active, but still clears', () => {
  const { doc, renderer, ctx } = setup();
  ctx.reset();
  const result = renderer.draw(doc, 5);
  assert.equal(result.blocks, 0);
  assert.equal(ctx.drawnText.length, 0);
  assert.equal(ctx.ops('clearRect').length, 1);
});

test('PARITY: text is painted with textBaseline middle at the anchor line', () => {
  const { doc, renderer, ctx } = setup();
  renderer.draw(doc, 16.5); // every word of block 1 revealed
  assert.equal(ctx.drawnText.length, 4);
  for (const t of ctx.ops('fillText')) {
    assert.equal(t.textBaseline, 'middle', 'v10 draws with a middle baseline');
    assert.equal(t.textAlign, 'left', 'v10 left-aligns and advances manually');
  }
  for (const t of ctx.drawnText) close(t.y, 0.848 * 720, 1e-6);

  // x positions: centred on 0.772 × 1280 with 0.5/0.25 em metric widths
  const eff = 0.036 * 1280;
  const space = 0.25 * eff;
  const widths = [4, 2, 8, 3].map((n) => n * 0.5 * eff);
  const total = widths.reduce((a, b) => a + b, 0) + 3 * space;
  let cursor = 0.772 * 1280 - total / 2;
  ctx.drawnText.forEach((t, i) => {
    close(t.x, cursor, 1e-6);
    cursor += widths[i] + space;
  });
});

test('THE RULE: unrevealed words keep their space, so the line never reflows', () => {
  const { doc, renderer, ctx } = setup();
  renderer.draw(doc, 16.5);
  const before = ctx.drawnText.map((t) => [t.text, t.x]);
  ctx.reset();
  renderer.draw(doc, 15.2); // only the first word revealed
  const after = ctx.drawnText.map((t) => [t.text, t.x]);
  assert.deepEqual(after.map((a) => a[0]), ['Just']);
  // the painted word sits at exactly the same place as in the fully revealed frame
  assert.equal(after[0][1], before[0][1]);
});

test('the emphasis word is drawn italic and underlined', () => {
  const { doc, renderer, ctx } = setup();
  renderer.draw(doc, 16.5);
  const just = ctx.drawnText.find((t) => t.text === 'Just');
  const an = ctx.drawnText.find((t) => t.text === 'an');
  assert.ok(/^italic /.test(just.font), 'emphasised word uses the italic face');
  assert.ok(!/italic/.test(an.font));

  const underlines = ctx.filledRects.filter((r) => r.fillStyle === '#22c55e');
  assert.equal(underlines.length, 1, 'one lime underline for the one emphasised word');
  close(underlines[0].x, just.x, 1e-6);
  close(underlines[0].y, 0.848 * 720 + 0.036 * 1280 * 0.55, 1e-6);
});

test('THE RULE: the underline outlives the word and disappears with the block', () => {
  const { doc, renderer, ctx } = setup();
  // "Just" is spoken 15.20–15.36; its underline must still be there at 16.71. The samples start a
  // hair after 15.20 because the bar is *drawn* in: at its word's own start instant it has zero
  // length, which the flow test below pins down.
  for (const t of [15.3, 15.36, 16.0, 16.71]) {
    ctx.reset();
    renderer.draw(doc, t);
    assert.equal(
      ctx.filledRects.filter((r) => r.fillStyle === '#22c55e').length,
      1,
      `underline missing at t=${t}`,
    );
  }
  // before the word, no underline
  ctx.reset();
  renderer.draw(doc, 12.0);
  assert.equal(ctx.filledRects.filter((r) => r.fillStyle === '#22c55e').length, 0);
});

test('the underline flows to the word\'s own length instead of appearing whole', () => {
  const { doc, renderer, ctx } = setup();
  const underlineWidthAt = (t) => {
    ctx.reset();
    renderer.draw(doc, t);
    const bar = ctx.filledRects.find((r) => r.fillStyle === '#22c55e');
    return bar ? bar.w : null;
  };
  // "Just" is revealed at 15.20 and its draw takes 0.4 s, so it is complete at 15.60
  assert.equal(underlineWidthAt(15.2), null, 'nothing is painted at zero progress');
  const full = underlineWidthAt(15.6);
  assert.ok(full > 0, 'a full-length bar exists once the draw has finished');
  const quarter = underlineWidthAt(15.3);
  assert.ok(quarter > 0 && quarter < full, `a partially drawn bar, got ${quarter} of ${full}`);
  // the length it grows to is the length the word asks for — not a scaled-down or padded version
  assert.equal(underlineWidthAt(16.71), full);
  const just = ctx.drawnText.find((t) => t.text === 'Just');
  ctx.reset();
  renderer.draw(doc, 16.71);
  close(ctx.filledRects.find((r) => r.fillStyle === '#22c55e').x, just.x, 1e-9);
});

test('the block shadow is applied to the text and suppressed on the underline', () => {
  const { doc, renderer, ctx } = setup();
  renderer.draw(doc, 15.5);
  const text = ctx.ops('fillText')[0];
  assert.equal(text.shadowColor, 'rgba(0,0,0,0.85)');
  assert.equal(text.shadowBlur, 10, 'blur is px at the 1280 reference');
  const underline = ctx.ops('fillRect').find((r) => r.fillStyle === '#22c55e');
  assert.equal(underline.shadowColor, 'transparent');
});

test('shadow px constants scale with the canvas width', () => {
  const doc = createDemoDocument();
  const canvas = createFakeCanvas();
  const renderer = createRenderer('canvas2d');
  renderer.attach(canvas);
  renderer.resize({ width: 2560, height: 1440, devicePixelRatio: 1 });
  const ctx = canvas.getContext('2d');
  renderer.draw(doc, 15.5);
  const text = ctx.ops('fillText')[0];
  assert.equal(text.shadowBlur, 20, '2× the reference width → 2× the blur');
});

test('display NONE draws no text at all', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, display: 'none' };
  const { renderer, ctx } = setup(doc);
  renderer.draw(doc, 15.5);
  assert.equal(ctx.drawnText.length, 0);
});

test('display BLOCK paints a backdrop before the text', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, display: 'BLOCK' };
  const { renderer, ctx } = setup(doc);
  renderer.draw(doc, 15.5);
  const ops = ctx.calls.map((c) => c.op);
  assert.ok(ops.indexOf('fill') < ops.indexOf('fillText'), 'the box is painted first');
  assert.equal(ctx.ops('fill').length, 1, 'one box for the whole block');
});

test('display LINE_BLOCK_ROUND paints one box per line', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, display: 'LINE_BLOCK_ROUND' };
  const { renderer, ctx } = setup(doc);
  renderer.draw(doc, 19.0); // inside the long block (17.68–20.90)
  const result = renderer.measure(doc.blocks[1], doc.defaults);
  assert.equal(ctx.ops('fill').length, result.lines.length);
  assert.ok(result.lines.length >= 2, 'the demo long line must wrap for this test to mean anything');
});

test('display OUTLINED strokes instead of filling', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, display: 'OUTLINED', stroke: { color: '#000000', width: 0.08 } };
  const { renderer, ctx } = setup(doc);
  renderer.draw(doc, 15.4);
  assert.equal(ctx.strokedText.length, 2);
  assert.equal(ctx.drawnText.length, 0);
});

test('display OUTLINE strokes then fills', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, display: 'OUTLINE', stroke: { color: '#000000', width: 0.08 } };
  const { renderer, ctx } = setup(doc);
  renderer.draw(doc, 15.4);
  const ops = ctx.calls.map((c) => c.op);
  assert.ok(ops.indexOf('strokeText') < ops.indexOf('fillText'));
  assert.equal(ctx.strokedText.length, 2);
});

test('emoji are off by default (the verified Veed setting)', () => {
  const { doc, renderer, ctx } = setup();
  assert.equal(doc.defaults.emoji.enabled, false);
  renderer.draw(doc, 16.5);
  assert.equal(ctx.ops('drawImage').length, 0);
  assert.equal(doc.blocks[0].words[3].emoji, '👦', 'the demo carries an emoji, it is just not drawn');
});

// ---------------------------------------------------------------------------
// guides, caching, fonts, lifecycle
// ---------------------------------------------------------------------------

test('guides add a block rectangle and safe areas without changing the text', () => {
  const { doc, renderer, ctx } = setup();
  renderer.draw(doc, 15.4);
  const plainStrokes = ctx.ops('stroke').length;
  ctx.reset();
  renderer.draw(doc, 15.4, { guides: true, safeAreas: true });
  assert.ok(ctx.ops('stroke').length > plainStrokes, 'guides draw extra rectangles');
  assert.equal(ctx.drawnText.length, 2, 'text rendering is unaffected by guides');
  assert.ok(Object.keys(SAFE_AREAS).includes('titleSafe'));
});

test('layouts are cached across frames and reused while the style is unchanged', () => {
  const { doc, renderer } = setup();
  renderer.draw(doc, 15.3);
  renderer.draw(doc, 15.5);
  renderer.draw(doc, 16.0);
  assert.equal(renderer.layoutEngine.cacheSize, 1, 'same block, same style → one layout');

  doc.defaults = { ...doc.defaults, wrapWidth: 0.5 };
  renderer.draw(doc, 16.0);
  assert.equal(renderer.layoutEngine.cacheSize, 2, 'a style change is a new layout');
});

test('resizing invalidates cached measurements', () => {
  const { doc, renderer } = setup();
  renderer.draw(doc, 15.5);
  assert.ok(renderer.layoutEngine.cacheSize > 0);
  renderer.resize({ width: 640, height: 360, devicePixelRatio: 1 });
  assert.equal(renderer.layoutEngine.cacheSize, 0);

  // and the layout really is width-relative: half the canvas → half the font size
  const layout = renderer.measure(doc.blocks[0], doc.defaults);
  close(layout.effFontSize, 0.036 * 640, 1e-9);
});

test('measure() lays out without painting anything', () => {
  const { doc, renderer, ctx } = setup();
  const layout = renderer.measure(doc.blocks[0], doc.defaults);
  assert.equal(layout.lines.length, 1);
  // measuring text is expected; painting is not
  for (const op of ['fillText', 'strokeText', 'fillRect', 'fill', 'stroke', 'clearRect', 'drawImage']) {
    assert.equal(ctx.ops(op).length, 0, `measure() must not call ${op}`);
  }
  assert.ok(ctx.ops('measureText').length > 0, 'but it does measure');
});

test('ensureFonts resolves even when nothing can load, and marks fonts ready', async () => {
  const { doc, renderer } = setup();
  assert.equal(renderer.fontsReady, false);
  const result = await renderer.ensureFonts(doc);
  assert.equal(result.ok, false, 'Node has no Font Loading API');
  assert.equal(renderer.fontsReady, true);
  assert.equal(result.results.length, 2);
});

test('clear() wipes the whole backing store and dispose() is idempotent', () => {
  const { renderer, canvas, ctx } = setup();
  renderer.resize({ width: 1280, height: 720, devicePixelRatio: 2 });
  ctx.reset();
  renderer.clear();
  const clears = ctx.ops('clearRect');
  assert.equal(clears.length, 1);
  assert.deepEqual(clears[0].args, [0, 0, 2560, 1440], 'clears device pixels, transform reset');

  renderer.dispose();
  renderer.dispose();
  assert.equal(renderer.context, null);
  assert.equal(canvas.getContext('2d').depth, 0);
});

test('save/restore stay balanced across a complex frame', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, display: 'LINE_BLOCK_ROUND', emphasis: { ...doc.defaults.emphasis }, animation: { in: 'slideUp', inDur: 0.2 } };
  const { renderer, ctx } = setup(doc);
  renderer.draw(doc, 17.9, { guides: true, safeAreas: true });
  assert.equal(ctx.depth, 0, `unbalanced save/restore (max depth ${ctx.maxDepth})`);
});

test('animations compose onto the reveal without breaking it', () => {
  const doc = createDemoDocument();
  doc.defaults = { ...doc.defaults, animation: { in: 'fade', inDur: 0.2 } };
  const { renderer, ctx } = setup(doc);
  // block 2 starts at 17.68; at 17.68 the block animation has not progressed, but the reveal rule
  // is per word, so "Head" (start 17.68) is revealed and faded to opacity 0
  renderer.draw(doc, doc.blocks[1].words[0].start);
  const head = ctx.drawnText.find((t) => t.text === 'Head');
  assert.ok(head, 'the reveal still paints the word');
  assert.equal(head.globalAlpha, 0, 'the fade drove its opacity to 0');
  ctx.reset();
  renderer.draw(doc, doc.blocks[1].words[0].start + 0.2);
  close(ctx.drawnText.find((t) => t.text === 'Head').globalAlpha, 1, 1e-9);

  // once well past the animation window the opacity is exactly 1
  ctx.reset();
  renderer.draw(doc, doc.blocks[1].words[0].start + 0.5);
  assert.equal(ctx.drawnText.find((t) => t.text === 'Head').globalAlpha, 1);
});

test('the default style is unchanged by a render (draw is read-only)', () => {
  const doc = createDemoDocument();
  const before = JSON.stringify(doc);
  const { renderer } = setup(doc);
  renderer.draw(doc, 15.5);
  renderer.draw(doc, 19.0);
  assert.equal(JSON.stringify(doc), before, 'drawing must not mutate the document');
});

test('rendering the same frame twice produces identical draw calls', () => {
  const { doc, renderer, ctx } = setup();
  renderer.draw(doc, 19.2);
  const first = JSON.stringify(ctx.ops('fillText').map((c) => [c.args, c.font, c.fillStyle]));
  ctx.reset();
  renderer.draw(doc, 19.2);
  const second = JSON.stringify(ctx.ops('fillText').map((c) => [c.args, c.font, c.fillStyle]));
  assert.equal(second, first, 'the renderer must be deterministic frame-to-frame');
});

test('the default style really is the Veed parity template', () => {
  const s = createDefaultStyle();
  assert.equal(s.font.family, 'Inter');
  assert.equal(s.font.weight, 900);
  assert.equal(s.font.size, 0.036);
  assert.equal(s.font.sizeUnit, 'w');
  assert.equal(s.fill.color, '#ffffff');
  assert.equal(s.fill.opacity, 1, 'text is always fully opaque — nothing is dimmed');
  assert.deepEqual(
    [s.anchor.posX, s.anchor.posY],
    [0.772, 0.848],
  );
  assert.equal(s.emphasis.decoration, 'underline');
  assert.equal(s.emphasis.decorationColor, '#22c55e');
  assert.equal(s.emphasis.italic, true);
  assert.equal(s.shadow.onDecoration, false);
  assert.equal(s.emoji.enabled, false);
});
