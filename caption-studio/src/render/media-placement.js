/**
 * render/media-placement.js — where an overlay clip's box and its handles are, and what a drag on one
 * of them means.
 *
 * The same split the caption layer has, for the same reason: **pure geometry here, pointer events in
 * `editor/canvas-overlay.js`**. Every rule a drag depends on — which handle was grabbed, how far a box
 * may be squeezed, what "keep the shape" does to a corner under a rotation, where an angle snaps — is
 * decided in this file, so it is unit-tested in Node rather than looked at in a browser.
 *
 * ## The three gestures
 *
 * | gesture | what it changes |
 * |---|---|
 * | drag the body | the box's position on the frame, size untouched |
 * | drag one of the eight handles | one or two edges of the box — the opposite edge stays where it is |
 * | drag the round handle above the top edge | the clip's rotation, about the box's own centre |
 *
 * ## Rotation, and why the maths looks like this
 *
 * A clip's box is always **axis-aligned in its own frame**, and the media inside it is rotated as it is
 * drawn. So a resize is solved in the clip's own frame — the pointer is rotated back by the clip's angle,
 * the grabbed edges move there, and the result is rotated forward again about the corner that was left
 * fixed. Solving it in screen space instead would make a handle on a rotated clip pull the box sideways
 * and change two edges at once, which is the bug this file exists to not have.
 *
 * Handles are corner-to-corner squares pinned to the box, drawn by the overlay from `handlePoints()` and
 * hit-tested against the very same points, so what is on screen and what is grabbable cannot drift.
 */

import { MIN_BOX, boxRect, normalizeBox, normalizeRotation } from '../model/media.js';
import { snapValue } from './placement.js';
import { clamp, isPlainObject } from '../util/math.js';

/** The eight resize handles, clockwise from the top-left, as the ids the overlay draws and hit-tests. */
export const HANDLE_IDS = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

/** The side of a drawn handle, in logical pixels. */
export const HANDLE_SIDE_PX = 9;

/** How close a pointer has to be to a handle's centre to grab it, in logical pixels. */
export const HANDLE_HIT_PX = 10;

/** How far above the box's top edge the round rotation handle sits, in logical pixels. */
export const ROTATE_HANDLE_GAP_PX = 26;

/** How close a pointer has to be to the rotation handle's centre, in logical pixels. */
export const ROTATE_HANDLE_HIT_PX = 13;

/** Rotation snaps to multiples of this, in degrees, when it is near one. */
export const ROTATE_SNAP_STEP = 15;

/** How near is "near", in degrees. Wide enough to catch a hand, narrow enough to pass. */
export const ROTATE_SNAP_TOLERANCE = 4;

/** Default snap distance for a box drag, in logical pixels — the same feel as a caption drag. */
export const DEFAULT_BOX_SNAP_PX = 8;

/**
 * How far outside its edges a rotated box still counts as hit. A hair, for arithmetic rather than for
 * fingers: rotating a corner back into the box's frame lands a few parts in 10^15 off the edge, and a
 * corner of a turned clip that measures "just outside" is a corner that cannot be grabbed.
 */
const EDGE_EPSILON = 1e-6;

/** Where each handle sits in the box's own frame: -1, 0 or 1 per axis. */
const AXES = Object.freeze({
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
});

/** The four cursors a resize handle can wear, by the direction it points. */
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];

// --------------------------------------------------------------------------- //
// vectors and points
// --------------------------------------------------------------------------- //

/** Rotate a vector by `degrees` clockwise (screen axes: x right, y down). Pure. */
export function rotateVector(vector, degrees) {
  const radians = ((Number(degrees) || 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = Number(vector?.x) || 0;
  const y = Number(vector?.y) || 0;
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Rotate a point about a centre. Pure. */
export function rotatePoint(point, centre, degrees) {
  const turned = rotateVector({ x: (point?.x ?? 0) - (centre?.x ?? 0), y: (point?.y ?? 0) - (centre?.y ?? 0) }, degrees);
  return { x: (centre?.x ?? 0) + turned.x, y: (centre?.y ?? 0) + turned.y };
}

// --------------------------------------------------------------------------- //
// the box, in pixels
// --------------------------------------------------------------------------- //

/** A clip's box as a pixel rect with its centre, which every other function here works from. Pure. */
export function clipPixels(clip, size) {
  const rect = boxRect(clip?.box, size);
  return {
    x: rect.x,
    y: rect.y,
    w: rect.width,
    h: rect.height,
    cx: rect.x + rect.width / 2,
    cy: rect.y + rect.height / 2,
  };
}

/** The box's four corners, rotated with the clip. Clockwise from the top-left. Pure. */
export function clipQuad(clip, size) {
  const r = clipPixels(clip, size);
  const centre = { x: r.cx, y: r.cy };
  const rotation = Number(clip?.rotation) || 0;
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((corner) => rotatePoint(corner, centre, rotation));
}

/**
 * Where the eight resize handles are, in logical pixels, already rotated with the clip. Pure.
 *
 * One function for drawing and for hit-testing: the overlay paints squares at these points and grabs
 * whichever one the pointer is nearest, so a handle can never be drawn somewhere it cannot be grabbed.
 */
export function handlePoints(clip, size) {
  const r = clipPixels(clip, size);
  const centre = { x: r.cx, y: r.cy };
  const rotation = Number(clip?.rotation) || 0;
  return HANDLE_IDS.map((id) => {
    const [ax, ay] = AXES[id];
    const corner = { x: r.x + (r.w * (ax + 1)) / 2, y: r.y + (r.h * (ay + 1)) / 2 };
    const point = rotatePoint(corner, centre, rotation);
    return {
      id,
      ax,
      ay,
      x: point.x,
      y: point.y,
      // The cursor follows the *screen* direction of the handle, so a clip turned 90 degrees grows a
      // cursor that turns with it.
      cursor: handleCursor(id, rotation),
    };
  });
}

/**
 * The cursor a handle should wear, given how far the clip has been turned.
 *
 * The direction a handle pushes a box in is a multiple of 45 degrees from east, and it rotates with the
 * clip: the `se` handle points south-east (45) unturned, south at a quarter turn clockwise. Rounding to
 * the nearest of the four cursor directions is what keeps this honest on a diagonal clip, where no
 * cursor is exactly right and the nearest one is still the more useful answer.
 */
export function handleCursor(id, rotation = 0) {
  const [ax, ay] = AXES[id] ?? [0, 0];
  if (!ax && !ay) return 'default';
  const local = (Math.atan2(ay, ax) * 180) / Math.PI;
  const turned = ((local + (Number(rotation) || 0)) % 180 + 180) % 180;
  return RESIZE_CURSORS[Math.round(turned / 45) % 4];
}

/** The round rotation handle: above the box's top edge, rotated with the clip. Pure. */
export function rotateHandlePoint(clip, size, { gap = ROTATE_HANDLE_GAP_PX } = {}) {
  const r = clipPixels(clip, size);
  const above = { x: r.cx, y: r.y - gap };
  return rotatePoint(above, { x: r.cx, y: r.cy }, Number(clip?.rotation) || 0);
}

/** The point on the top edge the rotation handle's stem is drawn to. Pure. */
export function rotateStemPoint(clip, size) {
  const r = clipPixels(clip, size);
  return rotatePoint({ x: r.cx, y: r.y }, { x: r.cx, y: r.cy }, Number(clip?.rotation) || 0);
}

/**
 * Which handle is under `point`, or `null`. Nearest wins, and only within `radius`. Pure.
 *
 * `handles` is what `handlePoints()` returned, so a caller that passes a stale set of points is asking
 * about a box that no longer exists — which is exactly why the overlay rebuilds them per event.
 */
export function hitHandle(point, handles, { radius = HANDLE_HIT_PX } = {}) {
  if (!point || !Array.isArray(handles)) return null;
  let best = null;
  for (const handle of handles) {
    const d = Math.hypot(handle.x - point.x, handle.y - point.y);
    if (d <= radius && (!best || d < best.d)) best = { ...handle, d };
  }
  return best;
}

/** Whether the rotation handle is under `point`, within `radius`. Pure. */
export function hitRotateHandle(point, clip, size, { radius = ROTATE_HANDLE_HIT_PX, gap = ROTATE_HANDLE_GAP_PX } = {}) {
  if (!point) return false;
  const handle = rotateHandlePoint(clip, size, { gap });
  return Math.hypot(handle.x - point.x, handle.y - point.y) <= radius;
}

/**
 * Whether `point` is inside the clip's box — **rotated**, and with a little slop. Pure.
 *
 * The *box* is what is tested, not the drawn picture. A letterboxed clip has empty space inside its box,
 * and making that space dead would mean a picture could only be grabbed by the pixels it happens to
 * paint, which on a thin logo is a target a few pixels wide.
 */
export function pointInClip(point, clip, size, { padding = 0 } = {}) {
  if (!point || !clip) return false;
  const r = clipPixels(clip, size);
  if (!(r.w > 0 && r.h > 0)) return false;
  const local = rotatePoint(point, { x: r.cx, y: r.cy }, -(Number(clip.rotation) || 0));
  // An edge counts as inside, with a tolerance for the arithmetic: rotating a point on a corner back
  // into the box's frame lands within a few parts in 10^15 of the edge, and a corner of a turned clip
  // that is "a hair outside" is a corner that cannot be pressed.
  const eps = EDGE_EPSILON;
  return (
    local.x >= r.x - padding - eps &&
    local.x <= r.x + r.w + padding + eps &&
    local.y >= r.y - padding - eps &&
    local.y <= r.y + r.h + padding + eps
  );
}

/** The topmost clip under `point` — later clips paint over earlier ones, so the search runs backwards. */
export function hitClip(point, clips, size, options = {}) {
  if (!point || !Array.isArray(clips)) return null;
  for (let i = clips.length - 1; i >= 0; i--) {
    if (clips[i] && pointInClip(point, clips[i], size, options)) return clips[i];
  }
  return null;
}

// --------------------------------------------------------------------------- //
// dragging
// --------------------------------------------------------------------------- //

/**
 * A box moved by dragging its body: the same size, a new position.
 *
 * The grab offset is *not* re-derived from the clip's centre — the caller measures the pointer against
 * where the gesture started, which is what keeps the clip under the cursor instead of jumping so its
 * centre meets it.
 */
export function boxFromMove({ startBox, startPoint, point, size } = {}) {
  const box = normalizeBox(startBox);
  const w = Math.max(1, Number(size?.width) || 0);
  const h = Math.max(1, Number(size?.height) || 0);
  return normalizeBox({
    x: box.x + ((point?.x ?? 0) - (startPoint?.x ?? 0)) / w,
    y: box.y + ((point?.y ?? 0) - (startPoint?.y ?? 0)) / h,
    w: box.w,
    h: box.h,
  });
}

/**
 * A box resized by dragging one handle, solved in the clip's own frame (see the module note). Pure.
 *
 * @param {object} options
 * @param {string} options.handle        one of `HANDLE_IDS`
 * @param {object} options.startBox      the box the gesture began with, in fractions
 * @param {object} options.point         the pointer now, in logical pixels
 * @param {{width:number,height:number}} options.size  the frame
 * @param {number} [options.rotation]    the clip's rotation, in degrees
 * @param {boolean} [options.keepAspect] hold the shape (shift, or the panel's lock)
 * @param {number} [options.aspect]      the pixel ratio to hold when `keepAspect` — `w / h`
 * @returns {{box: object, size: {width:number,height:number}}}
 */
export function boxFromHandle({
  handle,
  startBox,
  point,
  size,
  rotation = 0,
  keepAspect = false,
  aspect = 0,
} = {}) {
  const axes = AXES[handle];
  const box = normalizeBox(startBox);
  const frameW = Math.max(1, Number(size?.width) || 0);
  const frameH = Math.max(1, Number(size?.height) || 0);
  if (!axes) return { box, size: { width: box.w * frameW, height: box.h * frameH } };

  const start = clipPixels({ box }, size);
  // The frame position of the clip's own top-left corner, so a pointer can be expressed in the clip's
  // frame as a plain vector.
  const origin = {
    x: start.cx - rotateVector({ x: start.w / 2, y: start.h / 2 }, rotation).x,
    y: start.cy - rotateVector({ x: start.w / 2, y: start.h / 2 }, rotation).y,
  };
  const toLocal = (p) => rotateVector({ x: (p?.x ?? 0) - origin.x, y: (p?.y ?? 0) - origin.y }, -rotation);
  const toFrame = (v) => {
    const turned = rotateVector(v, rotation);
    return { x: origin.x + turned.x, y: origin.y + turned.y };
  };

  const minW = Math.max(1, MIN_BOX * frameW);
  const minH = Math.max(1, MIN_BOX * frameH);
  const local = toLocal(point);
  const [ax, ay] = axes;

  // The grabbed edges follow the pointer; every other edge stays exactly where it was, which is what
  // makes the opposite corner feel pinned.
  let l = 0;
  let t = 0;
  let r = start.w;
  let b = start.h;
  if (ax < 0) l = Math.min(local.x, r - minW);
  if (ax > 0) r = Math.max(local.x, l + minW);
  if (ay < 0) t = Math.min(local.y, b - minH);
  if (ay > 0) b = Math.max(local.y, t + minH);

  if (keepAspect && Number(aspect) > 0) {
    const horizontal = ax !== 0;
    const vertical = ay !== 0;
    if (horizontal && vertical) {
      // A corner: the box follows whichever axis the pointer pushed further, and stays anchored on the
      // corner diagonally opposite the one being dragged.
      let w = r - l;
      let h = b - t;
      if (w / aspect >= h) h = w / aspect;
      else w = h * aspect;
      // A shape-locked box can be squeezed below the floor on one axis by a locked ratio, so the pair is
      // scaled back up together: the ratio is the invariant, the size is not.
      const up = Math.max(1, minW / w, minH / h);
      w *= up;
      h *= up;
      // Held on the corner the handle is *not* on: the two edges this drag is not moving stay exactly
      // where they were, and the box grows out of them at the locked ratio. Anchoring the dragged edges
      // on the pointer instead would slide the box off its own far corner — the one thing a resize
      // promises never to do.
      if (ax > 0) r = l + w;
      else l = r - w;
      if (ay > 0) b = t + h;
      else t = b - h;
    } else if (horizontal) {
      // An edge handle changes one side of the box, so the *other* axis keeps its centre rather than
      // growing away from one edge: a width drag that also slid the whole clip down would read as a move.
      const w = r - l;
      const h = Math.max(minH, w / aspect);
      t = start.h / 2 - h / 2;
      b = t + h;
    } else {
      const h = b - t;
      const w = Math.max(minW, h * aspect);
      l = start.w / 2 - w / 2;
      r = l + w;
    }
  }

  const centre = toFrame({ x: (l + r) / 2, y: (t + b) / 2 });
  const width = r - l;
  const height = b - t;
  return {
    box: normalizeBox({
      x: (centre.x - width / 2) / frameW,
      y: (centre.y - height / 2) / frameH,
      w: width / frameW,
      h: height / frameH,
    }),
    size: { width, height },
  };
}

/**
 * A box rebuilt to a given **pixel** ratio, keeping its centre. Pure.
 *
 * This is the panel's shape lock: a slider changes one edge, and this answers what the other edge has to
 * be for the picture to keep its own proportions. `driver` is the edge the user moved ('w' or 'h'), and
 * the *other* one is derived from it, so a width slider and a height slider hold the same shape without
 * either of them being the authority. A ratio that cannot fit the frame is clamped by `normalizeBox`
 * like any other box, which is the honest outcome — the frame's edge wins over a shape.
 */
export function boxWithAspect(box, aspect, size, { driver = 'w' } = {}) {
  const start = normalizeBox(box);
  const frameW = Math.max(1, Number(size?.width) || 0);
  const frameH = Math.max(1, Number(size?.height) || 0);
  const ratio = Number(aspect);
  if (!(ratio > 0)) return start;
  const width = driver === 'h' ? (start.h * frameH * ratio) / frameW : start.w;
  const height = driver === 'h' ? start.h : (start.w * frameW) / (ratio * frameH);
  return normalizeBox({
    x: start.x + start.w / 2 - width / 2,
    y: start.y + start.h / 2 - height / 2,
    w: width,
    h: height,
  });
}

/**
 * Snap a box's edges to the guides: left/centre/right and top/middle/bottom, nearest wins per axis. Pure.
 *
 * Returns the adjusted box plus which guide won on each axis, so the overlay can draw the line that
 * actually did the snapping rather than all of them.
 */
export function snapBox(box, { targets = { x: [], y: [] }, size, tolerance = DEFAULT_BOX_SNAP_PX } = {}) {
  const frameW = Math.max(1, Number(size?.width) || 0);
  const frameH = Math.max(1, Number(size?.height) || 0);
  const rect = boxRect(box, size);
  const bestX = nearestEdge(
    [
      { from: rect.x, edge: 'left' },
      { from: rect.x + rect.width / 2, edge: 'centre' },
      { from: rect.x + rect.width, edge: 'right' },
    ],
    targets?.x ?? [],
    tolerance,
  );
  const bestY = nearestEdge(
    [
      { from: rect.y, edge: 'top' },
      { from: rect.y + rect.height / 2, edge: 'middle' },
      { from: rect.y + rect.height, edge: 'bottom' },
    ],
    targets?.y ?? [],
    tolerance,
  );
  return {
    box: normalizeBox({
      x: box.x + (bestX?.delta ?? 0) / frameW,
      y: box.y + (bestY?.delta ?? 0) / frameH,
      w: box.w,
      h: box.h,
    }),
    snappedX: bestX,
    snappedY: bestY,
  };
}

/** The closest (edge → guide) pair on one axis. A local copy of `placement.js`'s, kept private there. */
function nearestEdge(edges, targets, tolerance) {
  let best = null;
  for (const { from, edge } of edges) {
    const hit = snapValue(from, targets, tolerance);
    if (!hit) continue;
    if (!best || Math.abs(hit.delta) < Math.abs(best.delta)) best = { ...hit, edge, from };
  }
  return best;
}

// --------------------------------------------------------------------------- //
// rotating
// --------------------------------------------------------------------------- //

/**
 * The angle of a point about a centre, in degrees, measured clockwise from east. Pure.
 *
 * `centre` is a **point** (`{x, y}`) and not a rect: `clipPixels()` answers a rect whose centre is
 * `cx`/`cy`, and passing that here would measure every angle from the box's top-left corner. A rect is
 * not accepted silently for exactly that reason — the mistake is one nobody would see until a clip
 * turned about the wrong point.
 */
export function angleOf(point, centre) {
  return (Math.atan2((point?.y ?? 0) - (centre?.y ?? 0), (point?.x ?? 0) - (centre?.x ?? 0)) * 180) / Math.PI;
}

/**
 * The rotation a drag on the round handle asks for. Pure.
 *
 * The angle is *relative* to where the gesture started and the handle's own angle at that moment, so a
 * clip that is already turned does not jump to zero when it is grabbed: the delta from the pointer's
 * first position is what is added to the angle it had.
 */
export function rotationFromPointer({ centre, from, to, startRotation = 0 } = {}) {
  if (!centre || !from || !to) return normalizeRotation(startRotation);
  let delta = angleOf(to, centre) - angleOf(from, centre);
  // Wrapped the short way: dragging across the -180/180 seam must not spin the clip right round.
  delta = ((delta + 540) % 360) - 180;
  return normalizeRotation(startRotation + delta);
}

/**
 * Snap an angle to the nearest multiple of `step`, when it is close enough to be meant. Pure.
 *
 * `force` is shift held: the angle then takes the step it is nearest, however far away that is, which is
 * how a person asks for "exactly 45" without aiming. Zero is a multiple of every step, so upright is the
 * one angle that is always easy to land on — and the one that most needs to be exactly 0.
 */
export function snapRotation(degrees, { step = ROTATE_SNAP_STEP, tolerance = ROTATE_SNAP_TOLERANCE, force = false } = {}) {
  const wrapped = normalizeRotation(degrees);
  const nearest = Math.round(wrapped / step) * step;
  const delta = Math.abs(normalizeRotation(nearest - wrapped));
  if (force || delta <= tolerance) {
    return { degrees: normalizeRotation(nearest), snapped: normalizeRotation(nearest), delta };
  }
  return { degrees: wrapped, snapped: null, delta };
}

/**
 * Which mode a pointer-down starts, or `null` for "not one of the clip gestures". Pure.
 *
 * Handles are tested before the body, and before the rotation handle's stem: the round handle sits
 * outside the box, so it is reached first and never fights the top edge for the same pixels.
 */
export function beginClipGesture({ point, clip, size, clips = [] } = {}) {
  if (!point || !size) return null;
  if (clip) {
    if (hitRotateHandle(point, clip, size)) {
      return { mode: 'rotate', clipId: clip.id, handle: 'rotate', rotation: Number(clip.rotation) || 0 };
    }
    const handle = hitHandle(point, handlePoints(clip, size));
    if (handle) return { mode: 'resize', clipId: clip.id, handle: handle.id, rotation: Number(clip.rotation) || 0 };
  }
  const under = hitClip(point, clips, size);
  if (under) return { mode: 'move', clipId: under.id, handle: null, rotation: Number(under.rotation) || 0 };
  return null;
}

/** A plain, JSON-safe description of a clip's transform — what a panel row or a tooltip shows. Pure. */
export function describeTransform(clip) {
  if (!isPlainObject(clip?.box)) return '—';
  const pct = (v) => `${Math.round(v * 100)}%`;
  const parts = [`${pct(clip.box.w)}×${pct(clip.box.h)} at ${pct(clip.box.x)}, ${pct(clip.box.y)}`];
  if (clip.rotation) parts.push(`${Math.round(clip.rotation)}°`);
  if (clip.flipX || clip.flipY) parts.push(`flipped ${[clip.flipX ? 'x' : null, clip.flipY ? 'y' : null].filter(Boolean).join('/')}`);
  if (clip.fit && clip.fit !== 'contain') parts.push(clip.fit);
  if (clip.opacity !== 1) parts.push(`${Math.round(clamp(clip.opacity, 0, 1) * 100)}% opaque`);
  return parts.join(' · ');
}
