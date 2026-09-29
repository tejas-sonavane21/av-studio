/**
 * editor/canvas-overlay.js — the interactive placement layer.
 *
 * This module exists so that *moving a caption* is a geometry problem with a thin event adapter,
 * rather than the other way round. Every rule that could be wrong — where the anchor goes, what
 * snaps to what, how far a box may travel before it leaves the frame — lives in
 * `render/placement.js` and is unit-tested there. What is left here is:
 *
 *   1. **Coordinate conversion.** The preview canvas is laid out by CSS, so a pointer event's
 *      client coordinates have to be mapped back into the renderer's *logical* space before any
 *      geometry runs. `pointToLogical()` is that function, and it is exported because getting it
 *      wrong is invisible until the text is dragged somewhere other than the cursor.
 *   2. **Hit testing.** Which caption box is under the pointer? Topmost-first, with a small padding
 *      so a one-line caption is still clickable.
 *   3. **The guide layer.** A separate `<canvas>` above the preview draws the snap lines and the
 *      selection rectangle. It is deliberately *not* the renderer's own guide drawing: the
 *      renderer's guides are a static debugging aid (`opts.guides`), while these appear only while
 *      dragging, must never be mistaken for output, and must never be part of an export.
 *
 * Nothing here mutates the document. Drags and nudges call back with a new anchor and the caller
 * (`main.js`, via `templates/merge.js#setBlockPlacement`) decides whether to keep it — which is what
 * keeps undo, per-block overrides and "reset position" one-liners instead of special cases.
 */

import {
  DEFAULT_SNAP_TOLERANCE_PX,
  boxRectFor,
  buildSnapTargets,
  moveAnchor,
  nudgeAnchor,
  placeAnchor,
  presetFor,
} from '../render/placement.js';

/** One keyboard nudge, as a fraction of the canvas (so zoom level cannot change it). */
export const DEFAULT_NUDGE_STEP = 0.005;
/** Shift multiplies a nudge. */
export const NUDGE_MULTIPLIER = 4;
/** Extra px of slop around a box for hit testing — a single line of small text is short. */
export const HIT_PADDING_PX = 6;

const ARROW_STEPS = {
  ArrowLeft: { dxSteps: -1, dySteps: 0 },
  ArrowRight: { dxSteps: 1, dySteps: 0 },
  ArrowUp: { dxSteps: 0, dySteps: -1 },
  ArrowDown: { dxSteps: 0, dySteps: 1 },
};

/** Colour of the *active* snap line — the same lime the parity underline uses. */
const GUIDE_COLOURS = { active: '#22c55e', passive: 'rgba(255,255,255,0.22)' };

// ---------------------------------------------------------------------------
// pure geometry (exported for tests)
// ---------------------------------------------------------------------------

/** The box of a laid-out block as a plain rect. `layout.js` already reports `x/y/width/height`. */
export function boxRectOf(layout) {
  return {
    x: layout?.x ?? 0,
    y: layout?.y ?? 0,
    w: layout?.width ?? 0,
    h: layout?.height ?? 0,
  };
}

/**
 * Pointer client coordinates → the renderer's logical canvas coordinates.
 *
 * `rect` is the canvas's `getBoundingClientRect()` and `size` the renderer's *logical* size (NOT
 * the backing-store size — that is `logical × dpr`, and using it would double the DPR on the way
 * back). Both axes are scaled independently because a canvas whose CSS size was rounded to whole
 * pixels is very slightly non-square.
 */
export function pointToLogical({ rect, size, clientX, clientY }) {
  const sx = rect?.width > 0 ? (size?.width ?? 0) / rect.width : 1;
  const sy = rect?.height > 0 ? (size?.height ?? 0) / rect.height : 1;
  return {
    x: (clientX - (rect?.left ?? 0)) * sx,
    y: (clientY - (rect?.top ?? 0)) * sy,
    sx,
    sy,
  };
}

/**
 * Logical canvas coordinates → overlay paint coordinates.
 * The overlay covers the whole stage, which may be larger than the canvas, so the canvas origin is
 * an offset rather than zero.
 */
export function logicalToOverlay(point, { scale = 1, offsetX = 0, offsetY = 0 } = {}) {
  return { x: point.x * scale + offsetX, y: point.y * scale + offsetY };
}

/**
 * Which block is under `point`, topmost first.
 *
 * Later blocks paint over earlier ones (`canvas2d.js` draws in document order), so the search runs
 * backwards and the *last* block in the array wins a tie. `padding` inflates each box so thin or
 * very short captions stay clickable.
 *
 * @returns {object|null} the winning layout, not just its id — the caller needs its box for the drag
 */
export function hitTest(layouts, point, { padding = HIT_PADDING_PX } = {}) {
  if (!point) return null;
  for (let i = (layouts?.length ?? 0) - 1; i >= 0; i--) {
    const l = layouts[i];
    if (!l) continue;
    const r = boxRectOf(l);
    if (
      point.x >= r.x - padding &&
      point.x <= r.x + r.w + padding &&
      point.y >= r.y - padding &&
      point.y <= r.y + r.h + padding
    ) {
      return l;
    }
  }
  return null;
}

/** The rect the selection outline should follow — the block's box, expanded a little. */
export function selectionRect(anchor, canvas, box, { padding = HIT_PADDING_PX } = {}) {
  const r = boxRectFor(anchor, canvas, box);
  return { x: r.x - padding, y: r.y - padding, w: r.w + padding * 2, h: r.h + padding * 2 };
}

/**
 * Snap lines to paint, in **logical canvas coordinates**.
 *
 * A line only becomes "active" when it is the one the snap actually landed on; every other target
 * is passive and drawn faintly, and only while dragging — the resting state should be clean. A
 * horizontal snapped edge produces a *horizontal* line, hence the axis swap in the coordinates.
 */
export function guideLinesFor({
  canvas,
  targets = { x: [], y: [] },
  snappedX = null,
  snappedY = null,
  showAll = false,
} = {}) {
  const lines = [];
  const isActive = (t, snapped) => Boolean(snapped) && Math.abs(t.value - snapped.value) < 1e-6;
  if (showAll || snappedX) {
    for (const t of targets.x ?? []) {
      if (!showAll && !isActive(t, snappedX)) continue;
      lines.push({
        axis: 'x',
        active: isActive(t, snappedX),
        value: t.value,
        kind: t.kind,
        label: t.label,
        x1: t.value,
        y1: 0,
        x2: t.value,
        y2: canvas?.height ?? 0,
      });
    }
  }
  if (showAll || snappedY) {
    for (const t of targets.y ?? []) {
      if (!showAll && !isActive(t, snappedY)) continue;
      lines.push({
        axis: 'y',
        active: isActive(t, snappedY),
        value: t.value,
        kind: t.kind,
        label: t.label,
        x1: 0,
        y1: t.value,
        x2: canvas?.width ?? 0,
        y2: t.value,
      });
    }
  }
  return lines;
}

/**
 * Where an anchor goes for a drag, given where the user grabbed inside the box.
 *
 * The grab offset is the difference between the pointer and the anchor *at pointer-down*, and it is
 * held constant for the whole drag — that is what makes the text feel attached to the cursor instead
 * of jumping so its anchor meets the pointer. `box: 'anchor'` gravity-aware math stays in
 * `placement.js`; all this does is subtract.
 */
export function dragAnchor({ grabOffset, pointer, canvas }) {
  return moveAnchor(
    { posX: (pointer.x - grabOffset.dx) / canvas.width, posY: (pointer.y - grabOffset.dy) / canvas.height },
    { dxPx: 0, dyPx: 0 },
    canvas,
  );
}

// ---------------------------------------------------------------------------
// the DOM binding
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas    the preview canvas (the thing being measured)
 * @param {HTMLCanvasElement} options.overlay   the guide canvas (the thing receiving events)
 * @param {object} options.preview              `editor/preview.js` instance
 * @param {(blockId: string)=>void} [options.onSelect]
 * @param {(blockId: string, anchor: object, info: object)=>void} [options.onPlace]
 */
export function createCanvasOverlay({
  canvas,
  overlay,
  preview,
  onSelect = null,
  onPlace = null,
  snapTolerance = DEFAULT_SNAP_TOLERANCE_PX,
  showAllTargets = true,
} = {}) {
  if (!canvas || !overlay) throw new Error('createCanvasOverlay(): a preview canvas and an overlay canvas are required');
  if (!preview) throw new Error('createCanvasOverlay(): a preview instance is required');

  const ctx = overlay.getContext?.('2d') ?? null;
  let selectedId = null;
  let enabled = true;
  let drag = null; // { blockId, grabOffset, anchor, box }
  let guides = { targets: { x: [], y: [] }, snappedX: null, snappedY: null };
  let lastKey = '';
  let observers = [];

  /** The canvas's logical size and the mapping into overlay paint space. */
  function geometry() {
    const size = preview.renderer.size;
    const cRect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: size.width, height: size.height };
    const oRect = overlay.getBoundingClientRect?.() ?? { left: 0, top: 0, width: cRect.width, height: cRect.height };
    const scale = cRect.width > 0 ? size.width / cRect.width : 1;
    return {
      size,
      cRect,
      oRect,
      scale,
      offsetX: cRect.left - oRect.left,
      offsetY: cRect.top - oRect.top,
    };
  }

  /** Re-fit the overlay's backing store to its CSS box. */
  function resizeOverlay() {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const w = Math.max(1, Math.round(overlay.clientWidth || 0));
    const h = Math.max(1, Math.round(overlay.clientHeight || 0));
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(h * dpr);
    }
    return { dpr, w, h };
  }

  /** The box of the currently selected block, or null when it is not on screen. */
  function selectedLayout() {
    if (!selectedId) return null;
    return (preview.layouts ?? []).find((l) => l.blockId === selectedId) ?? null;
  }

  /** Snap targets for a drag: canvas centre/thirds/safe areas/edges + the other visible blocks. */
  function targetsFor(excludeBlockId) {
    return buildSnapTargets({
      canvas: preview.renderer.size,
      layouts: preview.layouts ?? [],
      excludeBlockId,
    });
  }

  function paint() {
    if (!ctx) return;
    const { dpr, w, h } = resizeOverlay();
    const geo = geometry();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const to = (p) => logicalToOverlay(p, geo);

    for (const line of guideLinesFor({ canvas: geo.size, ...guides, showAll: drag ? showAllTargets : false })) {
      const a = to({ x: line.x1, y: line.y1 });
      const b = to({ x: line.x2, y: line.y2 });
      ctx.save?.();
      ctx.strokeStyle = line.active ? GUIDE_COLOURS.active : GUIDE_COLOURS.passive;
      ctx.lineWidth = line.active ? 2 : 1;
      ctx.setLineDash?.(line.active ? [] : [4, 4]);
      ctx.beginPath?.();
      ctx.moveTo?.(a.x, a.y);
      ctx.lineTo?.(b.x, b.y);
      ctx.stroke?.();
      ctx.restore?.();
    }

    // Selection outline: drawn from the *placed* anchor, so it tracks a drag exactly.
    const layout = selectedLayout() ?? drag?.layout ?? null;
    const anchor = drag?.anchor ?? preview.document?.blocks?.find((b) => b.id === selectedId)?.placement ?? null;
    if (layout && anchor) {
      const r = selectionRect(anchor, geo.size, { width: layout.width, height: layout.height });
      const tl = to({ x: r.x, y: r.y });
      const scale = geo.scale;
      ctx.save?.();
      ctx.strokeStyle = 'rgba(34,197,94,0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash?.([5, 4]);
      ctx.strokeRect?.(tl.x, tl.y, r.w * scale, r.h * scale);
      ctx.restore?.();
    }
  }

  /** Repaint, but only when something the overlay draws could have changed. */
  function refresh({ force = false } = {}) {
    // Nothing to draw and nothing to hit-test: skip before building the key, so an idle editor
    // does not allocate on every animation frame.
    if (!force && !selectedId && !drag) return false;
    const size = preview.renderer.size;
    const cRect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: size.width, height: size.height };
    const key = [
      size.width,
      size.height,
      Math.round(cRect.left),
      Math.round(cRect.top),
      Math.round(cRect.width),
      Math.round(cRect.height),
      selectedId ?? '',
      drag ? 'drag' : '',
      preview.layouts?.length ?? 0,
      (preview.layouts ?? []).map((l) => `${l.blockId}:${Math.round(l.x)}:${Math.round(l.y)}`).join(','),
    ].join('|');
    if (!force && key === lastKey) return false;
    lastKey = key;
    paint();
    return true;
  }

  function select(blockId) {
    selectedId = blockId ?? null;
    onSelect?.(selectedId);
    refresh({ force: true });
    return selectedId;
  }

  function emitPlace(blockId, anchor, info) {
    onPlace?.(blockId, anchor, info);
  }

  /** Drag: pointer down on a block. */
  function onPointerDown(e) {
    if (!enabled || !preview.document) return;
    const geo = geometry();
    const size = geo.size;
    const point = pointToLogical({ rect: geo.cRect, size, clientX: e.clientX, clientY: e.clientY });
    const layout = hitTest(preview.layouts ?? [], point);
    if (!layout) {
      select(null);
      return;
    }
    const anchor = layoutAnchor(layout.blockId) ?? { posX: 0.5, posY: 0.5, gravity: 'center' };
    drag = {
      blockId: layout.blockId,
      layout,
      anchor,
      grabOffset: {
        dx: point.x - (anchor.posX ?? 0.5) * size.width,
        dy: point.y - (anchor.posY ?? 0.5) * size.height,
      },
    };
    select(layout.blockId);
    guides = { targets: targetsFor(layout.blockId), snappedX: null, snappedY: null };
    overlay.setPointerCapture?.(e.pointerId);
    e.preventDefault?.();
  }

  /** Drag: pointer move. Snap + clamp, then publish the new anchor immediately (live preview). */
  function onPointerMove(e) {
    if (!drag) return;
    const geo = geometry();
    const size = geo.size;
    const point = pointToLogical({ rect: geo.cRect, size, clientX: e.clientX, clientY: e.clientY });
    const raw = dragAnchor({ grabOffset: drag.grabOffset, pointer: point, canvas: size });
    const box = { width: drag.layout.width, height: drag.layout.height };
    const placed = placeAnchor(raw, {
      canvas: size,
      box,
      targets: guides.targets,
      tolerance: snapTolerance,
    });
    drag.anchor = placed.anchor;
    guides.snappedX = placed.snappedX;
    guides.snappedY = placed.snappedY;
    emitPlace(drag.blockId, placed.anchor, { preset: presetFor(placed.anchor), live: true, guides: placed });
    refresh({ force: true });
    e.preventDefault?.();
  }

  /** Drag: pointer up. `commit` tells the caller this value should survive (undo/history). */
  function onPointerUp(e) {
    if (!drag) return;
    const { blockId, anchor } = drag;
    drag = null;
    guides = { targets: { x: [], y: [] }, snappedX: null, snappedY: null };
    emitPlace(blockId, anchor, { preset: presetFor(anchor), live: false, commit: true });
    overlay.releasePointerCapture?.(e?.pointerId);
    refresh({ force: true });
  }

  /** Keyboard nudge. Ignored while typing, so arrow keys in a text field still work. */
  function onKeyDown(e) {
    const step = ARROW_STEPS[e.key];
    if (!enabled || !step || !selectedId || isTyping(e.target)) return;
    const anchor = layoutAnchor(selectedId);
    if (!anchor) return;
    const next = nudgeAnchor(anchor, {
      ...step,
      step: DEFAULT_NUDGE_STEP,
      multiplier: e.shiftKey ? NUDGE_MULTIPLIER : 1,
    });
    e.preventDefault?.();
    emitPlace(selectedId, next, { preset: presetFor(next), live: false, commit: true, keyboard: true });
    refresh({ force: true });
  }

  /** The anchor a block renders with: its own placement, else the document default. */
  function layoutAnchor(blockId) {
    const doc = preview.document;
    const block = doc?.blocks?.find((b) => b.id === blockId);
    if (!block) return null;
    return block.placement ?? doc?.defaults?.anchor ?? null;
  }

  function isTyping(target) {
    const tag = String(target?.tagName ?? '').toUpperCase();
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable === true;
  }

  // -------------------------------------------------------------------------
  // wiring
  // -------------------------------------------------------------------------

  overlay.addEventListener?.('pointerdown', onPointerDown);
  overlay.addEventListener?.('pointermove', onPointerMove);
  overlay.addEventListener?.('pointerup', onPointerUp);
  overlay.addEventListener?.('pointercancel', onPointerUp);
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown);

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => refresh({ force: true }));
    ro.observe(overlay);
    ro.observe(canvas);
    observers.push(ro);
  }

  function dispose() {
    overlay.removeEventListener?.('pointerdown', onPointerDown);
    overlay.removeEventListener?.('pointermove', onPointerMove);
    overlay.removeEventListener?.('pointerup', onPointerUp);
    overlay.removeEventListener?.('pointercancel', onPointerUp);
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeyDown);
    observers.forEach((o) => o.disconnect?.());
    observers = [];
    drag = null;
  }

  function setEnabled(next) {
    enabled = !!next;
    if (!enabled) onPointerUp(null);
    if (overlay.style) overlay.style.pointerEvents = enabled ? 'auto' : 'none';
    refresh({ force: true });
    return enabled;
  }

  return {
    select,
    refresh,
    setEnabled,
    dispose,
    nudge: (steps, { multiplier = 1 } = {}) => {
      if (!selectedId) return null;
      const anchor = layoutAnchor(selectedId);
      if (!anchor) return null;
      const next = nudgeAnchor(anchor, { ...steps, step: DEFAULT_NUDGE_STEP, multiplier });
      emitPlace(selectedId, next, { preset: presetFor(next), live: false, commit: true });
      refresh({ force: true });
      return next;
    },
    get selectedId() {
      return selectedId;
    },
    get enabled() {
      return enabled;
    },
    get dragging() {
      return Boolean(drag);
    },
    get guides() {
      return { ...guides };
    },
  };
}
