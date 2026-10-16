/**
 * render/placement.js — where a caption box sits, and how dragging/snapping behaves.
 *
 * **Pure geometry.** No DOM, no canvas, no renderer import — so every rule in here is unit-testable
 * and the interactive overlay (`editor/canvas-overlay.js`) is only responsible for turning pointer
 * events into calls on these functions.
 *
 * ## Coordinates
 *
 * The document stores an anchor as **normalized fractions** (`posX`, `posY` in 0..1) plus a
 * `gravity`, and that is deliberately resolution-independent: the same document renders identically
 * at 720p and 4K, and export does not depend on the preview's pixel size (plan §9.8). Pixels appear
 * only at the edges of this module — `anchorToPx`/`pxToAnchor` convert, everything in between is
 * normalized.
 *
 * `gravity` says which part of the text box the anchor names:
 *
 * ```
 * gravity: 'center'      box is centred on the anchor
 * gravity: 'bottom-left' box's bottom-left corner is the anchor
 * gravity: 'bottom'      box is centred horizontally, its bottom edge is the anchor
 * ```
 *
 * ## What snapping actually snaps
 *
 * The subtle part: dragging moves the *anchor*, but the user's eye is on the *box*. Snapping the
 * anchor point would make the box visibly refuse to line up with the canvas centre, because the box
 * centre and the anchor coincide only under `gravity: 'center'`. So snapping considers the box's
 * **left / centre / right** (and top / middle / bottom) edges as candidates and then moves the
 * anchor by whatever delta makes the winning candidate land on the guide.
 */

import { ANCHOR_PRESETS } from '../model/schema.js';
import { clamp } from '../util/math.js';

/**
 * Title-safe / action-safe fractions (plan §12.4) — the same broadcast convention Veed's guides use.
 * Canonical here; `render/canvas2d.js` re-exports it so the two can never diverge.
 */
export const SAFE_AREAS = { titleSafe: 0.9, actionSafe: 0.93 };

/** Every named anchor preset. */
export const PRESET_IDS = Object.keys(ANCHOR_PRESETS);

/** Default snap distance, in preview pixels. Beyond this the drag is free. */
export const DEFAULT_SNAP_TOLERANCE_PX = 8;

/** Thickness of the region at the canvas edge that the clamp keeps the box out of, in px. */
export const DEFAULT_EDGE_MARGIN_PX = 4;

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

/** A named preset's anchor, or `null`. Always returns a fresh object. */
export function anchorFromPreset(id) {
  const preset = ANCHOR_PRESETS[id];
  return preset ? { ...preset, preset: id } : null;
}

/** Normalized anchor → pixels. */
export function anchorToPx(anchor, canvas) {
  return {
    x: (anchor?.posX ?? 0.5) * canvas.width,
    y: (anchor?.posY ?? 0.5) * canvas.height,
  };
}

/** Pixels → a normalized anchor. Clamped to the canvas, because 0..1 is a model invariant. */
export function pxToAnchor(point, canvas, { gravity = 'center', preset = null } = {}) {
  return {
    posX: clamp(point.x / canvas.width, 0, 1),
    posY: clamp(point.y / canvas.height, 0, 1),
    gravity,
    // A preset id is a *claim* about which preset this matches. Any manual move invalidates it, so
    // `presetFor` is what re-establishes it; carrying `preset` through here would let a dragged
    // block keep lying about being "bottom-center".
    ...(preset ? { preset } : {}),
  };
}

/**
 * Which preset, if any, this anchor matches.
 *
 * Kept separate from the anchor so the UI can show "bottom-right" for a dragged-to-that-corner block
 * without the document having to be rewritten on every pointer move.
 */
export function presetFor(anchor, { tolerance = 0.02, gravity = true } = {}) {
  let best = null;
  for (const id of PRESET_IDS) {
    if (gravity && anchor?.gravity && ANCHOR_PRESETS[id].gravity !== anchor.gravity) continue;
    const p = ANCHOR_PRESETS[id];
    const d = Math.hypot(p.posX - (anchor?.posX ?? 0.5), p.posY - (anchor?.posY ?? 0.5));
    if (d <= tolerance && (!best || d < best.d)) best = { id, d };
  }
  return best?.id ?? null;
}

/** Move an anchor by a pixel delta. The return value is what `presetFor` should be run on. */
export function moveAnchor(anchor, delta, canvas) {
  return pxToAnchor(
    { x: ((anchor?.posX ?? 0.5) * canvas.width) + (delta.dxPx ?? 0), y: ((anchor?.posY ?? 0.5) * canvas.height) + (delta.dyPx ?? 0) },
    canvas,
    { gravity: anchor?.gravity ?? 'center' },
  );
}

/**
 * Keyboard nudge. One "step" is a fraction of the canvas, not a pixel, so nudging is identical at
 * every preview zoom level and at every device. `multiplier` defaults to 1 (a plain arrow key); the
 * overlay passes 4 when shift is held.
 */
export function nudgeAnchor(anchor, { dxSteps = 0, dySteps = 0, step = 0.005, multiplier = 1 } = {}) {
  return {
    posX: clamp((anchor?.posX ?? 0.5) + dxSteps * step * multiplier, 0, 1),
    posY: clamp((anchor?.posY ?? 0.5) + dySteps * step * multiplier, 0, 1),
    gravity: anchor?.gravity ?? 'center',
  };
}

// ---------------------------------------------------------------------------
// box geometry
// ---------------------------------------------------------------------------

/**
 * The text box's rect for a given anchor — the inverse of `layout.js`'s placement, and the reason
 * `gravity` has to be honoured in every snapping/clamping decision below.
 */
export function boxRectFor(anchor, canvas, box) {
  const w = box?.width ?? 0;
  const h = box?.height ?? 0;
  const { x: ax, y: ay } = anchorToPx(anchor, canvas);
  const g = normalizeGravityLocal(anchor?.gravity);
  const left = g.x === 'left' ? ax : g.x === 'right' ? ax - w : ax - w / 2;
  const top = g.y === 'top' ? ay : g.y === 'bottom' ? ay - h : ay - h / 2;
  return { x: left, y: top, w, h, cx: left + w / 2, cy: top + h / 2, right: left + w, bottom: top + h };
}

/** Mirrors `layout.js#normalizeGravity` without importing the render stack. */
function normalizeGravityLocal(gravity = 'center') {
  const parts = String(gravity).toLowerCase().split(/[-\s_]+/).filter(Boolean);
  let x = 'center';
  let y = 'center';
  for (const p of parts) {
    if (p === 'left' || p === 'right') x = p;
    else if (p === 'top' || p === 'bottom') y = p;
  }
  return { x, y };
}

/**
 * Move an anchor so the box stays inside the canvas, keeping the box's size fixed.
 *
 * The box is *slid*, not resized: `gravity` is preserved, and the anchor absorbs the difference. A
 * box genuinely wider than the canvas is centred instead of being pushed off one edge, because
 * with an over-wide box no anchor keeps it inside and centring at least looks deliberate.
 */
export function clampAnchorToCanvas(anchor, { canvas, box, margin = DEFAULT_EDGE_MARGIN_PX } = {}) {
  const w = box?.width ?? 0;
  const h = box?.height ?? 0;
  const rect = boxRectFor(anchor, canvas, box);
  const g = normalizeGravityLocal(anchor?.gravity);

  // how far the box must move to be inside
  let shiftX = 0;
  if (w + 2 * margin <= canvas.width) {
    if (rect.x < margin) shiftX = margin - rect.x;
    else if (rect.right > canvas.width - margin) shiftX = canvas.width - margin - rect.right;
  } else {
    shiftX = (canvas.width - w) / 2 - rect.x;
  }
  let shiftY = 0;
  if (h + 2 * margin <= canvas.height) {
    if (rect.y < margin) shiftY = margin - rect.y;
    else if (rect.bottom > canvas.height - margin) shiftY = canvas.height - margin - rect.bottom;
  } else {
    shiftY = (canvas.height - h) / 2 - rect.y;
  }

  const point = anchorToPx(anchor, canvas);
  return {
    anchor: {
      posX: clamp((point.x + shiftX) / canvas.width, 0, 1),
      posY: clamp((point.y + shiftY) / canvas.height, 0, 1),
      gravity: anchor?.gravity ?? 'center',
    },
    shiftedX: shiftX,
    shiftedY: shiftY,
  };
}

/** How far the box sticks out of the canvas, per edge. Zeroes when it fits. */
export function boxOverflow(anchor, canvas, box) {
  const r = boxRectFor(anchor, canvas, box);
  return {
    left: Math.max(0, -r.x),
    right: Math.max(0, r.right - canvas.width),
    top: Math.max(0, -r.y),
    bottom: Math.max(0, r.bottom - canvas.height),
  };
}

/** Human-readable position for the UI: `72.0% / 84.8%`. */
export function describeAnchor(anchor) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  return `${pct(anchor?.posX ?? 0.5)} / ${pct(anchor?.posY ?? 0.5)}`;
}

// ---------------------------------------------------------------------------
// snap targets
// ---------------------------------------------------------------------------

/**
 * Build the guide lines a drag can snap to.
 *
 * Sources, in the order they are added (earlier wins a tie, since later duplicates are dropped):
 * canvas centre and thirds, the safe-area edges, the canvas edges, then the other visible boxes'
 * edges. Including the sibling boxes is what makes a second caption line up with the first without the
 * user measuring anything — and the boxes are not only captions: an overlay clip's rect is handed over as
 * a layout too (`editor/canvas-overlay.js`), with `kind: 'clip'`, so a logo can be lined up on a banner's
 * edge. `kind` is only a label: what a target *is* never changes how snapping works, it changes what the
 * guide line says about itself.
 *
 * @param {{ canvas: {width:number,height:number}, layouts?: Array, safeAreas?: boolean, thirds?: boolean, excludeBlockId?: string|null }} options
 */
export function buildSnapTargets({
  canvas,
  layouts = [],
  safeAreas = true,
  thirds = true,
  excludeBlockId = null,
} = {}) {
  const x = [];
  const y = [];
  const add = (list, value, kind, label) => {
    if (!Number.isFinite(value)) return;
    if (value < 0 || value > (list === x ? canvas.width : canvas.height)) return;
    if (list.some((t) => Math.abs(t.value - value) < 1e-6)) return;
    list.push({ value, kind, label });
  };

  add(x, canvas.width / 2, 'center', 'centre');
  add(y, canvas.height / 2, 'center', 'centre');
  if (thirds) {
    for (const f of [1 / 3, 2 / 3]) {
      add(x, canvas.width * f, 'third', `third ${Math.round(f * 100)}%`);
      add(y, canvas.height * f, 'third', `third ${Math.round(f * 100)}%`);
    }
  }
  if (safeAreas) {
    for (const [name, frac] of Object.entries(SAFE_AREAS)) {
      const insetX = (canvas.width * (1 - frac)) / 2;
      const insetY = (canvas.height * (1 - frac)) / 2;
      add(x, insetX, 'safe', `${name} left`);
      add(x, canvas.width - insetX, 'safe', `${name} right`);
      add(y, insetY, 'safe', `${name} top`);
      add(y, canvas.height - insetY, 'safe', `${name} bottom`);
    }
  }
  add(x, 0, 'edge', 'left edge');
  add(x, canvas.width, 'edge', 'right edge');
  add(y, 0, 'edge', 'top edge');
  add(y, canvas.height, 'edge', 'bottom edge');

  for (const layout of layouts) {
    if (!layout || layout.blockId === excludeBlockId) continue;
    const kind = layout.kind === 'clip' ? 'clip' : 'block';
    const l = layout.x ?? 0;
    const r = l + (layout.width ?? 0);
    add(x, l, kind, `${kind} left`);
    add(x, (l + r) / 2, kind, `${kind} centre`);
    add(x, r, kind, `${kind} right`);
    const t = layout.y ?? 0;
    const b = t + (layout.height ?? 0);
    add(y, t, kind, `${kind} top`);
    add(y, (t + b) / 2, kind, `${kind} middle`);
    add(y, b, kind, `${kind} bottom`);
  }

  return { x, y };
}

/** Snap one scalar to the nearest target within `tolerance`. Pure, and the unit test's entry point. */
export function snapValue(value, targets, tolerance) {
  let best = null;
  for (const t of targets ?? []) {
    const d = t.value - value;
    if (Math.abs(d) <= tolerance && (!best || Math.abs(d) < Math.abs(best.delta))) {
      best = { value: t.value, kind: t.kind, label: t.label, delta: d };
    }
  }
  return best;
}

/**
 * Snap an anchor by testing the box's own edges — not the anchor point (see the module comment).
 * Returns the adjusted anchor plus which guide won on each axis, so the overlay can draw it.
 */
export function snapAnchor(
  anchor,
  { canvas, box, targets, tolerance = DEFAULT_SNAP_TOLERANCE_PX } = {},
) {
  const rect = boxRectFor(anchor, canvas, box);
  const bestX = nearestOf(
    [
      { from: rect.x, edge: 'left' },
      { from: rect.cx, edge: 'center' },
      { from: rect.right, edge: 'right' },
    ],
    targets?.x ?? [],
    tolerance,
  );
  const bestY = nearestOf(
    [
      { from: rect.y, edge: 'top' },
      { from: rect.cy, edge: 'middle' },
      { from: rect.bottom, edge: 'bottom' },
    ],
    targets?.y ?? [],
    tolerance,
  );

  const point = anchorToPx(anchor, canvas);
  return {
    anchor: {
      posX: clamp((point.x + (bestX?.delta ?? 0)) / canvas.width, 0, 1),
      posY: clamp((point.y + (bestY?.delta ?? 0)) / canvas.height, 0, 1),
      gravity: anchor?.gravity ?? 'center',
    },
    snappedX: bestX,
    snappedY: bestY,
    deltaX: bestX?.delta ?? 0,
    deltaY: bestY?.delta ?? 0,
  };
}

/** The closest (edge → guide) pair across all of the box's edges on one axis. */
function nearestOf(edges, targets, tolerance) {
  let best = null;
  for (const { from, edge } of edges) {
    const hit = snapValue(from, targets, tolerance);
    if (!hit) continue;
    if (!best || Math.abs(hit.delta) < Math.abs(best.delta)) {
      best = { ...hit, edge, from };
    }
  }
  return best;
}

/**
 * The one call the overlay makes while dragging: snap, then keep the box on canvas.
 *
 * Snapping runs first so that a drag toward the canvas centre lands *exactly* on it; the clamp only
 * ever moves a box that would have left the frame, so it cannot pull a snapped box back off its
 * guide.
 */
export function placeAnchor(anchor, options = {}) {
  const { tolerance = DEFAULT_SNAP_TOLERANCE_PX, margin = DEFAULT_EDGE_MARGIN_PX } = options;
  const snapped = snapAnchor(anchor, { ...options, tolerance });
  const clamped = clampAnchorToCanvas(snapped.anchor, { ...options, margin });
  return {
    anchor: clamped.anchor,
    snappedX: snapped.snappedX,
    snappedY: snapped.snappedY,
    clamped: clamped.shiftedX !== 0 || clamped.shiftedY !== 0,
  };
}
