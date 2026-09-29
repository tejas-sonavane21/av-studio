/**
 * placement.test.js — the geometry that decides where a caption sits.
 *
 * This is the module the user *feels*: a caption that will not line up with the canvas centre, or
 * that can be dragged off the frame, is the difference between \"CapCut-like\" and \"broken\". Two
 * rules in particular are easy to get subtly wrong and are pinned down here:
 *
 * 1. **Snapping tests the box's edges, not the anchor point.** The user is looking at the box; the
 *    anchor is an implementation detail (and only coincides with the box centre under
 *    `gravity: 'center'`). There is a test below that would fail under the anchor-point rule while
 *    still producing a "valid" number — that is why it exists.
 * 2. **Clamping slides the box, it never resizes it, and an over-wide box is centred rather than
 *    pushed off one edge.**
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EDGE_MARGIN_PX,
  DEFAULT_SNAP_TOLERANCE_PX,
  PRESET_IDS,
  SAFE_AREAS,
  anchorFromPreset,
  anchorToPx,
  boxOverflow,
  boxRectFor,
  buildSnapTargets,
  clampAnchorToCanvas,
  describeAnchor,
  moveAnchor,
  nudgeAnchor,
  placeAnchor,
  presetFor,
  pxToAnchor,
  snapAnchor,
  snapValue,
} from '../../src/render/placement.js';
import { ANCHOR_PRESETS, createDefaultStyle } from '../../src/model/schema.js';

const canvas = { width: 1280, height: 720 };
const box = { width: 200, height: 100 };

test('the safe-area fractions are the canonical ones', () => {
  assert.deepEqual(SAFE_AREAS, { titleSafe: 0.9, actionSafe: 0.93 });
});

test('PRESET_IDS mirror the schema, in schema order', () => {
  assert.deepEqual(PRESET_IDS, Object.keys(ANCHOR_PRESETS));
  assert.equal(PRESET_IDS.length, 9);
  assert.ok(PRESET_IDS.includes('bottom-right'));
});

test('anchorFromPreset returns a fresh object carrying the preset id', () => {
  const a = anchorFromPreset('bottom-right');
  assert.deepEqual(a, { posX: 0.772, posY: 0.848, gravity: 'center', preset: 'bottom-right' });
  // the verified default anchor IS this preset — including the id, so a fresh document can be
  // described as being on the parity template
  assert.deepEqual(createDefaultStyle().anchor, { ...ANCHOR_PRESETS['bottom-right'], preset: 'bottom-right' });
  assert.equal(anchorFromPreset('nope'), null);
});

test('anchorToPx / pxToAnchor round-trip and clamp', () => {
  assert.deepEqual(anchorToPx({ posX: 0.5, posY: 0.5 }, canvas), { x: 640, y: 360 });
  assert.deepEqual(anchorToPx(null, canvas), { x: 640, y: 360 }, 'missing anchor falls back to centre');
  assert.deepEqual(pxToAnchor({ x: 640, y: 360 }, canvas, { gravity: 'bottom-left' }), {
    posX: 0.5,
    posY: 0.5,
    gravity: 'bottom-left',
  });
  // 0..1 is a model invariant, so out-of-frame pixels cannot leak into the document
  assert.deepEqual(pxToAnchor({ x: -50, y: 5000 }, canvas).posX, 0);
  assert.equal(pxToAnchor({ x: -50, y: 5000 }, canvas).posY, 1);
});

test('a manual move never carries a preset claim with it', () => {
  // dragging must not leave a block claiming to be \"bottom-centre\"; presetFor re-establishes it
  const moved = moveAnchor({ ...anchorFromPreset('bottom-right'), preset: 'bottom-right' }, { dxPx: 40 }, canvas);
  assert.equal(moved.preset, undefined);
  assert.ok(Math.abs(moved.posX - (0.772 + 40 / 1280)) < 1e-12);
  assert.equal(moved.posY, 0.848);
});

test('presetFor matches within tolerance, and only same-gravity presets', () => {
  assert.equal(presetFor({ posX: 0.5, posY: 0.86, gravity: 'center' }), 'bottom-center');
  assert.equal(presetFor({ posX: 0.5, posY: 0.86, gravity: 'bottom' }), null, 'gravity mismatch is filtered out');
  assert.equal(
    presetFor({ posX: 0.5, posY: 0.86, gravity: 'bottom' }, { gravity: false }),
    'bottom-center',
    'and the filter can be switched off for a "where am I?" readout',
  );
  assert.equal(presetFor({ posX: 0.5, posY: 0.9 }), null, 'outside the 0.02 tolerance');
  assert.equal(presetFor({ posX: 0.5, posY: 0.9 }, { tolerance: 0.05 }), 'bottom-center');
});

test('nudge is a fraction of the canvas, so zoom cannot change it', () => {
  const base = { posX: 0.5, posY: 0.5, gravity: 'center' };
  assert.equal(nudgeAnchor(base, { dxSteps: 1, step: 0.005 }).posX, 0.505);
  assert.equal(nudgeAnchor(base, { dxSteps: 1, step: 0.005, multiplier: 4 }).posX, 0.52, 'shift = ×4');
  assert.equal(nudgeAnchor(base, { dySteps: -1, step: 0.005 }).posY, 0.495);
  assert.equal(nudgeAnchor(base).posX, 0.5, 'no steps, no movement');
  assert.equal(nudgeAnchor({ posX: 0.999, posY: 0.5, gravity: 'center' }, { dxSteps: 10, step: 0.005 }).posX, 1);
});

test('boxRectFor honours gravity', () => {
  assert.deepEqual(boxRectFor({ posX: 0.5, posY: 0.5, gravity: 'center' }, canvas, box), {
    x: 540,
    y: 310,
    w: 200,
    h: 100,
    cx: 640,
    cy: 360,
    right: 740,
    bottom: 410,
  });
  // bottom-left: the anchor IS the bottom-left corner
  assert.deepEqual(boxRectFor({ posX: 0.1, posY: 0.9, gravity: 'bottom-left' }, canvas, box), {
    x: 128,
    y: 648 - 100,
    w: 200,
    h: 100,
    cx: 228,
    cy: 598,
    right: 328,
    bottom: 648,
  });
  // top-right: right edge at posX, top edge at posY
  const tr = boxRectFor({ posX: 0.9, posY: 0.1, gravity: 'top-right' }, canvas, box);
  assert.equal(tr.right, 0.9 * 1280);
  assert.equal(tr.y, 0.1 * 720);
});

test('clampAnchorToCanvas slides the box inside and keeps its size', () => {
  const anchor = { posX: 0, posY: 0.5, gravity: 'center' };
  const { anchor: fixed, shiftedX, shiftedY } = clampAnchorToCanvas(anchor, { canvas, box });
  const r = boxRectFor(fixed, canvas, box);
  assert.equal(r.x, DEFAULT_EDGE_MARGIN_PX);
  assert.ok(shiftedX > 0);
  assert.equal(shiftedY, 0, 'already vertically inside');
  assert.equal(r.w, box.width, 'size untouched');
  assert.equal(r.h, box.height);

  // an over-wide box is centred, because no anchor can keep it inside
  const wide = { width: 1400, height: 100 };
  const centred = clampAnchorToCanvas({ posX: 0, posY: 0.5, gravity: 'center' }, { canvas, box: wide });
  assert.equal(boxRectFor(centred.anchor, canvas, wide).x, (canvas.width - wide.width) / 2);

  // an inside box is not touched at all
  const inside = clampAnchorToCanvas({ posX: 0.5, posY: 0.5, gravity: 'center' }, { canvas, box });
  assert.equal(inside.shiftedX, 0);
  assert.equal(inside.shiftedY, 0);
  assert.equal(inside.anchor.posX, 0.5);
});

test('the clamp respects gravity rather than assuming the box is centred', () => {
  // gravity bottom-left, anchor on the frame's bottom edge: only the *bottom* edge is out, so the
  // box must move up by exactly the margin — a centred box would have moved ~54 px instead.
  const fixed = clampAnchorToCanvas({ posX: 0.02, posY: 1, gravity: 'bottom-left' }, { canvas, box });
  const r = boxRectFor(fixed.anchor, canvas, box);
  assert.equal(r.bottom, canvas.height - DEFAULT_EDGE_MARGIN_PX);
  assert.equal(r.x, 0.02 * canvas.width, 'the left edge was already inside, so x did not move');
  assert.equal(fixed.shiftedX, 0);
  assert.equal(fixed.shiftedY, -DEFAULT_EDGE_MARGIN_PX);
});

test('boxOverflow reports only the edges that stick out', () => {
  assert.deepEqual(boxOverflow({ posX: 0.5, posY: 0.5, gravity: 'center' }, canvas, box), {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  });
  // top-left gravity: the anchor is the box's top-left corner, so at 90% / 95% the box hangs off
  // the right and bottom edges and nothing else
  const over = boxOverflow({ posX: 0.9, posY: 0.95, gravity: 'top-left' }, canvas, box);
  assert.equal(over.right, 0.9 * canvas.width + box.width - canvas.width);
  assert.equal(over.bottom, 0.95 * canvas.height + box.height - canvas.height);
  assert.equal(over.left, 0);
  assert.equal(over.top, 0);
  // bottom-right gravity at x=0 puts the whole box off the left edge
  assert.equal(boxOverflow({ posX: 0, posY: 0.5, gravity: 'bottom-right' }, canvas, box).left, box.width);
});

test('describeAnchor is the readout the inspector shows', () => {
  assert.equal(describeAnchor({ posX: 0.772, posY: 0.848 }), '77.2% / 84.8%');
  assert.equal(describeAnchor(null), '50.0% / 50.0%');
});

test('buildSnapTargets includes centre, thirds, safe and canvas edges', () => {
  const t = buildSnapTargets({ canvas });
  const xs = t.x.map((x) => x.value);
  const ys = t.y.map((y) => y.value);
  const has = (list, value) => list.some((v) => Math.abs(v - value) < 1e-9);
  assert.ok(has(xs, 640));
  assert.ok(has(xs, 0) && has(xs, 1280));
  assert.ok(has(xs, 1280 / 3) && has(xs, (1280 * 2) / 3));
  // titleSafe 0.9 → 5% inset per side; actionSafe 0.93 → 3.5%
  assert.ok(xs.some((v) => Math.abs(v - 64) < 1e-9));
  assert.ok(ys.some((v) => Math.abs(v - 25.2) < 1e-9));
  assert.ok(t.x.every((x) => x.value >= 0 && x.value <= canvas.width));
  assert.ok(t.y.every((y) => y.value >= 0 && y.value <= canvas.height));
  // no duplicates
  assert.equal(new Set(xs).size, xs.length);
});

test('buildSnapTargets can be switched off and can exclude a sibling', () => {
  const bare = buildSnapTargets({ canvas, thirds: false, safeAreas: false });
  assert.deepEqual(bare.x.map((x) => x.value), [640, 0, 1280]);

  const siblings = [
    { blockId: 'a', x: 500, y: 600, width: 200, height: 100 },
    { blockId: 'b', x: 900, y: 100, width: 100, height: 50 },
  ];
  const withBlocks = buildSnapTargets({ canvas, layouts: siblings, excludeBlockId: 'b' });
  assert.ok(withBlocks.x.includes(500) || withBlocks.x.some((t) => t.value === 500));
  assert.ok(withBlocks.x.some((t) => t.value === 700), 'sibling centre');
  assert.ok(withBlocks.y.some((t) => t.value === 650), 'sibling bottom');
  assert.ok(!withBlocks.x.some((t) => t.value === 900), 'the excluded block contributes nothing');
  assert.ok(withBlocks.x.every((t) => t.kind !== 'block' || t.value !== 950));
});

test('snapValue picks the nearest target inside the tolerance', () => {
  const targets = [
    { value: 100, kind: 'edge', label: 'a' },
    { value: 106, kind: 'center', label: 'b' },
  ];
  assert.equal(snapValue(105, targets, 8).value, 106, 'nearest wins');
  assert.equal(snapValue(105, targets, 8).delta, 1);
  assert.equal(snapValue(105, [{ value: 100 }], 2), null, 'outside tolerance');
  assert.equal(snapValue(105, [], 8), null);
  assert.equal(snapValue(105, undefined, 8), null);
});

test('THE RULE: snapping considers the box edges, not the anchor point', () => {
  const targets = buildSnapTargets({ canvas, thirds: false, safeAreas: false });
  // anchor at 543 px; with a 200-wide centred box the right edge lands at 643 — 3 px from centre
  const anchor = { posX: 543 / 1280, posY: 360 / 720, gravity: 'center' };
  const rect = boxRectFor(anchor, canvas, box);
  assert.equal(rect.right, 643);
  // the anchor itself is 97 px from the centre line, i.e. nowhere near the tolerance
  assert.ok(Math.abs(anchor.posX * 1280 - 640) > DEFAULT_SNAP_TOLERANCE_PX);

  const { anchor: snapped, snappedX, deltaX } = snapAnchor(anchor, { canvas, box, targets });
  assert.equal(snappedX.edge, 'right');
  assert.equal(snappedX.kind, 'center');
  assert.equal(deltaX, -3);
  assert.equal(boxRectFor(snapped, canvas, box).right, 640, 'the box edge is what landed on the guide');
  assert.equal(boxRectFor(snapped, canvas, box).w, 200, 'and the box was moved, not resized');
});

test('snapAnchor reports nothing when every edge is far from a guide', () => {
  const targets = { x: [{ value: 640, kind: 'center', label: 'centre' }], y: [] };
  const { snappedX, snappedY, deltaX, deltaY } = snapAnchor({ posX: 0.1, posY: 0.5, gravity: 'center' }, { canvas, box, targets });
  assert.equal(snappedX, null);
  assert.equal(snappedY, null);
  assert.equal(deltaX, 0);
  assert.equal(deltaY, 0);
});

test('placeAnchor snaps first, then clamps, so a snap is never pulled off its guide', () => {
  const targets = buildSnapTargets({ canvas });
  // drag far past the right edge: the clamp has to bring it back inside
  const placed = placeAnchor({ posX: 2, posY: 0.5, gravity: 'center' }, { canvas, box, targets, tolerance: 20 });
  const r = boxRectFor(placed.anchor, canvas, box);
  assert.ok(r.right <= canvas.width - DEFAULT_EDGE_MARGIN_PX + 1e-9);
  assert.ok(placed.clamped);

  // a drag that is already inside and near the centre snaps exactly, with no clamping
  const near = placeAnchor({ posX: (640 - 100 + 2) / 1280, posY: 0.5, gravity: 'center' }, { canvas, box, targets });
  assert.equal(boxRectFor(near.anchor, canvas, box).right, 640);
  assert.equal(near.clamped, false);
});
