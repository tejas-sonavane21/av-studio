/**
 * render-parity.test.js — the parity lock.
 *
 * Phase 2's exit criterion is "visually matches the v10 output **and** wraps". "Visually matches"
 * is not testable from prose, so this file pins it two ways:
 *
 * 1. **The locked spec constants** — font, colour, anchor, underline geometry, shadow, emoji-off.
 *    These came from frame-by-frame analysis of the real Veed video and must not drift.
 * 2. **A literal transcription of v10's render loop** (`referece_material/version10/index.html`,
 *    lines ~397–470) run against the same deterministic metric, compared fragment-by-fragment with
 *    what our renderer actually paints. If our layout drifts from v10's, this fails with the two
 *    positions side by side.
 *
 * The one *intentional* difference is the font-size rule, which is asserted separately and
 * explicitly: v10 multiplied by canvas **height**, Veed's real `getTextProps()` multiplies by
 * **width**. v10 therefore rendered captions at ~56 % of Veed's size — the unresolved "the font
 * doesn't match" defect of the old project.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDemoDocument } from '../../src/model/demo.js';
import { createDefaultStyle } from '../../src/model/schema.js';
import { fontSizePx } from '../../src/render/layout.js';
import { createRenderer } from '../../src/render/renderer.js';
import { UNDERLINE, pxScaleFor } from '../../src/render/decorations.js';
import { fakeMeasure, createFakeCanvas } from '../helpers/fake-canvas.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (±${eps})`);

/**
 * v10's render loop, transcribed. `reference/version10/index.html`:
 *
 *   const fontSize = c.height * (style.fontSize || 0.036);
 *   const sp = ctx.measureText(' ').width;
 *   let w = 0; block.words.forEach(word => { ctx.font = word.isHighlighted ? it : nf;
 *                                            w += ctx.measureText(word.text).width + sp; });
 *   const totalW = w - sp;
 *   const anchorX = c.width * posX, anchorY = c.height * posY;
 *   let startX = anchorX - totalW / 2;
 *   block.words.forEach(word => { … ctx.fillText(word.text, startX, anchorY);
 *                                 startX += wWidth + spaceW; });
 *
 * The size rule is parameterised so the same function can express both v10's rule (`'h'`) and the
 * corrected Veed rule (`'w'`) — only the layout algorithm is being compared here.
 */
function v10Layout(block, style, canvas, measure, sizeUnit = 'w') {
  const fontSize = fontSizePx({ ...style.font, sizeUnit }, canvas);
  const normalCss = `900 ${fontSize}px Inter`;
  const italicCss = `italic 900 ${fontSize}px Inter`;
  const spaceW = measure(' ', normalCss);

  let acc = 0;
  for (const w of block.words) acc += measure(w.text, w.emphasis ? italicCss : normalCss) + spaceW;
  const totalW = acc - spaceW;

  const anchorX = canvas.width * style.anchor.posX;
  const anchorY = canvas.height * style.anchor.posY;
  const items = [];
  let startX = anchorX - totalW / 2;
  for (const w of block.words) {
    const css = w.emphasis ? italicCss : normalCss;
    const width = measure(w.text, css);
    items.push({
      text: w.text,
      x: startX,
      y: anchorY,
      width,
      upright: !w.emphasis,
      underline: w.emphasis
        ? {
            x: startX,
            y: anchorY + fontSize * UNDERLINE.offsetEm,
            w: width,
            h: Math.max(UNDERLINE.thicknessMin, fontSize * UNDERLINE.thicknessEm),
          }
        : null,
    });
    startX += width + spaceW;
  }
  return { fontSize, totalW, anchorX, anchorY, items };
}

function render(time = 16.5) {
  const doc = createDemoDocument();
  const canvas = createFakeCanvas();
  const renderer = createRenderer('canvas2d');
  renderer.attach(canvas);
  renderer.resize({ width: doc.canvas.width, height: doc.canvas.height, devicePixelRatio: 1 });
  renderer.draw(doc, time);
  return { doc, canvas, renderer, ctx: canvas.getContext('2d') };
}

// ---------------------------------------------------------------------------
// the locked spec
// ---------------------------------------------------------------------------

test('the locked Veed spec constants are exactly as analysed', () => {
  const s = createDefaultStyle();
  assert.equal(s.font.family, 'Inter');
  assert.equal(s.font.weight, 900);
  assert.equal(s.font.size, 0.036);
  assert.equal(s.font.sizeUnit, 'w', 'Veed scales font size by canvas WIDTH');
  assert.equal(s.font.italic, false);
  assert.equal(s.fill.color, '#ffffff');
  assert.equal(s.fill.opacity, 1);
  assert.deepEqual([s.anchor.posX, s.anchor.posY], [0.772, 0.848]);
  assert.equal(s.anchor.gravity, 'center');
  assert.equal(s.display, 'NORMAL');
  assert.equal(s.emphasis.decoration, 'underline');
  assert.equal(s.emphasis.decorationColor, '#22c55e');
  assert.equal(s.emphasis.italic, true);
  assert.equal(s.shadow.color, 'rgba(0,0,0,0.85)');
  assert.equal(s.shadow.blur, 10);
  assert.equal(s.shadow.offsetX, 3);
  assert.equal(s.shadow.offsetY, 3);
  assert.equal(s.shadow.onDecoration, false);
  assert.equal(s.emoji.enabled, false, 'emojis are not rendered');
  assert.equal(s.stroke.width, 0, 'no outline');
});

test('THE CORRECTION: the parity font size is width-relative, 1.78× v10’s rule', () => {
  const canvas = { width: 1280, height: 720 };
  const font = createDefaultStyle().font;

  // Veed's real rule (verified in the minified bundle: `fontSize … * pretendedCanvasSize.width`)
  close(fontSizePx(font, canvas), 46.08);
  // v10's rule — same number as before, but against a height
  close(fontSizePx({ ...font, sizeUnit: 'h' }, canvas), 0.036 * 720);
  close(fontSizePx({ ...font, sizeUnit: 'h' }, canvas), 25.92);
  // …which is what made v10's captions ~56 % of Veed's size
  close(46.08 / 25.92, 1.7777, 1e-3);

  // and the same correction applies to wrapWidth (Veed scales it by width too)
  assert.equal(createDefaultStyle().wrapWidth, 0.9);
});

test('v10’s overflow cap and our wrap width agree, so no line was "unwrapped"', () => {
  // v10: const maxW = c.width * 0.9;  → our wrapLimit at wrapWidth 0.9
  const width = 1280;
  assert.equal(createDefaultStyle().wrapWidth * width, width * 0.9);
});

// ---------------------------------------------------------------------------
// transcription comparison
// ---------------------------------------------------------------------------

test('PARITY: every painted position matches v10’s algorithm exactly', () => {
  const { doc, renderer, ctx } = render();
  const block = doc.blocks[0];
  const expected = v10Layout(block, doc.defaults, doc.canvas, fakeMeasure);
  const painted = ctx.drawnText;

  assert.equal(painted.length, block.words.length);
  expected.items.forEach((item, i) => {
    assert.equal(painted[i].text, item.text);
    close(painted[i].x, item.x, 1e-9);
    close(painted[i].y, item.y, 1e-9);
  });

  // and the painted widths agree with the transcription's own arithmetic
  const layout = renderer.measure(block, doc.defaults);
  close(layout.width, expected.totalW, 1e-9);
  close(layout.lines[0].x, expected.anchorX - expected.totalW / 2, 1e-9);
  close(layout.lines[0].y, expected.anchorY, 1e-9);
});

test('PARITY: the underline is byte-for-byte v10’s rectangle', () => {
  const { doc, ctx } = render();
  const expected = v10Layout(doc.blocks[0], doc.defaults, doc.canvas, fakeMeasure);
  const wanted = expected.items.find((i) => i.underline).underline;

  const painted = ctx.ops('fillRect').filter((c) => c.fillStyle === '#22c55e');
  assert.equal(painted.length, 1);
  close(painted[0].args[0], wanted.x, 1e-9);
  close(painted[0].args[1], wanted.y, 1e-9);
  close(painted[0].args[2], wanted.w, 1e-9);
  close(painted[0].args[3], wanted.h, 1e-9);
  // sanity-check against the literal spec numbers at the reference size
  close(wanted.y, 0.848 * 720 + 46.08 * 0.55, 1e-6);
  close(wanted.h, Math.max(4, 46.08 * 0.12), 1e-6);
});

test('PARITY: emphasised words are italic, others are not (v10 switches the face)', () => {
  const { doc, ctx } = render();
  const expected = v10Layout(doc.blocks[0], doc.defaults, doc.canvas, fakeMeasure);
  ctx.ops('fillText').forEach((call, i) => {
    const wantsItalic = !expected.items[i].upright;
    assert.equal(/^italic /.test(call.font), wantsItalic, `${expected.items[i].text} italic=${wantsItalic}`);
  });
});

test('PARITY: the frame is completely static — no transforms, no dimming', () => {
  // v10 animated nothing: text was drawn at a fixed anchor with the shadow on, fully opaque.
  const { ctx } = render();
  assert.equal(ctx.ops('translate').length, 0, 'the default template must not move text');
  assert.equal(ctx.ops('scale').length, 0, 'the default template must not scale text');
  for (const call of ctx.ops('fillText')) {
    assert.equal(call.globalAlpha, 1, 'inactive words are never dimmed');
    assert.equal(call.fillStyle, '#ffffff');
    assert.equal(call.shadowColor, 'rgba(0,0,0,0.85)');
  }
});

test('PARITY: unrevealed words advance the cursor but are not painted', () => {
  // paint the frame just before the last word starts, then at the end; positions must be identical
  const doc = createDemoDocument();
  const block = doc.blocks[0];
  const expected = v10Layout(block, doc.defaults, doc.canvas, fakeMeasure);

  const canvas = createFakeCanvas();
  const renderer = createRenderer('canvas2d');
  renderer.attach(canvas);
  renderer.resize({ width: 1280, height: 720, devicePixelRatio: 1 });
  const ctx = canvas.getContext('2d');

  renderer.draw(doc, block.words[3].start - 0.01); // 3 of 4 words revealed
  const early = ctx.drawnText;
  assert.deepEqual(early.map((t) => t.text), expected.items.slice(0, 3).map((i) => i.text));
  early.forEach((t, i) => close(t.x, expected.items[i].x, 1e-9));

  ctx.reset();
  renderer.draw(doc, block.words[3].start + 0.01); // all 4 revealed
  ctx.drawnText.forEach((t, i) => close(t.x, expected.items[i].x, 1e-9));
});

test('PARITY: the shadow scales with the canvas, so the look is size-independent', () => {
  const doc = createDemoDocument();
  const canvas = createFakeCanvas();
  const renderer = createRenderer('canvas2d');
  renderer.attach(canvas);
  renderer.resize({ width: 640, height: 360, devicePixelRatio: 1 });
  renderer.draw(doc, 15.4);
  const call = canvas.getContext('2d').ops('fillText')[0];
  close(call.shadowBlur, 10 * pxScaleFor(640), 1e-9);
  close(call.shadowOffsetX, 3 * pxScaleFor(640), 1e-9);
  // and the font really is width-relative at the smaller size
  close(renderer.measure(doc.blocks[0], doc.defaults).effFontSize, 0.036 * 640, 1e-9);
});

// ---------------------------------------------------------------------------
// and the capability v10 did not have
// ---------------------------------------------------------------------------

test('THE IMPROVEMENT: long captions wrap instead of being squeezed', () => {
  const { doc, renderer } = render(19.0);
  const layout = renderer.measure(doc.blocks[1], doc.defaults);

  assert.ok(layout.lines.length >= 2, 'the long demo line wraps');
  assert.equal(layout.scale, 1, 'no font shrinking was needed');

  // every line stays inside the wrap width …
  assert.equal(layout.wrapLimit, 0.9 * 1280);
  for (const line of layout.lines) {
    assert.ok(line.width <= layout.wrapLimit + 1e-6, `line ${line.index} fits the wrap width`);
  }
  // … the lines are vertically distributed around the anchor …
  close(layout.lines[0].y, 0.848 * 720 - layout.lineAdvance / 2, 1e-9);
  close(layout.lines[1].y, 0.848 * 720 + layout.lineAdvance / 2, 1e-9);
  // … and no word was lost in the process
  const words = layout.lines.flatMap((l) => l.fragments).map((f) => f.wordIndex);
  assert.equal(words.length, doc.blocks[1].words.length);
});

test('v10 would have squeezed that same line into one shrunken line', () => {
  // Demonstrates the difference is real rather than theoretical: v10's fallback divided the whole
  // line down to fit 90 % of the width in a single row.
  const { doc, renderer } = render(19.0);
  const block = doc.blocks[1];
  const oneLineWidth = v10Layout(block, doc.defaults, doc.canvas, fakeMeasure).totalW;
  const maxW = doc.canvas.width * 0.9;
  assert.ok(oneLineWidth > maxW, 'the line really is too wide for one row');
  assert.ok(oneLineWidth / maxW > 1.05, 'and not merely by a rounding error');

  // our renderer, by contrast, keeps the font at full size and uses two lines
  const layout = renderer.measure(block, doc.defaults);
  assert.equal(layout.effFontSize, fontSizePx(doc.defaults.font, doc.canvas));
  assert.ok(layout.lines.length >= 2);
});
