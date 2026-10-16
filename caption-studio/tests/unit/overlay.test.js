/**
 * overlay.test.js — the interactive placement layer.
 *
 * The overlay is the only Phase 4 module that touches the DOM, so it is tested in two halves:
 *
 * - the **pure helpers** (coordinate conversion, hit testing, guide lines) directly, because a
 *   wrong scale factor shows up as \"the text jumps away from the cursor\", which is very hard to
 *   diagnose from a screenshot;
 * - the **factory**, against a minimal fake element that records listeners and can emit pointer and
 *   key events. That covers the actual drag/snap/nudge session end to end without a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NUDGE_STEP,
  HIT_PADDING_PX,
  NUDGE_MULTIPLIER,
  boxRectOf,
  createCanvasOverlay,
  dragAnchor,
  guideLinesFor,
  hitTest,
  logicalToOverlay,
  pointToLogical,
  selectionRect,
} from '../../src/editor/canvas-overlay.js';
import { createFakeCanvas } from '../helpers/fake-canvas.js';
import { normalizeClip } from '../../src/model/media.js';

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const logicalSize = { width: 1280, height: 720 };
// a canvas displayed at half size, offset inside its stage
const rect = { left: 100, top: 50, width: 640, height: 360 };

test('pointToLogical scales both axes independently, in logical units', () => {
  const p = pointToLogical({ rect, size: logicalSize, clientX: 100 + 320, clientY: 50 + 180 });
  assert.equal(p.x, 640);
  assert.equal(p.y, 360);
  assert.equal(p.sx, 2);
  // Note: the *backing store* is logical × dpr; using it here would double-count the DPR.
  const rounded = pointToLogical({ rect: { ...rect, height: 361 }, size: logicalSize, clientX: 100, clientY: 50 });
  assert.equal(rounded.x, 0);
  assert.equal(rounded.y, 0);
  // a degenerate rect (display:none) must not produce NaN
  const flat = pointToLogical({ rect: { left: 0, top: 0, width: 0, height: 0 }, size: logicalSize, clientX: 0, clientY: 0 });
  assert.deepEqual({ x: flat.x, y: flat.y }, { x: 0, y: 0 });
});

test('logicalToOverlay maps through the canvas origin and scale', () => {
  const out = logicalToOverlay({ x: 640, y: 360 }, { scale: 0.5, offsetX: 20, offsetY: 10 });
  assert.deepEqual(out, { x: 340, y: 190 });
});

test('boxRectOf tolerates a layout with no box', () => {
  assert.deepEqual(boxRectOf({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(boxRectOf(null), { x: 0, y: 0, w: 0, h: 0 });
});

test('hitTest picks the topmost box and pads it', () => {
  const layouts = [
    { blockId: 'under', x: 0, y: 0, width: 1280, height: 720 },
    { blockId: 'over', x: 400, y: 500, width: 200, height: 100 },
  ];
  assert.equal(hitTest(layouts, { x: 500, y: 550 }).blockId, 'over', 'later draws are on top');
  assert.equal(hitTest(layouts, { x: 50, y: 50 }).blockId, 'under');
  // 1 px left of the small box, i.e. inside the padding, so it is still "over"…
  assert.equal(hitTest(layouts, { x: 400 - 1, y: 550 }).blockId, 'over', 'the padding is the point');
  // …but 1 px beyond the padding falls through to whatever is underneath
  assert.equal(hitTest(layouts, { x: 400 - HIT_PADDING_PX - 1, y: 550 }).blockId, 'under');
  assert.equal(hitTest(layouts, { x: 400 - 1, y: 550 }, { padding: 0 }).blockId, 'under');
  assert.equal(hitTest(layouts, { x: 500, y: 550 }, { padding: 0 }).blockId, 'over');
  assert.equal(hitTest([], { x: 1, y: 1 }), null);
  assert.equal(hitTest(layouts, null), null);
  assert.equal(hitTest([null, { blockId: 'a', x: 0, y: 0, width: 10, height: 10 }], { x: 5, y: 5 }).blockId, 'a');
});

test('selectionRect follows the anchor with gravity', () => {
  const centred = selectionRect({ posX: 0.5, posY: 0.5, gravity: 'center' }, logicalSize, { width: 200, height: 100 });
  assert.deepEqual(centred, { x: 640 - 100 - HIT_PADDING_PX, y: 360 - 50 - HIT_PADDING_PX, w: 200 + 2 * HIT_PADDING_PX, h: 100 + 2 * HIT_PADDING_PX });
  const corner = selectionRect({ posX: 0.5, posY: 0.5, gravity: 'bottom-left' }, logicalSize, { width: 200, height: 100 });
  assert.equal(corner.x, 640 - HIT_PADDING_PX);
  assert.equal(corner.y, 360 - 100 - HIT_PADDING_PX);
});

test('guideLinesFor emits only the line that was snapped, unless asked for all', () => {
  const targets = {
    x: [
      { value: 640, kind: 'center', label: 'centre' },
      { value: 0, kind: 'edge', label: 'left edge' },
    ],
    y: [{ value: 360, kind: 'center', label: 'centre' }],
  };
  const only = guideLinesFor({ canvas: logicalSize, targets, snappedX: targets.x[0] });
  assert.equal(only.length, 1);
  assert.deepEqual(only[0], {
    axis: 'x',
    active: true,
    value: 640,
    kind: 'center',
    label: 'centre',
    x1: 640,
    y1: 0,
    x2: 640,
    y2: 720,
  });
  const all = guideLinesFor({ canvas: logicalSize, targets, snappedY: targets.y[0], showAll: true });
  assert.equal(all.length, 3);
  assert.equal(all.filter((l) => l.active).length, 1, 'only one line is ever the *active* one');
  const horizontal = all.find((l) => l.axis === 'y');
  assert.ok(horizontal, 'a snapped vertical coordinate is drawn as a horizontal line');
  assert.deepEqual({ x1: horizontal.x1, x2: horizontal.x2 }, { x1: 0, x2: 1280 });
  assert.equal(horizontal.active, true);
  assert.ok(all.filter((l) => l.axis === 'x').every((l) => l.x1 === l.x2 && l.y2 === 720));
  assert.deepEqual(guideLinesFor({ canvas: logicalSize, targets }), [], 'nothing snapped, nothing drawn');
});

test('dragAnchor holds the grab offset, so the text stays under the cursor', () => {
  // grabbed 10 px right of and 4 px above the anchor
  const anchor = dragAnchor({ grabOffset: { dx: 10, dy: -4 }, pointer: { x: 500, y: 200 }, canvas: logicalSize });
  assert.equal(anchor.posX, 490 / 1280);
  assert.equal(anchor.posY, 204 / 720);
  assert.equal(anchor.gravity, 'center');
  // a matching pointer and offset means the anchor does not move at all
  const same = dragAnchor({ grabOffset: { dx: 0, dy: 0 }, pointer: { x: 640, y: 360 }, canvas: logicalSize });
  assert.deepEqual({ posX: same.posX, posY: same.posY }, { posX: 0.5, posY: 0.5 });
  assert.equal(dragAnchor({ grabOffset: { dx: 0, dy: 0 }, pointer: { x: 99999, y: -5 }, canvas: logicalSize }).posX, 1);
});

// ---------------------------------------------------------------------------
// the factory, against a fake element
// ---------------------------------------------------------------------------

/** A minimal element: it records listeners and can emit events. */
function fakeElement({ rect: r, clientWidth, clientHeight, ctx = null } = {}) {
  const handlers = new Map();
  return {
    width: 0,
    height: 0,
    style: {},
    clientWidth,
    clientHeight,
    getBoundingClientRect: () => r,
    getContext: () => ctx,
    addEventListener(type, fn) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    removeEventListener(type, fn) {
      handlers.set(type, (handlers.get(type) ?? []).filter((f) => f !== fn));
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    emit(type, event = {}) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
      return event;
    },
    get handlers() {
      return handlers;
    },
  };
}

function fakeWindow() {
  const handlers = new Map();
  return {
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    removeEventListener(type, fn) {
      handlers.set(type, (handlers.get(type) ?? []).filter((f) => f !== fn));
    },
    emit(type, event) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
    },
    get handlers() {
      return handlers;
    },
  };
}

/** A preview stub: the overlay only ever reads `renderer.size`, `layouts` and `document`. */
function fakePreview(layouts, blocks) {
  return {
    renderer: { size: { width: 1280, height: 720, dpr: 1 } },
    layouts,
    document: {
      defaults: { anchor: { posX: 0.5, posY: 0.86, gravity: 'center', preset: 'bottom-center' } },
      blocks,
    },
  };
}

/**
 * A consistent fixture: block `b1` is a 200×100 box whose centre is the anchor at (500, 550) px.
 * Consistency matters — the overlay derives the selection outline from the anchor and the drag maths
 * from the layout, so an inconsistent fixture would hide a bug rather than expose one.
 */
/**
 * An overlay-clip fixture: a 640×360 box at (320,180) on the 1280×720 frame, with corners at
 * (320,180) / (960,180) / (960,540) / (320,540) — round numbers, because every expected value in the
 * clip tests below is read off this box by hand.
 */
export const CLIP_BOX = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
export const CLIP_CENTRE = { x: 640, y: 360 };
export const CLIP_SE = { x: 960, y: 540 };
/** The round handle: 26 px above the top edge, which is the top edge's own midpoint minus the gap. */
export const CLIP_GRIP = { x: 640, y: 180 - 26 };

function setup({
  place = { posX: 500 / 1280, posY: 550 / 720, gravity: 'center' },
  clips = [],
  media = { width: 400, height: 200 },
  shapesLocked = true,
} = {}) {
  const layouts = [{ blockId: 'b1', x: 400, y: 500, width: 200, height: 100 }];
  const blocks = [
    { id: 'b1', placement: place },
    { id: 'b2', placement: null },
  ];
  const preview = fakePreview(layouts, blocks);
  const canvas = createFakeCanvas(1280, 720);
  const canvasEl = fakeElement({ rect: { left: 100, top: 50, width: 1280, height: 720 }, clientWidth: 1280, clientHeight: 720 });
  const overlayEl = fakeElement({ rect: { left: 100, top: 50, width: 1280, height: 720 }, clientWidth: 1280, clientHeight: 720, ctx: canvas.getContext('2d') });
  const calls = { select: [], place: [], clipSelect: [], clipBox: [], clipRotate: [] };
  const win = fakeWindow();
  const previousWindow = globalThis.window;
  globalThis.window = win;

  const overlay = createCanvasOverlay({
    canvas: canvasEl,
    overlay: overlayEl,
    preview,
    getClips: () => clips,
    clipSize: () => media,
    keepAspect: () => shapesLocked,
    onSelect: (id) => calls.select.push(id),
    onPlace: (id, anchor, info) => calls.place.push({ id, anchor, info }),
    onClipSelect: (id) => calls.clipSelect.push(id),
    onClipBox: (id, box, info) => calls.clipBox.push({ id, box, info }),
    onClipRotate: (id, degrees, info) => calls.clipRotate.push({ id, degrees, info }),
  });

  return {
    overlay,
    preview,
    canvas,
    canvasEl,
    overlayEl,
    win,
    calls,
    clips,
    /** The clip as the overlay last published it, which is what the caller would have applied. */
    lastBox: () => calls.clipBox.at(-1)?.box ?? null,
    /** logical canvas point → the client coordinates the overlay will see */
    at: (x, y) => ({ clientX: x + 100, clientY: y + 50 }),
    cleanup: () => {
      overlay.dispose();
      globalThis.window = previousWindow;
    },
  };
}

/** The clip the fixtures below drag: the model's own canonical shape, so the overlay sees what main.js gives it. */
function clipFixture(over = {}) {
  return normalizeClip({ id: 'c1', kind: 'image', name: 'logo.png', start: 1, end: 5, box: CLIP_BOX, ...over });
}

test('the factory refuses to run without its elements', () => {
  assert.throws(() => createCanvasOverlay({}), /canvas and an overlay canvas/);
  assert.throws(() => createCanvasOverlay({ canvas: fakeElement() }), /canvas and an overlay canvas/);
  assert.throws(
    () => createCanvasOverlay({ canvas: fakeElement(), overlay: fakeElement() }),
    /a preview instance is required/,
  );
});

test('a drag selects the block, moves the anchor by the pointer delta and commits on release', () => {
  const s = setup();
  try {
    // grab at (450, 540): 50 px left of and 10 px above the anchor
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    assert.deepEqual(s.calls.select, ['b1']);
    assert.equal(s.overlay.selectedId, 'b1');
    assert.equal(s.overlay.dragging, true);
    assert.equal(s.calls.place.length, 0, 'a click with no movement places nothing');

    // move 100 px right, no vertical movement: the box travels with the cursor
    s.overlayEl.emit('pointermove', { ...s.at(550, 540), pointerId: 1, preventDefault() {} });
    assert.equal(s.calls.place.length, 1);
    const [move] = s.calls.place;
    assert.equal(move.id, 'b1');
    assert.equal(move.info.live, true);
    assert.equal(move.info.commit, undefined);
    assert.ok(Math.abs(move.anchor.posX - 600 / 1280) < 1e-12, `posX was ${move.anchor.posX}`);
    assert.ok(Math.abs(move.anchor.posY - 550 / 720) < 1e-12);
    assert.equal(move.anchor.gravity, 'center');
    assert.equal(s.overlay.guides.snappedX, null, 'nowhere near a guide');

    s.overlayEl.emit('pointerup', { pointerId: 1 });
    assert.equal(s.overlay.dragging, false);
    assert.equal(s.calls.place.length, 2);
    assert.equal(s.calls.place[1].info.commit, true);
    assert.equal(s.calls.place[1].info.live, false);
    assert.deepEqual(s.overlay.guides.snappedX, null, 'guides are cleared when the drag ends');

    // moving after the release does nothing at all
    s.overlayEl.emit('pointermove', { ...s.at(900, 300), pointerId: 1 });
    assert.equal(s.calls.place.length, 2);
  } finally {
    s.cleanup();
  }
});

test('a drag that lines the box up with the canvas centre snaps exactly, and says so', () => {
  const s = setup();
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    // The grab offset is (−50, −10) and the anchor follows `pointer − offset`, so a pointer at
    // (587, 347) puts the anchor at (637, 357) — 3 px short of the canvas centre on both axes,
    // inside the 8 px tolerance, which is exactly the case snapping exists for.
    s.overlayEl.emit('pointermove', { ...s.at(587, 347), pointerId: 1, preventDefault() {} });
    const [live] = s.calls.place;
    assert.equal(live.anchor.posX, 0.5, 'snapped onto the centre line, not left 3 px short');
    assert.equal(live.anchor.posY, 0.5);
    assert.equal(live.info.guides.snappedX.kind, 'center');
    assert.equal(live.info.guides.snappedX.edge, 'center', 'the box *centre* edge is what landed on the guide');
    assert.equal(live.info.guides.snappedY.edge, 'middle', 'vertically it is the box middle');
    assert.equal(live.info.guides.snappedX.label, 'centre');
    assert.equal(s.overlay.guides.snappedX.label, 'centre', 'and the overlay can draw it');
  } finally {
    s.cleanup();
  }
});

test('and holding alt places the box where it was put: no guide moves it, and none is drawn', () => {
  const s = setup();
  try {
    // The same drag as the test above, 3 px short of the centre on both axes — inside the tolerance, so
    // with the targets in place it lands on the centre. Alt takes the targets away for the gesture.
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, altKey: true, preventDefault() {} });
    s.overlayEl.emit('pointermove', { ...s.at(587, 347), pointerId: 1, altKey: true, preventDefault() {} });
    const [live] = s.calls.place;
    assert.ok(Math.abs(live.anchor.posX - 637 / 1280) < 1e-12, `posX was ${live.anchor.posX}`);
    assert.ok(Math.abs(live.anchor.posY - 357 / 720) < 1e-12, `posY was ${live.anchor.posY}`);
    assert.equal(live.info.guides.snappedX ?? null, null, 'nothing was snapped');
    assert.equal(s.overlay.guides.targets.x.length, 0, 'no targets, so the guide layer has nothing to draw');

    // Letting go *mid-drag* puts the guides back, which is how a position gets finished by hand: nudge
    // it close with the modifier, release, and the last few pixels snap.
    s.overlayEl.emit('pointermove', { ...s.at(587, 347), pointerId: 1, preventDefault() {} });
    assert.ok(s.overlay.guides.targets.x.length > 0, 'the full set is back the moment the key is released');
    const [after] = s.calls.place.slice(-1);
    assert.equal(after.anchor.posX, 0.5, 'and the same position now snaps onto the centre');
    assert.equal(after.anchor.posY, 0.5);
  } finally {
    s.cleanup();
  }
});

test('a drag past the edge is clamped back inside the frame', () => {
  const s = setup();
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointermove', { ...s.at(3000, 540), pointerId: 1, preventDefault() {} });
    const [live] = s.calls.place;
    // the box's right edge stops at width − margin instead of leaving the canvas
    const right = live.anchor.posX * 1280 + 100;
    assert.ok(right <= 1280 - 4 + 1e-9, `right edge was ${right}`);
    assert.ok(live.anchor.posX < 1);
  } finally {
    s.cleanup();
  }
});

test('clicking a caption-free area clears the selection instead of starting a drag', () => {
  const s = setup();
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(50, 50), pointerId: 1, preventDefault() {} });
    assert.deepEqual(s.calls.select, [null]);
    assert.equal(s.overlay.dragging, false);
    assert.equal(s.calls.place.length, 0);
  } finally {
    s.cleanup();
  }
});

test('arrow keys nudge the selection, shift multiplies, and typing is left alone', () => {
  const s = setup();
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointerup', { pointerId: 1 });
    const before = s.calls.place.length;

    s.win.emit('keydown', { key: 'ArrowRight', shiftKey: false, target: { tagName: 'DIV' }, preventDefault() {} });
    const step = s.calls.place.at(-1);
    assert.equal(s.calls.place.length, before + 1);
    assert.equal(step.info.keyboard, true);
    assert.equal(step.info.commit, true);
    assert.ok(Math.abs(step.anchor.posX - (500 / 1280 + DEFAULT_NUDGE_STEP)) < 1e-12);
    assert.equal(step.anchor.posY, 550 / 720, 'an unmodified horizontal nudge does not move vertically');

    s.win.emit('keydown', { key: 'ArrowUp', shiftKey: true, target: { tagName: 'DIV' }, preventDefault() {} });
    const big = s.calls.place.at(-1);
    assert.ok(Math.abs(big.anchor.posY - (550 / 720 - DEFAULT_NUDGE_STEP * NUDGE_MULTIPLIER)) < 1e-12);

    // a key press inside a text field must not move any text
    const n = s.calls.place.length;
    s.win.emit('keydown', { key: 'ArrowLeft', target: { tagName: 'INPUT' }, preventDefault() {} });
    s.win.emit('keydown', { key: 'a', target: { tagName: 'DIV' }, preventDefault() {} });
    assert.equal(s.calls.place.length, n);
  } finally {
    s.cleanup();
  }
});

test('the nudge() entry point works without a keyboard at all', () => {
  const s = setup();
  try {
    s.overlay.select('b1');
    const next = s.overlay.nudge({ dxSteps: -1, dySteps: 0 }, { multiplier: NUDGE_MULTIPLIER });
    assert.equal(next.posX, 500 / 1280 - DEFAULT_NUDGE_STEP * NUDGE_MULTIPLIER);
    assert.equal(s.calls.place.at(-1).info.keyboard, undefined);
    s.overlay.select(null);
    assert.equal(s.overlay.nudge({ dxSteps: 1 }), null, 'nothing selected → nothing to nudge');
  } finally {
    s.cleanup();
  }
});

test('disabling the overlay stops it reacting and hides its cursor', () => {
  const s = setup();
  try {
    assert.equal(s.overlay.enabled, true);
    s.overlay.setEnabled(false);
    assert.equal(s.overlay.enabled, false);
    assert.equal(s.overlayEl.style.pointerEvents, 'none');
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    assert.deepEqual(s.calls.select, [], 'a disabled overlay does not select');
    assert.equal(s.overlay.dragging, false);
    s.overlay.setEnabled(true);
    assert.equal(s.overlayEl.style.pointerEvents, 'auto');
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    assert.deepEqual(s.calls.select, ['b1']);
  } finally {
    s.cleanup();
  }
});

test('the guide layer paints, and stops painting once nothing is selected', () => {
  const s = setup();
  try {
    const ctx = s.canvas.getContext('2d');
    ctx.reset();
    // nothing selected and nothing being dragged → the refresh short-circuits before drawing
    assert.equal(s.overlay.refresh(), false);
    assert.equal(ctx.ops('clearRect').length, 0);

    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    assert.ok(ctx.ops('clearRect').length > 0, 'a selection is drawn');
    assert.ok(ctx.ops('save').length > 0, 'the selection outline is painted inside save/restore');
    // and a repeat refresh with an unchanged geometry is skipped rather than repainted
    const painted = ctx.ops('clearRect').length;
    assert.equal(s.overlay.refresh(), false);
    assert.equal(ctx.ops('clearRect').length, painted);
  } finally {
    s.cleanup();
  }
});

test('dispose removes every listener and leaves no drag behind', () => {
  const s = setup();
  try {
    s.overlay.dispose();
    assert.equal(s.overlayEl.handlers.get('pointerdown').length, 0);
    assert.equal(s.win.handlers.get('keydown').length, 0);
    assert.equal(s.overlay.dragging, false);
  } finally {
    globalThis.window = undefined;
  }
});

// ---------------------------------------------------------------------------
// overlay clips: the box, its handles, and the round handle above it
// ---------------------------------------------------------------------------

test('a press on a clip selects it and drags its box, committing on release', () => {
  const s = setup({ clips: [clipFixture()] });
  try {
    // A press with no movement is a selection, and nothing is committed for it: a click is not an edit.
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    assert.deepEqual(s.calls.clipSelect, ['c1'], 'the press selected the clip in the preview');
    assert.equal(s.overlay.selectedClipId, 'c1');
    assert.equal(s.overlay.dragging, true);
    assert.deepEqual(s.calls.clipBox, [], 'and asked for no edit yet');
    s.overlayEl.emit('pointerup', { pointerId: 1 });
    assert.deepEqual(s.calls.clipBox, [], 'a click is not a drag, so nothing was committed');

    // Now drag it: 60 px right and 40 px down, on a 1280x720 frame.
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointermove', { ...s.at(700, 400), pointerId: 1, preventDefault() {} });
    const live = s.calls.clipBox.at(-1);
    assert.equal(live.info.live, true);
    assert.equal(live.info.commit, false);
    assert.ok(Math.abs(live.box.x - (0.25 + 60 / 1280)) < 1e-9, `x moved with the pointer: ${live.box.x}`);
    assert.ok(Math.abs(live.box.y - (0.25 + 40 / 720)) < 1e-9, `y moved with the pointer: ${live.box.y}`);
    assert.equal(live.box.w, 0.5, 'the size is untouched by a move');
    assert.equal(live.box.h, 0.5);

    s.overlayEl.emit('pointerup', { pointerId: 1 });
    const committed = s.calls.clipBox.at(-1);
    assert.equal(committed.info.commit, true, 'and the release is the commit');
    assert.deepEqual(committed.box, live.box, 'with the box the drag ended on');
    assert.equal(s.overlay.dragging, false);
  } finally {
    s.cleanup();
  }
});

test('and alt frees a clip drag the same way, guides and lines together', () => {
  const s = setup({ clips: [clipFixture()] });
  try {
    // The clip's centre starts exactly on the frame's centre, so 3 px to the right is inside the
    // tolerance and would snap straight back — unless the modifier says otherwise.
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, altKey: true, preventDefault() {} });
    s.overlayEl.emit('pointermove', { ...s.at(643, 360), pointerId: 1, altKey: true, preventDefault() {} });
    const [live] = s.calls.clipBox;
    assert.ok(Math.abs(live.box.x - (0.25 + 3 / 1280)) < 1e-9, `the box went where it was put: ${live.box.x}`);
    assert.equal(live.info.guides.snappedX ?? null, null, 'nothing was snapped');
    assert.equal(s.overlay.guides.targets.x.length, 0, 'and the guide layer is drawing nothing');

    s.overlayEl.emit('pointermove', { ...s.at(643, 360), pointerId: 1, preventDefault() {} });
    assert.ok(s.overlay.guides.targets.x.length > 0, 'letting go puts the clip\u2019s targets back');
    assert.ok(Math.abs(s.lastBox().x - 0.25) < 1e-12, `and it snaps onto the centre: ${s.lastBox().x}`);
  } finally {
    s.cleanup();
  }
});

test('a drag on a handle resizes the box and pins the corner opposite', () => {
  // The shape lock is off for this one: with it on, the height is derived from the width, and that case
  // has a test of its own below.
  const s = setup({ clips: [clipFixture()], shapesLocked: false });
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointerup', { pointerId: 1 });

    s.overlayEl.emit('pointerdown', { ...s.at(CLIP_SE.x, CLIP_SE.y), pointerId: 1, preventDefault() {} });
    assert.equal(s.overlay.clipDragging.mode, 'resize');
    assert.equal(s.overlay.clipDragging.handle, 'se');
    s.overlayEl.emit('pointermove', { ...s.at(1000, 600), pointerId: 1, preventDefault() {} });
    const resized = s.lastBox();
    assert.ok(resized.w > 0.5, `the box grew: ${resized.w}`);
    assert.ok(resized.h > 0.5, `the box grew: ${resized.h}`);
    assert.equal(resized.x, 0.25, 'the top-left corner did not move');
    assert.equal(resized.y, 0.25);
    // 1000 px of the frame is 0.78125 of it, and the left edge is pinned at 0.25, so the width is the
    // difference between the two.
    assert.ok(Math.abs(resized.w - (1000 / 1280 - 0.25)) < 1e-9, `the right edge followed the pointer: ${resized.w}`);
    assert.equal(s.calls.clipSelect.at(-1), 'c1', 'and the same clip is still the one being edited');
  } finally {
    s.cleanup();
  }
});

test('the panel shape lock holds the picture ratio, and shift inverts it for one drag', () => {
  const s = setup({ clips: [clipFixture()] });
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointerup', { pointerId: 1 });
    // The side handle: 880 px wide asks for a 440 px height at the 400x200 file's 2:1 shape, which is
    // more than the 360 px the box has, so a locked drag grows the height and a free one does not.
    s.overlayEl.emit('pointerdown', { ...s.at(960, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointermove', { ...s.at(1200, 360), pointerId: 1, preventDefault() {} });
    const locked = s.lastBox();
    assert.ok(Math.abs(locked.h - 440 / 720) < 1e-9, `the height was derived from the width: ${locked.h}`);
    assert.ok(Math.abs(locked.y + locked.h / 2 - 0.5) < 1e-9, 'and it grew around the box own centre');

    s.overlayEl.emit('pointermove', { ...s.at(1200, 360), pointerId: 1, shiftKey: true, preventDefault() {} });
    const free = s.lastBox();
    assert.equal(free.h, 0.5, 'shift frees the shape for this drag');
    assert.equal(free.w, locked.w, 'and the edge the pointer set is the same either way');

    // A locked *corner* drag grows the box out of the corner that was not touched, so the corner opposite
    // the handle is the one that stays put — the same promise a free resize makes.
    s.overlayEl.emit('pointerdown', { ...s.at(CLIP_SE.x, CLIP_SE.y), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointermove', { ...s.at(1000, 600), pointerId: 1, preventDefault() {} });
    const corner = s.lastBox();
    assert.equal(corner.x, 0.25, 'the top-left corner did not move');
    assert.equal(corner.y, 0.25);
    assert.ok(Math.abs((corner.w * 1280) / (corner.h * 720) - 2) < 1e-9, `and the file's 2:1 shape is held: ${corner.w}x${corner.h}`);
  } finally {
    s.cleanup();
  }
});

test('the round handle turns the clip, and shift puts the angle on a step', () => {
  const s = setup({ clips: [clipFixture()] });
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointerup', { pointerId: 1 });

    s.overlayEl.emit('pointerdown', { ...s.at(CLIP_GRIP.x, CLIP_GRIP.y), pointerId: 1, preventDefault() {} });
    assert.equal(s.overlay.clipDragging.mode, 'rotate', 'the grip above the top edge is the turn handle');
    // 40 degrees round the centre from the grip's own position at the top: the grip starts at -90, so
    // the clip ends up turned 130, which is 5 degrees off the 135 step and therefore out of reach.
    const at40 = {
      x: CLIP_CENTRE.x + 100 * Math.cos((40 * Math.PI) / 180),
      y: CLIP_CENTRE.y + 100 * Math.sin((40 * Math.PI) / 180),
    };
    s.overlayEl.emit('pointermove', { ...s.at(at40.x, at40.y), pointerId: 1, preventDefault() {} });
    assert.ok(
      Math.abs(s.calls.clipRotate.at(-1).degrees - 130) < 1e-6,
      `free rotation passed through: ${s.calls.clipRotate.at(-1).degrees}`,
    );
    assert.equal(s.calls.clipRotate.at(-1).info.snapped, null, 'and nothing was snapped');

    s.overlayEl.emit('pointermove', { ...s.at(at40.x, at40.y), pointerId: 1, shiftKey: true, preventDefault() {} });
    assert.equal(s.calls.clipRotate.at(-1).degrees, 135, 'shift takes the nearest 15 degrees');

    s.overlayEl.emit('pointerup', { pointerId: 1 });
    assert.equal(s.calls.clipRotate.at(-1).info.commit, true);
    assert.equal(s.calls.clipBox.length, 0, 'a rotation is not a box edit');
  } finally {
    s.cleanup();
  }
});

test('arrow keys nudge the selected clip, and a press on nothing clears it', () => {
  const clip = clipFixture();
  const s = setup({ clips: [clip] });
  // What `main.js` does with a published box, so the second nudge starts from where the first one ended
  // rather than from the fixture: an overlay that nudged from a stale box would double the step.
  const applied = () => {
    const box = s.lastBox();
    if (box) clip.box = box;
  };
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointerup', { pointerId: 1 });
    s.win.emit('keydown', { key: 'ArrowRight', target: {}, preventDefault() {} });
    const nudged = s.lastBox();
    assert.ok(Math.abs(nudged.x - (0.25 + DEFAULT_NUDGE_STEP)) < 1e-9, `one step right: ${nudged.x}`);
    assert.equal(nudged.w, 0.5, 'and a nudge is a move');
    assert.equal(s.calls.clipBox.at(-1).info.keyboard, true);
    applied();

    s.win.emit('keydown', { key: 'ArrowRight', shiftKey: true, target: {}, preventDefault() {} });
    assert.ok(
      Math.abs(s.lastBox().x - (0.25 + DEFAULT_NUDGE_STEP * (NUDGE_MULTIPLIER + 1))) < 1e-9,
      `shift nudges further: ${s.lastBox().x}`,
    );
    applied();

    s.overlayEl.emit('pointerdown', { ...s.at(10, 10), pointerId: 1, preventDefault() {} });
    assert.equal(s.overlay.selectedClipId, null, 'a press on empty frame selects nothing');
    assert.equal(s.calls.clipSelect.at(-1), null, 'and says so');
    const before = s.calls.clipBox.length;
    s.win.emit('keydown', { key: 'ArrowRight', target: {}, preventDefault() {} });
    assert.equal(s.calls.clipBox.length, before, 'with nothing selected, arrow keys edit nothing');
  } finally {
    s.cleanup();
  }
});

test('the cursor says what a press would do over a handle, a clip or nothing', () => {
  const s = setup({ clips: [clipFixture()] });
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    s.overlayEl.emit('pointerup', { pointerId: 1 });
    s.overlayEl.emit('pointermove', { ...s.at(CLIP_SE.x, CLIP_SE.y), pointerId: 1 });
    assert.equal(s.overlayEl.style.cursor, 'nwse-resize');
    s.overlayEl.emit('pointermove', { ...s.at(CLIP_GRIP.x, CLIP_GRIP.y), pointerId: 1 });
    assert.equal(s.overlayEl.style.cursor, 'grab', 'the turn handle');
    s.overlayEl.emit('pointermove', { ...s.at(640, 360), pointerId: 1 });
    assert.equal(s.overlayEl.style.cursor, 'move', 'the body');
    s.overlayEl.emit('pointermove', { ...s.at(10, 10), pointerId: 1 });
    assert.equal(s.overlayEl.style.cursor, '', 'and nothing at all over the bare frame');
  } finally {
    s.cleanup();
  }
});

test('selecting a caption and selecting a clip are exclusive, whichever way each is chosen', () => {
  const s = setup({ clips: [clipFixture()] });
  try {
    s.overlayEl.emit('pointerdown', { ...s.at(450, 540), pointerId: 1, preventDefault() {} });
    assert.equal(s.overlay.selectedId, 'b1');
    s.overlayEl.emit('pointerdown', { ...s.at(640, 360), pointerId: 1, preventDefault() {} });
    assert.equal(s.overlay.selectedId, null, 'a clip press released the caption');
    assert.deepEqual(s.calls.select.at(-1), null);

    s.overlay.select('b1');
    assert.equal(s.overlay.selectedClipId, null, 'and selecting a caption releases the clip');
    assert.equal(s.calls.clipSelect.at(-1), null);
  } finally {
    s.cleanup();
  }
});
