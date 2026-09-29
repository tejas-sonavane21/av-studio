/**
 * layout.test.js — the pure layout engine.
 *
 * All expected geometry is computed by hand from the documented test metric
 * (0.5 × fontSize per character, 0.25 × fontSize per space — see tests/helpers/fake-canvas.js),
 * so these assertions pin the *numbers*, not the implementation's own arithmetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBlock, createDefaultStyle, createWord } from '../../src/model/schema.js';
import { rebuildBlockText } from '../../src/model/document.js';
import { mergeDeep } from '../../src/util/math.js';
import {
  applyCase,
  createLayoutEngine,
  createMeasurer,
  fontSizePx,
  layoutBlock,
  letterSpacingPx,
  normalizeGravity,
  textWidth,
} from '../../src/render/layout.js';
import { fakeMeasure } from '../helpers/fake-canvas.js';

const CANVAS = { width: 1280, height: 720 };

/** Effective font size for the default style: 0.036 × width (Veed parity) = 46.08. */
const EFF = fontSizePx(createDefaultStyle().font, CANVAS);
/** Measured space at that size: 0.25 × 46.08 = 11.52. */
const SPACE = 0.25 * EFF;

const close = (actual, expected, eps = 1e-6, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    msg ?? `expected ${actual} ≈ ${expected} (±${eps})`,
  );

const style = (patch = {}) => mergeDeep(createDefaultStyle(), patch);

function makeBlock(pairs, start = 0, end = 10) {
  const block = createBlock(
    start,
    end,
    pairs.map(([text, s, e]) => createWord(text, s, e)),
  );
  return rebuildBlockText(block);
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test('font size uses canvas WIDTH for Veed parity and HEIGHT only when asked', () => {
  const font = createDefaultStyle().font;
  assert.equal(font.sizeUnit, 'w', 'the parity template must be width-relative');
  close(fontSizePx(font, CANVAS), 46.08, 1e-9);
  // the v10 replica's rule: 0.036 × 690 (the extracted canvas height) = 24.84
  close(fontSizePx({ ...font, sizeUnit: 'h' }, { width: 1280, height: 690 }), 24.84, 1e-9);
});

test('letter spacing is em-relative', () => {
  close(letterSpacingPx({ letterSpacing: 0.1 }, 40), 4);
  close(letterSpacingPx({}, 40), 0);
});

test('textWidth adds the inter-letter gaps only', () => {
  const measure = (t, css) => fakeMeasure(t, css);
  close(textWidth(measure, 'abc', '900 10px X', 2), 15 + 4, 1e-9); // 15 + 2×2
  close(textWidth(measure, 'a', '900 10px X', 2), 5, 1e-9); // one char, no gaps
});

test('applyCase handles every mode and rejects length-changing mappings', () => {
  assert.equal(applyCase('just an ordinary boy', 'title'), 'Just An Ordinary Boy');
  assert.equal(applyCase('Just an ordinary boy', 'upper'), 'JUST AN ORDINARY BOY');
  assert.equal(applyCase('JUST AN ORDINARY BOY', 'lower'), 'just an ordinary boy');
  assert.equal(applyCase('just an ordinary boy', 'sentence'), 'Just an ordinary boy');
  assert.equal(applyCase('just an ordinary boy', 'none'), 'just an ordinary boy');
  assert.equal(applyCase('just an ordinary boy', 'nonsense'), 'just an ordinary boy');
  // 'ß'.toUpperCase() is 'SS' — a length change would desynchronise word char-offsets
  assert.equal(applyCase('straße', 'upper'), 'straße');
});

test('normalizeGravity parses single tokens and pairs', () => {
  assert.deepEqual(normalizeGravity('center'), { x: 'center', y: 'center' });
  assert.deepEqual(normalizeGravity('bottom-right'), { x: 'right', y: 'bottom' });
  assert.deepEqual(normalizeGravity('top'), { x: 'center', y: 'top' });
  assert.deepEqual(normalizeGravity('left'), { x: 'left', y: 'center' });
  assert.deepEqual(normalizeGravity(undefined), { x: 'center', y: 'center' });
});

// ---------------------------------------------------------------------------
// parity geometry (single line, no wrap) — must equal v10's math
// ---------------------------------------------------------------------------

test('single line reproduces v10 geometry exactly', () => {
  const block = makeBlock([
    ['Just', 0, 0.16],
    ['an', 0.16, 0.28],
    ['ordinary', 0.28, 0.9],
    ['boy', 0.9, 1.5],
  ]);
  const layout = layoutBlock({
    block,
    style: style(),
    canvasWidth: CANVAS.width,
    canvasHeight: CANVAS.height,
    measureText: fakeMeasure,
  });

  // widths: 4, 2, 8, 3 chars → 2.0, 1.0, 4.0, 1.5 em
  const totalW = (2.0 + 1.0 + 4.0 + 1.5) * EFF + 3 * SPACE; // 426.24
  close(totalW, 426.24, 1e-6);
  assert.equal(layout.lines.length, 1);
  close(layout.width, totalW, 1e-9);
  close(layout.spaceW, SPACE, 1e-9);
  close(layout.effFontSize, EFF, 1e-9);
  assert.equal(layout.scale, 1);

  // anchor 0.772 × 1280 = 988.16, 0.848 × 720 = 610.56
  close(layout.anchorX, 988.16, 1e-9);
  close(layout.anchorY, 610.56, 1e-9);
  // single line, gravity centre, align centre → line.x = anchorX − width/2, line.y = anchorY
  close(layout.lines[0].x, 988.16 - totalW / 2, 1e-9);
  close(layout.lines[0].y, 610.56, 1e-9);

  // fragments accumulate: x, x + w + space, …
  const frags = layout.lines[0].fragments;
  assert.deepEqual(frags.map((f) => f.wordIndex), [0, 1, 2, 3]);
  let cursor = layout.lines[0].x;
  for (const f of frags) {
    close(f.x, cursor, 1e-9);
    cursor += f.width + SPACE;
  }
  // every fragment's vertical middle is the line's middle
  for (const f of frags) close(f.y, 610.56, 1e-9);
});

test('every unrevealed word still occupies its measured space', () => {
  // This is the "layout never reflows" rule from v10: the layout must not depend on time at all.
  const block = makeBlock([
    ['One', 0, 1],
    ['two', 1, 2],
    ['three', 2, 3],
  ]);
  const args = { block, style: style(), canvasWidth: 1280, canvasHeight: 720, measureText: fakeMeasure };
  const a = layoutBlock(args);
  const b = layoutBlock({ ...args, block: { ...block } });
  assert.deepEqual(
    b.lines[0].fragments.map((f) => f.x),
    a.lines[0].fragments.map((f) => f.x),
  );
});

// ---------------------------------------------------------------------------
// wrapping — the capability v10 did not have
// ---------------------------------------------------------------------------

test('wraps greedily to the wrap width and centres each line', () => {
  // 4 words of 10 chars each = 5 em wide apiece; wrapWidth 0.5 → 640 px limit = 13.9 em
  const block = makeBlock([
    ['aaaaaaaaaa', 0, 1],
    ['bbbbbbbbbb', 1, 2],
    ['cccccccccc', 2, 3],
    ['dddddddddd', 3, 4],
  ]);
  const layout = layoutBlock({
    block,
    style: style({ wrapWidth: 0.5 }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  close(layout.wrapLimit, 640, 1e-9);
  assert.equal(layout.lines.length, 2);
  // two 10-char words = 460.8 + 11.52 = 472.32 — a third would need 708.48 > 640
  const lineW = 2 * (10 * 0.5 * EFF) + SPACE;
  close(layout.lines[0].width, lineW, 1e-9);
  assert.deepEqual(layout.lines[0].fragments.map((f) => f.wordIndex), [0, 1]);
  assert.deepEqual(layout.lines[1].fragments.map((f) => f.wordIndex), [2, 3]);
  // line advance = fontSize × lineHeight, lines centred vertically on the anchor
  close(layout.lineAdvance, EFF * 1.15, 1e-9);
  close(layout.height, 2 * EFF * 1.15, 1e-9);
  close(layout.y, 610.56 - (2 * EFF * 1.15) / 2, 1e-9);
  close(layout.lines[1].y, 610.56 + (EFF * 1.15) / 2, 1e-9);
  // centred horizontally: the shorter line sits centred inside the box
  close(layout.lines[0].x, layout.lines[1].x, 1e-9);
});

test('wrapWidth 0 disables wrapping entirely', () => {
  const block = makeBlock([
    ['aaaaaaaaaaaaaaaaaaaa', 0, 1],
    ['bbbbbbbbbbbbbbbbbbbb', 1, 2],
  ]);
  const layout = layoutBlock({
    block,
    style: style({ wrapWidth: 0 }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  assert.equal(layout.lines.length, 1);
  assert.equal(layout.wrapLimit, Infinity);
});

test('a word wider than the wrap width is hard-broken, keeping one wordIndex', () => {
  // 'ordinary' = 4 em = 184.32 px; hug it with wrapWidth 0.05 → 64 px limit
  const block = makeBlock([['ordinary', 0, 1]]);
  const layout = layoutBlock({
    block,
    style: style({ wrapWidth: 0.05 }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  close(layout.wrapLimit, 64, 1e-9);
  const frags = layout.lines.flatMap((l) => l.fragments);
  assert.ok(frags.length > 1, 'expected the word to be split across lines');
  assert.ok(frags.every((f) => f.wordIndex === 0), 'all pieces keep the source word index');
  assert.equal(frags.map((f) => f.text).join(''), 'ordinary');
  assert.ok(frags.every((f) => f.width <= layout.wrapLimit + 1e-9));
  assert.ok(layout.warnings.some((w) => /hard-broken/.test(w)));
});

test('shrink-to-fit retries, then keeps every line and warns rather than dropping words', () => {
  // eight long words cannot fit on one line even after three 5 % reductions
  const block = makeBlock(
    Array.from({ length: 8 }, (_, i) => [`word${i}abcdef`, i, i + 1]),
  );
  const layout = layoutBlock({
    block,
    style: style({ wrapWidth: 0.5, maxLines: 1 }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
    maxAttempts: 3,
  });
  // 3 attempts → ×0.95³
  close(layout.effFontSize, EFF * 0.95 ** 3, 1e-9);
  assert.ok(layout.effFontSize < EFF, 'font must have been reduced');
  assert.ok(layout.lines.length > 1, 'all lines are kept');
  assert.equal(layout.lines.flatMap((l) => l.fragments).length, 8, 'no word was dropped');
  assert.ok(layout.warnings.some((w) => /maxLines/.test(w)));
});

test('shrink-to-fit succeeds when a reduction is enough', () => {
  // 3 words of 10 chars: 714.24 px at full size (2 lines), 612.4 px after ×0.95³ (1 line)
  const block = makeBlock([
    ['aaaaaaaaaa', 0, 1],
    ['bbbbbbbbbb', 1, 2],
    ['cccccccccc', 2, 3],
  ]);
  const layout = layoutBlock({
    block,
    style: style({ wrapWidth: 0.5, maxLines: 1 }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
    maxAttempts: 3,
  });
  assert.equal(layout.lines.length, 1);
  assert.equal(layout.warnings.length, 0);
  assert.ok(layout.scale < 1);
});

test('a block that fits is never shrunk', () => {
  const block = makeBlock([['short', 0, 1]]);
  const layout = layoutBlock({
    block,
    style: style({ maxLines: 3 }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  assert.equal(layout.scale, 1);
  assert.equal(layout.warnings.length, 0);
});

// ---------------------------------------------------------------------------
// gravity / alignment
// ---------------------------------------------------------------------------

test('gravity and align position the box, not just the text', () => {
  const block = makeBlock([
    ['aaaaaaaaaa', 0, 1],
    ['bbbbbbbbbb', 1, 2],
  ]);
  const build = (patch) =>
    layoutBlock({
      block,
      style: style(patch),
      canvasWidth: 1280,
      canvasHeight: 720,
      measureText: fakeMeasure,
    });

  const centred = build({ wrapWidth: 0.5, anchor: { gravity: 'center' } });
  close(centred.x, 988.16 - centred.width / 2, 1e-9);

  const topLeft = build({ wrapWidth: 0.5, align: 'left', anchor: { gravity: 'top-left' } });
  close(topLeft.x, 988.16, 1e-9);
  close(topLeft.y, 610.56, 1e-9);
  close(topLeft.lines[0].x, 988.16, 1e-9);

  const bottomRight = build({ wrapWidth: 0.5, align: 'right', anchor: { gravity: 'bottom-right' } });
  close(bottomRight.x + bottomRight.width, 988.16, 1e-9);
  close(bottomRight.y + bottomHeight(bottomRight), 610.56, 1e-9);
  close(bottomRight.lines[0].x + bottomRight.lines[0].width, 988.16, 1e-9);
});

function bottomHeight(layout) {
  return layout.lines.length * layout.lineAdvance;
}

test('emphasis makes a word italic in the layout font', () => {
  const block = makeBlock([
    ['plain', 0, 1],
    ['marked', 1, 2],
  ]);
  block.words[1].emphasis = true;
  const layout = layoutBlock({
    block,
    style: style(),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  assert.ok(!/italic/.test(layout.lines[0].fragments[0].css));
  assert.ok(/^italic /.test(layout.lines[0].fragments[1].css));
  assert.equal(layout.lines[0].fragments[1].italic, true);
});

test('emphasis italic can be turned off by the template', () => {
  const block = makeBlock([['marked', 0, 1]]);
  block.words[0].emphasis = true;
  const layout = layoutBlock({
    block,
    style: style({ emphasis: { italic: false } }),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  assert.ok(!/italic/.test(layout.lines[0].fragments[0].css));
});

// ---------------------------------------------------------------------------
// measuring + caching
// ---------------------------------------------------------------------------

test('the measure cache is keyed by (css font, text) and reports its size', () => {
  let calls = 0;
  const measurer = createMeasurer((text, css) => {
    calls++;
    return fakeMeasure(text, css);
  });
  const first = measurer.width('hello', '900 10px X');
  const second = measurer.width('hello', '900 10px X');
  const other = measurer.width('hello', '900 20px X'); // different size → different width
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(calls, 2, 'the second identical lookup must hit the cache');
  assert.equal(measurer.size, 2);
  measurer.clear();
  assert.equal(measurer.size, 0);
});

test('the layout engine caches by signature and invalidates', () => {
  const engine = createLayoutEngine({ measureText: fakeMeasure });
  const block = makeBlock([
    ['Just', 0, 0.16],
    ['boy', 0.16, 1],
  ]);
  const s = style();

  const a = engine.layout(block, s, CANVAS);
  const b = engine.layout(block, s, CANVAS);
  assert.equal(a, b, 'identical inputs must return the identical object');
  assert.equal(engine.cacheSize, 1);

  // a style change is a different signature
  engine.layout(block, style({ wrapWidth: 0.4 }), CANVAS);
  assert.equal(engine.cacheSize, 2);

  // emphasis changes the layout, so it must be part of the signature
  block.words[1].emphasis = true;
  engine.layout(block, s, CANVAS);
  assert.equal(engine.cacheSize, 3, 'emphasis flags must invalidate the layout cache');

  engine.invalidate();
  assert.equal(engine.cacheSize, 0);
  assert.equal(engine.measure.size, 0);
});

test('the layout engine returns the cached object when nothing changed', () => {
  const engine = createLayoutEngine({ measureText: fakeMeasure });
  const block = makeBlock([['Hello', 0, 1]]);
  const canvasA = { width: 1280, height: 720 };
  assert.equal(engine.layout(block, style(), canvasA), engine.layout(block, style(), canvasA));
  assert.notEqual(
    engine.layout(block, style(), canvasA),
    engine.layout(block, style(), { width: 1920, height: 1080 }),
    'a different canvas size must not reuse the layout',
  );
});

test('handles an empty block without throwing', () => {
  const block = makeBlock([]);
  const layout = layoutBlock({
    block,
    style: style(),
    canvasWidth: 1280,
    canvasHeight: 720,
    measureText: fakeMeasure,
  });
  assert.deepEqual(layout.lines, []);
  assert.equal(layout.width, 0);
  assert.equal(layout.height, 0);
});

test('width-relative sizing scales the whole layout linearly', () => {
  const block = makeBlock([
    ['Just', 0, 1],
    ['boy', 1, 2],
  ]);
  const small = layoutBlock({
    block, style: style(), canvasWidth: 640, canvasHeight: 360, measureText: fakeMeasure,
  });
  const large = layoutBlock({
    block, style: style(), canvasWidth: 1280, canvasHeight: 720, measureText: fakeMeasure,
  });
  close(large.effFontSize, small.effFontSize * 2, 1e-9);
  close(large.width, small.width * 2, 1e-9);
});
