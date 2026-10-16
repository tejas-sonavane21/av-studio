/**
 * media-placement.test.js — the geometry behind the overlay clip's handles.
 *
 * This is the file that makes "resize a rotated clip" a checked claim rather than something that was
 * looked at once in a browser. The two rules that matter most:
 *
 * 1. the corner *opposite* the one being dragged does not move — asserted in frame pixels, on a clip
 *    turned 90 degrees, which is where a screen-space implementation quietly drifts;
 * 2. a shape-locked resize changes both edges together, and an edge drag keeps the other axis centred.
 *
 * The fixture is a 1000×500 frame because every expected number can then be read off by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDLE_IDS,
  boxFromHandle,
  boxFromMove,
  boxWithAspect,
  beginClipGesture,
  clipPixels,
  clipQuad,
  cropFromHandle,
  describeTransform,
  handleCursor,
  handlePoints,
  handlePointsForRect,
  hitClip,
  hitHandle,
  hitRotateHandle,
  pointInClip,
  rotateHandlePoint,
  rotatePoint,
  rotateVector,
  rotationFromPointer,
  snapBox,
  snapRotation,
} from '../../src/render/media-placement.js';
import { MIN_BOX, MIN_CROP, normalizeClip } from '../../src/model/media.js';

const size = { width: 1000, height: 500 };

/** A clip whose box is 400×200 px at (100,100): x/y/w/h = 0.1/0.2/0.4/0.4. */
const box = { x: 0.1, y: 0.2, w: 0.4, h: 0.4 };
const clip = (over = {}) => normalizeClip({ id: 'c1', kind: 'image', start: 1, end: 4, box, ...over });

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);

/** The corner of a box, rotated about its own centre — what "the fixed corner did not move" means. */
function cornerOf(aBox, cornerIndex, rotation = 0) {
  const quad = clipQuad({ box: aBox, rotation }, size);
  return quad[cornerIndex];
}

// --------------------------------------------------------------------------- //
// vectors and boxes
// --------------------------------------------------------------------------- //

test('rotating a vector is clockwise, in screen axes', () => {
  const right = rotateVector({ x: 1, y: 0 }, 90);
  near(right.x, 0, 'east turns to south on the x axis');
  near(right.y, 1, 'east turns to south on the y axis');
  const point = rotatePoint({ x: 0, y: 0 }, { x: 200, y: 100 }, 180);
  near(point.x, 400, 'a half turn about (200,100)');
  near(point.y, 200, 'a half turn about (200,100)');
});

test('a box becomes pixels with its centre, and its corners follow the rotation', () => {
  const px = clipPixels({ box }, size);
  assert.deepEqual({ x: px.x, y: px.y, w: px.w, h: px.h }, { x: 100, y: 100, w: 400, h: 200 });
  assert.deepEqual({ cx: px.cx, cy: px.cy }, { cx: 300, cy: 200 });

  const quad = clipQuad({ box, rotation: 90 }, size);
  // A quarter turn clockwise: the top-left corner travels to the top-right, and the top-right to the
  // bottom-right, so the corners stay a ring of four — only their order on screen changes.
  near(quad[0].x, 400, 'top-left after 90 degrees');
  near(quad[0].y, 0, 'top-left after 90 degrees');
  near(quad[2].x, 200, 'bottom-right after 90 degrees');
  near(quad[2].y, 400, 'bottom-right after 90 degrees');
  near(quad[3].x, 200, 'bottom-left after 90 degrees');
  near(quad[3].y, 0, 'bottom-left after 90 degrees');
});

// --------------------------------------------------------------------------- //
// handles
// --------------------------------------------------------------------------- //

test('the eight handles sit on the box, and turn with it', () => {
  const points = handlePoints({ box, rotation: 0 }, size);
  assert.deepEqual(points.map((p) => p.id), [...HANDLE_IDS], 'clockwise from the top-left');
  const by = Object.fromEntries(points.map((p) => [p.id, p]));
  assert.deepEqual({ x: by.nw.x, y: by.nw.y }, { x: 100, y: 100 });
  assert.deepEqual({ x: by.se.x, y: by.se.y }, { x: 500, y: 300 });
  assert.deepEqual({ x: by.n.x, y: by.n.y }, { x: 300, y: 100 }, 'north is the top edge, centred');
  assert.deepEqual({ x: by.w.x, y: by.w.y }, { x: 100, y: 200 });

  const turned = Object.fromEntries(handlePoints({ box, rotation: 90 }, size).map((p) => [p.id, p]));
  near(turned.nw.x, 400, 'the top-left handle turned with the clip');
  near(turned.nw.y, 0, 'the top-left handle turned with the clip');
  near(turned.se.x, 200, 'and so did the one opposite it');
  near(turned.se.y, 400, 'and so did the one opposite it');
});

test('a handle wears the cursor of the screen direction it pushes in', () => {
  assert.equal(handleCursor('se', 0), 'nwse-resize');
  assert.equal(handleCursor('e', 0), 'ew-resize');
  assert.equal(handleCursor('n', 0), 'ns-resize');
  assert.equal(handleCursor('ne', 0), 'nesw-resize');
  // Turned 45 degrees, a corner handle points straight along an axis and the cursor says so.
  assert.equal(handleCursor('se', 45), 'ns-resize');
  assert.equal(handleCursor('e', 90), 'ns-resize', 'a quarter turn makes a side handle vertical');
  assert.equal(handleCursor('se', 90), 'nesw-resize');
});

test('the rotation handle sits above the top edge and turns with the clip', () => {
  const grip = rotateHandlePoint({ box, rotation: 0 }, size);
  assert.deepEqual({ x: grip.x, y: grip.y }, { x: 300, y: 100 - 26 });
  // A quarter turn takes the grip — which is 26 px above the top edge, i.e. 126 px above the centre —
  // round to the right of the box by the same distance.
  const turned = rotateHandlePoint({ box, rotation: 90 }, size);
  near(turned.x, 300 + 126, 'a quarter turn puts the grip to the right of the box');
  near(turned.y, 200, 'a quarter turn puts the grip to the right of the box');
});

test('the nearest handle within reach wins, and only within reach', () => {
  const points = handlePoints({ box, rotation: 0 }, size);
  assert.equal(hitHandle({ x: 102, y: 103 }, points).id, 'nw', 'a couple of pixels off is still a grab');
  assert.equal(hitHandle({ x: 104, y: 104 }, points, { radius: 0 }), null, 'nothing at zero reach');
  assert.equal(hitHandle({ x: 100, y: 100 }, points, { radius: 0 }).id, 'nw', 'exactly on it is on it');
  assert.equal(hitHandle({ x: 300, y: 200 }, points), null, 'the middle of the box is not a handle');
  assert.equal(hitHandle(null, points), null);
  assert.equal(hitHandle({ x: 100, y: 100 }, null), null);
  assert.equal(hitRotateHandle({ x: 300, y: 74 }, { box, rotation: 0 }, size), true);
  assert.equal(hitRotateHandle({ x: 300, y: 200 }, { box, rotation: 0 }, size), false);
});

test('a point is inside the box by the box, not by the pixels it paints', () => {
  // The letterbox a `contain` fit leaves is still part of the clip: a thin logo must not be a target
  // measured in its own painted pixels.
  assert.equal(pointInClip({ x: 101, y: 101 }, { box, rotation: 0 }, size), true);
  assert.equal(pointInClip({ x: 99, y: 101 }, { box, rotation: 0 }, size), false);
  assert.equal(pointInClip({ x: 99, y: 101 }, { box, rotation: 0 }, size, { padding: 2 }), true);
  // A quarter turn moves the corner the hit test is made against.
  assert.equal(pointInClip({ x: 400, y: 0 }, { box, rotation: 90 }, size), true, 'a turned corner is the box');
  assert.equal(pointInClip({ x: 350, y: 150 }, { box, rotation: 90 }, size), true);
  assert.equal(pointInClip({ x: 100, y: 100 }, { box, rotation: 90 }, size), false, 'but the middle of where it used to be is not');
});

test('the topmost clip is the one a press lands on', () => {
  const under = clip({ id: 'under', box: { x: 0, y: 0, w: 1, h: 1 } });
  const over = clip({ id: 'over', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } });
  assert.equal(hitClip({ x: 450, y: 210 }, [under, over], size).id, 'over', 'later clips paint on top');
  assert.equal(hitClip({ x: 10, y: 10 }, [under, over], size).id, 'under');
  assert.equal(hitClip({ x: 10, y: 10 }, [], size), null);
});

test('a press starts the gesture the pointer is actually on', () => {
  const c = clip();
  assert.deepEqual(beginClipGesture({ point: { x: 500, y: 300 }, clip: c, size, clips: [c] }), {
    mode: 'resize',
    clipId: 'c1',
    handle: 'se',
    rotation: 0,
  });
  assert.equal(beginClipGesture({ point: { x: 300, y: 200 }, clip: c, size, clips: [c] }).mode, 'move');
  assert.equal(beginClipGesture({ point: { x: 300, y: 74 }, clip: c, size, clips: [c] }).mode, 'rotate');
  assert.equal(beginClipGesture({ point: { x: 10, y: 10 }, clip: c, size, clips: [c] }), null);
  // A handle of a clip that is *not* selected is not a handle: the press starts a move on whatever is
  // under it instead, which is how a second clip is picked up in one gesture.
  const other = clip({ id: 'c2', box: { x: 0, y: 0, w: 0.1, h: 0.1 } });
  const gesture = beginClipGesture({ point: { x: 100, y: 50 }, clip: c, size, clips: [other, c] });
  assert.deepEqual({ mode: gesture.mode, clipId: gesture.clipId }, { mode: 'move', clipId: 'c2' });
});

// --------------------------------------------------------------------------- //
// moving
// --------------------------------------------------------------------------- //

test('dragging the body moves the box by the pointer delta and leaves the size alone', () => {
  const moved = boxFromMove({ startBox: box, startPoint: { x: 100, y: 100 }, point: { x: 150, y: 120 }, size });
  near(moved.x, 0.15, 'x follows the pointer');
  near(moved.y, 0.24, 'y follows the pointer');
  near(moved.w, box.w, 'the width is untouched');
  near(moved.h, box.h, 'the height is untouched');

  const beyond = boxFromMove({ startBox: box, startPoint: { x: 100, y: 100 }, point: { x: 5000, y: 5000 }, size });
  near(beyond.x, 1 - box.w, 'and it cannot be dragged out of the frame');
  near(beyond.y, 1 - box.h, 'and it cannot be dragged out of the frame');
});

// --------------------------------------------------------------------------- //
// resizing
// --------------------------------------------------------------------------- //

test('a corner handle moves two edges and pins the corner opposite', () => {
  const grown = boxFromHandle({ handle: 'se', startBox: box, point: { x: 600, y: 350 }, size });
  near(grown.box.x, 0.1, 'the top-left corner did not move');
  near(grown.box.y, 0.2);
  near(grown.box.w, 0.5, 'the right edge followed the pointer');
  near(grown.box.h, 0.5, 'the bottom edge followed the pointer');

  const shrunk = boxFromHandle({ handle: 'nw', startBox: box, point: { x: 200, y: 150 }, size });
  near(shrunk.box.x, 0.2);
  near(shrunk.box.y, 0.3);
  near(shrunk.box.w, 0.3);
  near(shrunk.box.h, 0.3);
  near(cornerOf(shrunk.box, 2).x, 500, 'the south-east corner stayed at (500,300)');
  near(cornerOf(shrunk.box, 2).y, 300);
});

test('an edge handle moves one edge and leaves the other axis exactly where it was', () => {
  const wider = boxFromHandle({ handle: 'e', startBox: box, point: { x: 700, y: 999 }, size });
  near(wider.box.x, 0.1, 'the left edge is pinned');
  near(wider.box.y, 0.2, 'and the vertical placement is untouched');
  near(wider.box.w, 0.6);
  near(wider.box.h, 0.4);

  const shorter = boxFromHandle({ handle: 'n', startBox: box, point: { x: 999, y: 150 }, size });
  near(shorter.box.x, 0.1, 'a top-edge drag does not move the box sideways');
  near(shorter.box.y, 0.3);
  near(shorter.box.h, 0.3);
  near(shorter.box.w, 0.4);
});

test('a box cannot be resized inside out, whatever the pointer does', () => {
  const squashed = boxFromHandle({ handle: 'se', startBox: box, point: { x: -900, y: -900 }, size });
  near(squashed.box.w, MIN_BOX, 'the floor is the model\'s own minimum');
  near(squashed.box.h, MIN_BOX, 'the floor is the model\'s own minimum');
  near(squashed.box.x, 0.1, 'and the pinned corner is still pinned');
  near(squashed.box.y, 0.2);
});

test('a shape-locked corner holds the picture ratio, growing the short edge', () => {
  // The drag asks for 500×200 px (ratio 2.5) on a picture that is 2:1: the height gives way, so the
  // box takes the *larger* of the two readings and the ratio survives.
  const locked = boxFromHandle({
    handle: 'se',
    startBox: box,
    point: { x: 600, y: 300 },
    size,
    keepAspect: true,
    aspect: 2,
  });
  near(locked.box.w, 0.5);
  near(locked.box.h, 0.5, 'the height was derived from the width');
  near(locked.box.x, 0.1, 'and the pinned corner is still pinned');
  near(locked.box.y, 0.2);
  near((locked.box.w * size.width) / (locked.box.h * size.height), 2, 'the pixel ratio is held');
});

test('a shape-locked edge drag keeps the other axis centred', () => {
  const wider = boxFromHandle({
    handle: 'e',
    startBox: box,
    point: { x: 600, y: 999 },
    size,
    keepAspect: true,
    aspect: 2,
  });
  near(wider.box.w, 0.5);
  near(wider.box.h, 0.5);
  const centreBefore = box.y + box.h / 2;
  const centreAfter = wider.box.y + wider.box.h / 2;
  near(centreAfter, centreBefore, 'the box grew around its own vertical centre');
});

test('a resize on a turned clip pins the opposite corner in frame space', () => {
  // The clip is 90 degrees round, so the frame is not the box's own frame — which is exactly where a
  // screen-space implementation drags the wrong corner.
  const turned = { box, rotation: 90 };
  const fixedBefore = cornerOf(box, 0, 90); // the handle opposite a 'se' drag
  const resized = boxFromHandle({ handle: 'se', startBox: box, point: { x: 500, y: 300 }, size, rotation: 90 });
  const fixedAfter = cornerOf(resized.box, 0, 90);
  near(fixedAfter.x, fixedBefore.x, 'the pinned corner did not move in x');
  near(fixedAfter.y, fixedBefore.y, 'the pinned corner did not move in y');
  // The pointer was 100 px right and 300 px down of the local origin, which in the clip's turned frame
  // is 300 px along its width and 100 px *behind* its top edge — so the height floors at the minimum.
  near(resized.box.w, 0.3, 'the width followed the pointer in the clip\'s own frame');
  near(resized.box.h, MIN_BOX, 'and a pointer above the top edge cannot make a negative height');
});

test('a resize with no size to work from still answers a usable box', () => {
  const orphan = boxFromHandle({ handle: 'nonsense', startBox: box, point: { x: 1, y: 1 }, size });
  assert.deepEqual(orphan.box, { ...box }, 'an unknown handle is not an edit');
  const degenerate = boxFromHandle({ handle: 'se', startBox: box, point: { x: 1, y: 1 }, size: null });
  assert.ok(degenerate.box.w >= MIN_BOX && Number.isFinite(degenerate.box.x));
});

// --------------------------------------------------------------------------- //
// snapping
// --------------------------------------------------------------------------- //

test('a dragged box snaps its nearest edge to a guide, per axis', () => {
  const targets = {
    x: [{ value: 500, kind: 'center', label: 'centre' }],
    y: [{ value: 250, kind: 'center', label: 'centre' }],
  };
  const nearCentre = { x: 0.465, y: 0.19, w: 0.04, h: 0.04 };
  const snapped = snapBox(nearCentre, { targets, size, tolerance: 8 });
  // The left edge is 465, the centre 485 and the right 505 — the centre's 15 px miss loses to the right
  // edge's 5 px one, so the *right* edge wins the axis and the box lands at 460.
  assert.equal(snapped.snappedX.edge, 'right', 'the nearest edge wins, not the first one tested');
  near(snapped.box.x, 0.46, 'the winning edge landed exactly on the guide');
  near(snapped.box.y, 0.19, 'the other axis had nothing in reach');
  assert.equal(snapped.snappedY, null, 'no guide, no line to draw');

  const already = snapBox({ x: 0.46, y: 0.48, w: 0.04, h: 0.04 }, { targets, size, tolerance: 8 });
  near(already.box.y, 0.48, 'a box whose middle is on the guide stays put');
  assert.equal(already.snappedY.edge, 'middle');
});

test('nothing in reach means nothing moves', () => {
  const box2 = { x: 0.05, y: 0.05, w: 0.1, h: 0.1 };
  const out = snapBox(box2, { targets: { x: [{ value: 500, kind: 'center' }], y: [] }, size, tolerance: 8 });
  assert.deepEqual(out.box, box2);
  assert.equal(out.snappedX, null);
});

// --------------------------------------------------------------------------- //
// rotating
// --------------------------------------------------------------------------- //

test('the angle a drag asks for is relative to where the gesture started', () => {
  const centre = { x: 300, y: 200 };
  const quarter = rotationFromPointer({ centre, from: { x: 300, y: 0 }, to: { x: 500, y: 200 }, startRotation: 0 });
  near(quarter, 90, 'from north to east is a quarter turn clockwise');
  const fromTurned = rotationFromPointer({ centre, from: { x: 300, y: 0 }, to: { x: 500, y: 200 }, startRotation: 30 });
  near(fromTurned, 120, 'a clip that is already turned keeps what it had');
  // Across the seam: a degree at 180 goes to a degree over 180, which is stored as -179, and the drag
  // has to read that as +1 rather than as a three-quarter turn the other way.
  const at = (deg) => ({ x: centre.x + 100 * Math.cos((deg * Math.PI) / 180), y: centre.y + 100 * Math.sin((deg * Math.PI) / 180) });
  const seam = rotationFromPointer({ centre, from: at(179.5), to: at(180.5), startRotation: 0 });
  assert.ok(Math.abs(seam - 1) < 1e-6, `a degree across the seam is one degree, not 359: got ${seam}`);
  assert.equal(rotationFromPointer({}), 0, 'a missing pointer is not a rotation');
});

test('an angle snaps to a step when it is near one, and takes it when told to', () => {
  assert.equal(snapRotation(47).degrees, 45, 'two degrees off is close enough');
  assert.equal(snapRotation(47).snapped, 45);
  assert.equal(snapRotation(47, { tolerance: 1 }).degrees, 47, 'out of reach, the angle passes through');
  assert.equal(snapRotation(47, { tolerance: 1 }).snapped, null);
  assert.equal(snapRotation(47, { force: true }).degrees, 45, 'shift takes the step however far it is');
  assert.equal(snapRotation(0).degrees, 0, 'upright is exact');
  assert.equal(snapRotation(179).degrees, 180, 'and the half turn is stored as +180, never -180');
  assert.equal(snapRotation(-90, { force: true }).degrees, -90);
});

test('a box can be rebuilt to a pixel ratio around its own centre', () => {
  const wide = boxWithAspect({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, 4, size, { driver: 'w' });
  near(wide.w, 0.5, 'the edge the user moved is kept');
  near(wide.h, 0.25, 'and the other edge is derived from it');
  near(wide.y, 0.075, 'the box grew around its own centre');
  const tall = boxWithAspect({ x: 0.1, y: 0.1, w: 0.5, h: 0.2 }, 4, size, { driver: 'h' });
  near(tall.h, 0.2);
  near(tall.w, 0.4);
  near(tall.x, 0.15);
  assert.deepEqual(boxWithAspect(box, 0, size), box, 'a ratio of zero is not a shape to hold');
});

test('the transform is described in the terms the panel shows', () => {
  assert.equal(describeTransform({ box, rotation: 0, fit: 'contain', opacity: 1 }), '40%×40% at 10%, 20%');
  assert.equal(
    describeTransform({ box, rotation: 45, flipX: true, fit: 'stretch', opacity: 0.5 }),
    '40%×40% at 10%, 20% · 45° · flipped x · stretch · 50% opaque',
  );
  assert.equal(describeTransform({}), '—');
});

// --------------------------------------------------------------------------- //
// cropping: cutting the picture, not the box
// --------------------------------------------------------------------------- //

test('a crop handle cuts the sides it is dragged, and leaves the others where they are', () => {
  // The crop frame is the whole picture, drawn into the clip's box: 200 px wide and 200 px tall here, at
  // (100, 50) — so every expected fraction below is a plain division.
  const startRect = { x: 100, y: 50, w: 200, h: 200 };
  const full = { x: 0, y: 0, w: 1, h: 1 };

  // The right handle dragged halfway in: half the file's width is left, from the left edge.
  assert.deepEqual(
    cropFromHandle({ handle: 'e', startCrop: full, startRect, point: { x: 200, y: 150 } }),
    { x: 0, y: 0, w: 0.5, h: 1 },
  );
  // The left handle: the same half, but it is the *right* half of the file that survives.
  assert.deepEqual(
    cropFromHandle({ handle: 'w', startCrop: full, startRect, point: { x: 200, y: 150 } }),
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  );
  // The bottom handle dragged halfway up the frame, which is the frame's own middle (y 50 to 250).
  assert.deepEqual(
    cropFromHandle({ handle: 's', startCrop: full, startRect, point: { x: 200, y: 150 } }),
    { x: 0, y: 0, w: 1, h: 0.5 },
  );
  // A corner does both axes at once: half the width, and three quarters of the height.
  assert.deepEqual(
    cropFromHandle({ handle: 'se', startCrop: full, startRect, point: { x: 200, y: 200 } }),
    { x: 0, y: 0, w: 0.5, h: 0.75 },
  );

  // Dragging *outwards* past the whole picture is not a crop of more than the file: it clamps there.
  assert.deepEqual(
    cropFromHandle({ handle: 'e', startCrop: full, startRect, point: { x: 999, y: 150 } }),
    { x: 0, y: 0, w: 1, h: 1 },
  );
  // And inwards past the floor stops at the smallest crop rather than at zero.
  const squeezed = cropFromHandle({ handle: 'e', startCrop: full, startRect, point: { x: 0, y: 150 } });
  assert.equal(squeezed.w, MIN_CROP);
});

test('a crop is applied to what is left, so a second cut is a cut of the picture it left', () => {
  const startRect = { x: 0, y: 0, w: 100, h: 100 };
  // Already showing the right half of the file; cutting half of that leaves a quarter, starting three
  // quarters of the way across the file.
  assert.deepEqual(
    cropFromHandle({ handle: 'e', startCrop: { x: 0.5, y: 0, w: 0.5, h: 1 }, startRect, point: { x: 50, y: 50 } }),
    { x: 0.5, y: 0, w: 0.25, h: 1 },
  );
  // Dragging the *left* edge of that same half keeps its right edge fixed.
  assert.deepEqual(
    cropFromHandle({ handle: 'w', startCrop: { x: 0.5, y: 0, w: 0.5, h: 1 }, startRect, point: { x: 50, y: 50 } }),
    { x: 0.75, y: 0, w: 0.25, h: 1 },
  );
});

test('a crop handle on a turned clip cuts the edge that is under the pointer', () => {
  // The frame turned a quarter turn about its centre: its right edge now lies along the *bottom* of the
  // screen, and its top edge along the right. A pointer 20 px below the frame's middle is therefore 70% of
  // the way across the picture, which is what the right handle cuts. Without the rotation in the maths this
  // would cut the wrong axis, and the cut would look like it ignored the drag.
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(
    cropFromHandle({ handle: 'e', startCrop: { x: 0, y: 0, w: 1, h: 1 }, startRect: rect, point: { x: 50, y: 70 }, rotation: 90 }),
    { x: 0, y: 0, w: 0.7, h: 1 },
  );
});

test('a crop with no frame to cut (an offline clip) changes nothing', () => {
  assert.deepEqual(cropFromHandle({ handle: 'e', startCrop: { x: 0.2, y: 0, w: 0.5, h: 1 } }), { x: 0.2, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(cropFromHandle({}), { x: 0, y: 0, w: 1, h: 1 });
});

test('the transform line says what is left of the file, not what was cut off it', () => {
  assert.equal(
    describeTransform({ box: { x: 0, y: 0, w: 0.5, h: 0.5 }, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }),
    '50%×50% at 0%, 0% · cropped to 50%×100%',
  );
  assert.equal(describeTransform({ box: { x: 0, y: 0, w: 0.5, h: 0.5 } }), '50%×50% at 0%, 0%', 'nothing to say when nothing is cut');
});
