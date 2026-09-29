/**
 * decorations.test.js — the emphasis geometry.
 *
 * The underline numbers are the *verified* ones (v10, which matched the frame-by-frame analysis of
 * the real video), so they are asserted literally rather than recomputed from the constants:
 * a change to `UNDERLINE` must fail this test, not quietly redefine the look.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BOX,
  REFERENCE_WIDTH,
  UNDERLINE,
  blockBoxRect,
  drawEmphasisHighlights,
  drawEmphasisUnderlines,
  fillDecoration,
  highlightRect,
  lineBoxRect,
  pxScaleFor,
  roundRectPath,
  underlineRect,
} from '../../src/render/decorations.js';
import { FakeContext } from '../helpers/fake-canvas.js';

const EFF = 46.08; // 0.036 × 1280 — the parity font size
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/** A minimal layout stand-in: one line, three fragments, the middle one emphasised. */
function fakeLayout() {
  return {
    effFontSize: EFF,
    lineHeight: 1.15,
    lineAdvance: EFF * 1.15,
    x: 700,
    y: 500,
    width: 400,
    height: EFF * 1.15,
    lines: [
      {
        index: 0,
        x: 775.04,
        y: 610.56,
        width: 426.24,
        fragments: [
          { wordIndex: 0, text: 'Just', x: 775.04, y: 610.56, width: 92.16, css: '900 46.08px Inter' },
          { wordIndex: 1, text: 'an', x: 878.72, y: 610.56, width: 46.08, css: '900 46.08px Inter' },
          { wordIndex: 2, text: 'ordinary', x: 936.32, y: 610.56, width: 184.32, css: '900 46.08px Inter' },
        ],
      },
    ],
  };
}

const states = (emphasis) => emphasis.map((e) => ({ revealed: true, emphasis: e }));

// ---------------------------------------------------------------------------
// the verified underline
// ---------------------------------------------------------------------------

test('pxScale is canvasWidth / 1280', () => {
  assert.equal(pxScaleFor(REFERENCE_WIDTH), 1);
  assert.equal(pxScaleFor(2560), 2);
  assert.equal(pxScaleFor(640), 0.5);
  assert.equal(pxScaleFor(0), 1, 'never produce a zero/NaN scale');
});

test('underline thickness = max(4 × pxScale, effFontSize × 0.12)', () => {
  assert.equal(UNDERLINE.thicknessMin, 4);
  assert.equal(UNDERLINE.thicknessEm, 0.12);
  assert.equal(UNDERLINE.offsetEm, 0.55);

  const frag = { x: 100, y: 200, width: 50 };
  const big = underlineRect(frag, EFF, 1);
  close(big.h, EFF * 0.12); // 5.5296 > 4
  close(big.y, 200 + EFF * 0.55); // 200 + 25.344
  assert.equal(big.x, 100);
  assert.equal(big.w, 50, 'no horizontal padding — the bar spans exactly the word');

  // the 4 px floor kicks in for small text
  close(underlineRect(frag, 10, 1).h, 4);
  // …and scales with the canvas, so it is proportionally identical at other sizes
  close(underlineRect(frag, 10, 2).h, 8);
});

test('underline sits below the line middle by 0.55 em', () => {
  const frag = { x: 0, y: 610.56, width: 10 };
  close(underlineRect(frag, EFF, 1).y, 610.56 + 46.08 * 0.55);
  close(underlineRect(frag, EFF, 1).y, 635.904, 1e-6);
});

test('drawEmphasisUnderlines paints only emphasised words, above the text, without shadow', () => {
  const ctx = new FakeContext({});
  const layout = fakeLayout();
  drawEmphasisUnderlines(ctx, layout, states([false, true, false]), {
    emphasis: { decorationColor: '#22c55e' },
  });

  const rects = ctx.ops('fillRect').map((c) => ({ args: c.args, fillStyle: c.fillStyle, shadowColor: c.shadowColor }));
  assert.equal(rects.length, 1, 'exactly one underline for one emphasised word');
  const [r] = rects;
  assert.equal(r.fillStyle, '#22c55e');
  close(r.args[0], 878.72, 1e-6);
  close(r.args[1], 610.56 + EFF * 0.55, 1e-6);
  close(r.args[2], 46.08, 1e-6);
  // the v10 rule: the shadow is suppressed on the decoration by making its colour transparent
  assert.equal(r.shadowColor, 'transparent');
  assert.equal(ctx.depth, 0, 'save/restore must balance');
});

test('an underlined word broken across lines gets a bar per piece', () => {
  const ctx = new FakeContext({});
  const layout = fakeLayout();
  // the middle word was hard-broken into two fragments on different lines
  layout.lines[0].fragments = [
    { wordIndex: 1, text: 'ordi', x: 100, y: 600, width: 80 },
    { wordIndex: 1, text: 'nary', x: 200, y: 700, width: 80 },
  ];
  drawEmphasisUnderlines(ctx, layout, states([false, true]), { emphasis: { decorationColor: '#22c55e' } });
  const ys = ctx.ops('fillRect').map((c) => c.args[1]);
  assert.equal(ys.length, 2);
  close(ys[0], 600 + EFF * 0.55, 1e-6);
  close(ys[1], 700 + EFF * 0.55, 1e-6);
});

test('the default underline colour is the verified lime', () => {
  const ctx = new FakeContext({});
  drawEmphasisUnderlines(ctx, fakeLayout(), states([true]), {});
  assert.equal(ctx.ops('fillRect')[0].fillStyle, '#22c55e');
});

// ---------------------------------------------------------------------------
// highlight (the CapCut-style variant)
// ---------------------------------------------------------------------------

test('highlightRect hugs the fragment with em-relative padding, centred on the line', () => {
  const frag = { x: 100, y: 610.56, width: 50 };
  const r = highlightRect(frag, EFF, DEFAULT_BOX, 1.15);
  const padX = DEFAULT_BOX.paddingX * EFF;
  close(r.x, 100 - padX, 1e-9);
  close(r.w, 50 + padX * 2, 1e-9);
  close(r.h, EFF * 1.15 + DEFAULT_BOX.paddingY * EFF * 2, 1e-9);
  close(r.y + r.h / 2, 610.56, 1e-9);
});

test('drawEmphasisHighlights draws a rounded backdrop and honours the template colour', () => {
  const ctx = new FakeContext({});
  drawEmphasisHighlights(
    ctx,
    fakeLayout(),
    states([false, true, false]),
    { emphasis: { decoration: 'highlight', highlightColor: '#ffd400' }, box: { radius: 0.3, paddingX: 0.3, paddingY: 0.1 } },
  );
  assert.equal(ctx.ops('fillRect').length, 0, 'a highlight is a path fill, not a fillRect');
  assert.equal(ctx.ops('arcTo').length, 4, 'rounded corners');
  const fills = ctx.ops('fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].fillStyle, '#ffd400', 'the template highlight colour wins over the box default');
  assert.equal(fills[0].shadowColor, 'transparent');
  assert.equal(ctx.depth, 0);
});

// ---------------------------------------------------------------------------
// boxes + path helpers
// ---------------------------------------------------------------------------

test('lineBoxRect covers the line plus padding', () => {
  const line = { x: 100, y: 200, width: 300 };
  const r = lineBoxRect(line, EFF, DEFAULT_BOX, EFF * 1.15);
  const padX = DEFAULT_BOX.paddingX * EFF;
  close(r.x, 100 - padX, 1e-9);
  close(r.w, 300 + padX * 2, 1e-9);
  close(r.h, EFF * 1.15 + DEFAULT_BOX.paddingY * EFF * 2, 1e-9);
  close(r.y + r.h / 2, 200, 1e-9);
});

test('blockBoxRect covers the whole layout', () => {
  const layout = { effFontSize: EFF, x: 700, y: 500, width: 400, height: 100 };
  const r = blockBoxRect(layout, DEFAULT_BOX);
  assert.ok(r.w > layout.width);
  assert.ok(r.h > layout.height);
  close(r.x + r.w / 2, 700 + 200, 1e-9);
  close(r.y + r.h / 2, 500 + 50, 1e-9);
});

test('roundRectPath degrades to a plain rect at radius 0', () => {
  const square = new FakeContext({});
  roundRectPath(square, { x: 0, y: 0, w: 10, h: 10, radius: 0 });
  assert.equal(square.ops('rect').length, 1);
  assert.equal(square.ops('arcTo').length, 0);

  const rounded = new FakeContext({});
  roundRectPath(rounded, { x: 0, y: 0, w: 10, h: 10, radius: 3 });
  assert.equal(rounded.ops('rect').length, 0);
  assert.equal(rounded.ops('arcTo').length, 4);
  assert.equal(rounded.ops('moveTo').length, 1);
  assert.equal(rounded.ops('closePath').length, 1);
});

test('roundRectPath clamps an absurd radius instead of drawing garbage', () => {
  const ctx = new FakeContext({});
  roundRectPath(ctx, { x: 0, y: 0, w: 10, h: 10, radius: 999 });
  for (const c of ctx.ops('arcTo')) assert.equal(c.args[4], 5, 'radius clamped to min(w,h)/2');
});

test('fillDecoration suppresses the shadow and balances save/restore', () => {
  const ctx = new FakeContext({});
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 10;
  fillDecoration(ctx, { x: 0, y: 0, w: 10, h: 10, radius: 2 }, '#000000', { opacity: 0.5 });
  assert.equal(ctx.ops('fill').length, 1);
  assert.equal(ctx.depth, 0);
  // the outer shadow configuration must survive
  assert.equal(ctx.shadowColor, 'rgba(0,0,0,0.85)');
  assert.equal(ctx.shadowBlur, 10);
});
