/**
 * editor/canvas-overlay.js — the interactive placement layer.
 *
 * This module exists so that *moving a thing* is a geometry problem with a thin event adapter,
 * rather than the other way round. Every rule that could be wrong — where the anchor goes, what
 * snaps to what, how far a box may travel before it leaves the frame, what a resize handle does to a
 * rotated box — lives in `render/placement.js` (captions) and `render/media-placement.js` (overlay
 * clips) and is unit-tested there. What is left here is:
 *
 *   1. **Coordinate conversion.** The preview canvas is laid out by CSS, so a pointer event's
 *      client coordinates have to be mapped back into the renderer's *logical* space before any
 *      geometry runs. `pointToLogical()` is that function, and it is exported because getting it
 *      wrong is invisible until the text is dragged somewhere other than the cursor.
 *   2. **Hit testing.** Which thing is under the pointer? The order is the rule: the *handles and the
 *      body of the selected clip* first (a thing you have selected stays grabbable even where a
 *      caption overlaps it), then caption boxes, then any other clip topmost-first, with a small
 *      padding so a one-line caption is still clickable.
 *   3. **The guide layer.** A separate `<canvas>` above the preview draws the snap lines, the
 *      selection rectangle and the clip handles. It is deliberately *not* the renderer's own guide
 *      drawing: the renderer's guides are a static debugging aid (`opts.guides`), while these appear
 *      only while dragging, must never be mistaken for output, and must never be part of an export.
 *
 * Nothing here mutates the document. Drags, nudges, resizes and rotations call back with a new anchor,
 * box or angle and the caller (`main.js`) decides whether to keep it — which is what keeps undo,
 * per-block overrides and "reset position" one-liners instead of special cases.
 *
 * ## The clip gestures
 *
 * An overlay clip is not placed by an anchor: it *is* a box, so its gestures are the box's. Drag the
 * body to move it, one of the eight handles to resize it (shift holds the shape), the round handle
 * above the top edge to turn it (shift steps the angle by 15 degrees), and the arrow keys to nudge it.
 * All four publish a box or an angle; none of them touch a clip directly.
 *
 * **Alt places freely.** Guides are the default for every drag (a box wants to sit on the centre, an
 * edge, a third, or in line with a caption), and a deliberate off-centre position is exactly the thing
 * that is hard to land with them on. Holding Alt takes the targets away for the rest of that gesture,
 * clip or caption, and takes the guide lines away with them so the screen never promises a pull that
 * will not happen.
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
import {
  HANDLE_SIDE_PX,
  boxFromHandle,
  boxFromMove,
  clipPixels,
  clipQuad,
  cropFromHandle,
  handlePoints,
  handlePointsForRect,
  hitClip,
  cropFromMove,
  cropRectIn,
  cropShadeBands,
  hitHandle,
  hitRotateHandle,
  pointInClip,
  pointInRect,
  rotateHandlePoint,
  rotatePoint,
  rotateStemPoint,
  rotationFromPointer,
  snapBox,
  snapRotation,
} from '../render/media-placement.js';
import {
  FULL_CROP,
  boxRect,
  clipContentAspect,
  clipDrawRect,
  clipPixelAspect,
  drawOrder,
  moveCrop,
} from '../model/media.js';

/** One keyboard nudge, as a fraction of the canvas (so zoom level cannot change it). */
export const DEFAULT_NUDGE_STEP = 0.005;
/** Shift multiplies a nudge. */
export const NUDGE_MULTIPLIER = 4;
/** Extra px of slop around a box for hit testing — a single line of small text is short. */
export const HIT_PADDING_PX = 6;
/** The crop frame, and its handles, while the panel is in crop mode — a second kind of handle on screen. */
export const CROP_COLOUR = '#f59e0b';

/** What the part of the picture the crop cuts away is covered with, so the kept pixels read as kept. */
export const CROP_DIM_COLOUR = 'rgba(0,0,0,0.55)';

/** The rule-of-thirds lines inside the crop rectangle: alignment help, not a cut. */
export const CROP_GUIDE_COLOUR = 'rgba(245,158,11,0.42)';

/** How far one arrow key moves the crop window, in file pixels. Shift takes ten of them. */
export const CROP_NUDGE_PX = 1;

/**
 * No snap targets at all, which is what Alt holds a gesture to.
 *
 * One shared object rather than a fresh `{ x: [], y: [] }` per event, so "is the modifier on?" is a
 * comparison instead of a search — and the guide layer draws from this same set, so an empty one means
 * "nothing will pull, and nothing is drawn to suggest otherwise".
 */
const NO_TARGETS = Object.freeze({ x: Object.freeze([]), y: Object.freeze([]) });

const ARROW_STEPS = {
  ArrowLeft: { dxSteps: -1, dySteps: 0 },
  ArrowRight: { dxSteps: 1, dySteps: 0 },
  ArrowUp: { dxSteps: 0, dySteps: -1 },
  ArrowDown: { dxSteps: 0, dySteps: 1 },
};

/** Colour of the *active* snap line — the same lime the parity underline uses. */
const GUIDE_COLOURS = { active: '#22c55e', passive: 'rgba(255,255,255,0.22)' };

/** The selection colour, for a caption's outline and a clip's outline and handles. */
const SELECT_COLOUR = '#22c55e';

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
 * @param {()=>Array<object>} [options.getClips]  the document's overlay clips, live
 * @param {(clipId:string)=>({width:number,height:number}|null)} [options.clipSize]
 *        the media's own pixel size, for a shape-locked resize
 * @param {(blockId:string)=>void} [options.onSelect]
 * @param {(blockId:string, anchor:object, info:object)=>void} [options.onPlace]
 * @param {(clipId:string|null)=>void} [options.onClipSelect]
 * @param {(clipId:string, box:object, info:object)=>void} [options.onClipBox]
 * @param {(clipId:string, degrees:number, info:object)=>void} [options.onClipRotate]
 * @param {()=>boolean} [options.keepAspect]
 *        whether a resize holds the picture's shape — the panel's lock. Shift inverts it for one drag,
 *        which is the convention every editor shares: the lock says what the *default* is.
 * @param {()=>boolean} [options.cropMode]  whether the handles cut the picture instead of resizing it
 * @param {()=>number} [options.cropRatio]  the pixel ratio a crop handle holds, `0` for free
 */
export function createCanvasOverlay({
  canvas,
  overlay,
  preview,
  getClips = () => [],
  clipSize = () => null,
  keepAspect = () => true,
  cropMode = () => false,
  cropRatio = () => 0,
  onSelect = null,
  onPlace = null,
  onClipSelect = null,
  onClipBox = null,
  onClipRotate = null,
  onClipCrop = null,
  snapTolerance = DEFAULT_SNAP_TOLERANCE_PX,
  showAllTargets = true,
} = {}) {
  if (!canvas || !overlay) throw new Error('createCanvasOverlay(): a preview canvas and an overlay canvas are required');
  if (!preview) throw new Error('createCanvasOverlay(): a preview instance is required');

  const ctx = overlay.getContext?.('2d') ?? null;
  let selectedId = null;
  let selectedClipId = null;
  let enabled = true;
  let drag = null; // { blockId, grabOffset, anchor, layout }
  let clipDrag = null; // { mode, clipId, handle, startBox, startRotation, startPoint, box, rotation, moved }
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

  /**
   * Every overlay clip in the document, live, **bottom layer first**.
   *
   * The order is the renderer's: the layer paints them in this order and `hitClip()` walks it backwards,
   * so "the clip under the pointer" is the one that was painted last and is therefore on top. Read from
   * the model (`drawOrder`) rather than assumed from the list, or stacking would only work by accident.
   */
  function clips() {
    const list = getClips?.() ?? [];
    return Array.isArray(list) ? drawOrder(list.filter(Boolean)) : [];
  }

  /** A clip by id, or `null`. */
  function clipById(id) {
    return id ? clips().find((clip) => clip.id === id) ?? null : null;
  }

  /** The clip the overlay is drawing handles for: the one being dragged, else the selected one. */
  function activeClip() {
    if (clipDrag) return clipById(clipDrag.clipId);
    return clipById(selectedClipId);
  }

  /**
   * The pixel ratio a shape-locked resize holds: the shape of what the clip *shows* — its crop, not its
   * file — when the file is loaded, and the box's own shape when it is not (an offline clip is still
   * resizable, and its box is all there is).
   */
  function aspectFor(clip) {
    const media = clipSize?.(clip.id) ?? null;
    const content = media ? clipContentAspect(clip, media) : 0;
    if (content > 0) return content;
    return clipPixelAspect(clip, preview.renderer.size);
  }

  /**
   * The crop frame: the rectangle around the **whole** picture, in pixels, for the crop handles to live on.
   *
   * Not the crop's own rectangle. A crop is a *cut*, and cutting needs to see what is being cut: showing
   * the frame around what is already left would shrink it under the pointer with every drag and leave
   * nothing to drag outwards again. Null when the file is not loaded — there is no whole picture to frame.
   *
   * Spelled `{x, y, w, h}`, the convention `handlePointsForRect` and `cropFromHandle` read. `clipDrawRect`
   * answers `{x, y, width, height}`, and handing that on unchanged is a frame whose width is `undefined`:
   * handles placed at `NaN`, and a cut that never leaves the crop it started with.
   */
  function cropFrameFor(clip) {
    const media = clipSize?.(clip.id) ?? null;
    if (!media) return null;
    const rect = clipDrawRect({ ...clip, crop: FULL_CROP }, media, preview.renderer.size);
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }

  /**
   * The crop's own rectangle on screen: the part of the whole picture that survives, in pixels.
   *
   * This is where the handles live and what is drawn solid inside the dashed whole-picture frame. It is
   * not the clip's box — a crop cuts pixels, not the box — and it is not the frame either once anything
   * has been cut: the gap between the two is exactly what is being removed, which is why both are drawn.
   */
  function cropRectFor(clip) {
    const frame = cropFrameFor(clip);
    return frame ? cropRectIn(frame, clip.crop) : null;
  }

  /**
   * Snap targets for a drag: canvas centre/thirds/safe areas/edges, the captions, and the clips.
   *
   * An overlay clip is a box like a caption box, so its edges belong in the same list — that is how a
   * badge is lined up on a banner edge without measuring anything. The **dragged** clip is left out
   * (that is the `exclude` argument): its own edges would sit on top of the pointer, snapping to
   * distance zero and lighting a guide line for a snap that moved nothing.
   */
  function targetsFor(excludeId = null, { includeClips = true } = {}) {
    return buildSnapTargets({
      canvas: preview.renderer.size,
      layouts: includeClips ? [...(preview.layouts ?? []), ...clipLayouts()] : preview.layouts ?? [],
      excludeBlockId: excludeId,
    });
  }

  /**
   * The targets the gesture in flight should be using — read live, because Alt can take them away and
   * put them back mid-drag.
   *
   * A *caption* drag keeps the caption targets it has always had and is not offered the clips: a caption
   * is placed by an anchor and the clips are placed by a box, and quietly changing where captions snap
   * would be a change to the caption editor made in a change to the clip editor.
   */
  function gestureTargets() {
    if (clipDrag) return targetsFor(clipDrag.clipId);
    if (drag) return targetsFor(drag.blockId, { includeClips: false });
    return targetsFor(null);
  }

  /** Every overlay clip as a pixel rect the snap builder can read, labelled as a clip. */
  function clipLayouts() {
    const size = preview.renderer.size;
    return clips().map((clip) => {
      const rect = boxRect(clip.box, size);
      return { blockId: clip.id, kind: 'clip', x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  }

  function paint() {
    if (!ctx) return;
    const { dpr, w, h } = resizeOverlay();
    const geo = geometry();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const to = (p) => logicalToOverlay(p, geo);

    for (const line of guideLinesFor({ canvas: geo.size, ...guides, showAll: drag || clipDrag ? showAllTargets : false })) {
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

    // The selected clip first: its outline is the box the handles belong to, and both follow a drag
    // exactly because they are drawn from the clip's *live* box when there is one being dragged.
    const clip = activeClip();
    if (clip) paintClip(clip, geo, to);

    // Selection outline: drawn from the *placed* anchor, so it tracks a drag exactly.
    const layout = selectedLayout() ?? drag?.layout ?? null;
    const anchor = drag?.anchor ?? preview.document?.blocks?.find((b) => b.id === selectedId)?.placement ?? null;
    if (layout && anchor) {
      const r = selectionRect(anchor, geo.size, { width: layout.width, height: layout.height });
      const tl = to({ x: r.x, y: r.y });
      ctx.save?.();
      ctx.strokeStyle = 'rgba(34,197,94,0.9)';
      ctx.lineWidth = 1;
      ctx.setLineDash?.([5, 4]);
      ctx.strokeRect?.(tl.x, tl.y, r.w * geo.scale, r.h * geo.scale);
      ctx.restore?.();
    }
  }

  /**
   * The selected clip: its rotated outline, the stem and round handle for turning it, and the eight
   * resize handles.
   *
   * Every position comes from `render/media-placement.js` — the same `handlePoints()` the hit test uses
   * — so a handle is always drawn exactly where it can be grabbed. Sizes are scaled by the preview's
   * own zoom (logical pixels → what is on screen), so a handle is the same size to the hand whatever the
   * window is.
   */
  function paintClip(clip, geo, to) {
    if (!ctx) return;
    const scale = geo.scale;
    const side = Math.max(7, HANDLE_SIDE_PX * scale);
    const quad = clipQuad(clip, geo.size).map(to);

    ctx.save?.();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = SELECT_COLOUR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash?.([]);
    ctx.beginPath?.();
    ctx.moveTo?.(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) ctx.lineTo?.(quad[i].x, quad[i].y);
    ctx.closePath?.();
    ctx.stroke?.();
    ctx.restore?.();

    // The turning handle: a stem out of the top edge into a round grip.
    const stemStart = to(rotateStemPoint(clip, geo.size));
    const grip = to(rotateHandlePoint(clip, geo.size));
    ctx.save?.();
    ctx.strokeStyle = SELECT_COLOUR;
    ctx.lineWidth = 1;
    ctx.beginPath?.();
    ctx.moveTo?.(stemStart.x, stemStart.y);
    ctx.lineTo?.(grip.x, grip.y);
    ctx.stroke?.();
    ctx.beginPath?.();
    ctx.arc?.(grip.x, grip.y, Math.max(5, side * 0.6), 0, Math.PI * 2);
    ctx.fillStyle = '#0b0b0b';
    ctx.fill?.();
    ctx.stroke?.();
    ctx.restore?.();

    // In crop mode the handles belong to the crop **rectangle**: the whole picture's outline is drawn
    // dashed behind it, the pixels between the two are dimmed, and the survivors are framed solid. That
    // pairing is what makes a crop readable at a glance — the picture's edge is how far the crop can go,
    // the solid rectangle is what it is keeping right now — and it is the only place the uncropped extent
    // ever appears on screen.
    const rotation = Number(clip.rotation) || 0;
    const frame = cropMode?.() ? cropFrameFor(clip) : null;
    const cropRect = frame ? cropRectIn(frame, clip.crop) : null;
    let handles = handlePoints(clip, geo.size);
    if (frame && cropRect) {
      const centre = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
      const rotated = (p) => to(rotatePoint(p, centre, rotation));
      const corners = [
        { x: frame.x, y: frame.y },
        { x: frame.x + frame.w, y: frame.y },
        { x: frame.x + frame.w, y: frame.y + frame.h },
        { x: frame.x, y: frame.y + frame.h },
      ].map(rotated);
      ctx.save?.();
      ctx.strokeStyle = CROP_COLOUR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash?.([6, 4]);
      ctx.beginPath?.();
      ctx.moveTo?.(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo?.(corners[i].x, corners[i].y);
      ctx.closePath?.();
      ctx.stroke?.();
      ctx.restore?.();

      // What is being cut, covered — so "kept" and "gone" are different colours of the same picture.
      ctx.save?.();
      ctx.fillStyle = CROP_DIM_COLOUR;
      for (const band of cropShadeBands(frame, cropRect)) {
        const quad = [
          { x: band.x, y: band.y },
          { x: band.x + band.w, y: band.y },
          { x: band.x + band.w, y: band.y + band.h },
          { x: band.x, y: band.y + band.h },
        ].map(rotated);
        ctx.beginPath?.();
        ctx.moveTo?.(quad[0].x, quad[0].y);
        for (let i = 1; i < quad.length; i++) ctx.lineTo?.(quad[i].x, quad[i].y);
        ctx.closePath?.();
        ctx.fill?.();
      }
      ctx.restore?.();

      // The crop itself: solid, with thirds inside it to line a subject up against.
      const kept = [
        { x: cropRect.x, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y },
        { x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
        { x: cropRect.x, y: cropRect.y + cropRect.h },
      ].map(rotated);
      ctx.save?.();
      ctx.strokeStyle = CROP_COLOUR;
      ctx.lineWidth = 2;
      ctx.setLineDash?.([]);
      ctx.beginPath?.();
      ctx.moveTo?.(kept[0].x, kept[0].y);
      for (let i = 1; i < kept.length; i++) ctx.lineTo?.(kept[i].x, kept[i].y);
      ctx.closePath?.();
      ctx.stroke?.();
      ctx.strokeStyle = CROP_GUIDE_COLOUR;
      ctx.lineWidth = 1;
      ctx.setLineDash?.([3, 5]);
      for (const fraction of [1 / 3, 2 / 3]) {
        const a = rotated({ x: cropRect.x + cropRect.w * fraction, y: cropRect.y });
        const b = rotated({ x: cropRect.x + cropRect.w * fraction, y: cropRect.y + cropRect.h });
        const c = rotated({ x: cropRect.x, y: cropRect.y + cropRect.h * fraction });
        const d = rotated({ x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h * fraction });
        ctx.beginPath?.();
        ctx.moveTo?.(a.x, a.y);
        ctx.lineTo?.(b.x, b.y);
        ctx.moveTo?.(c.x, c.y);
        ctx.lineTo?.(d.x, d.y);
        ctx.stroke?.();
      }
      ctx.restore?.();
      handles = handlePointsForRect(cropRect, rotation);
    }

    for (const handle of handles) {
      const p = to(handle);
      ctx.save?.();
      ctx.fillStyle = '#0b0b0b';
      ctx.strokeStyle = frame ? CROP_COLOUR : SELECT_COLOUR;
      ctx.lineWidth = 1.5;
      ctx.fillRect?.(p.x - side / 2, p.y - side / 2, side, side);
      ctx.strokeRect?.(p.x - side / 2, p.y - side / 2, side, side);
      ctx.restore?.();
    }
  }

  /** Repaint, but only when something the overlay draws could have changed. */
  function refresh({ force = false } = {}) {
    // Nothing to draw and nothing to hit-test: skip before building the key, so an idle editor
    // does not allocate on every animation frame.
    if (!force && !selectedId && !selectedClipId && !drag && !clipDrag) return false;
    const size = preview.renderer.size;
    const cRect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: size.width, height: size.height };
    const clip = activeClip();
    const key = [
      size.width,
      size.height,
      Math.round(cRect.left),
      Math.round(cRect.top),
      Math.round(cRect.width),
      Math.round(cRect.height),
      selectedId ?? '',
      searchKey(clip),
      drag ? 'drag' : '',
      clipDrag?.mode ?? '',
      preview.layouts?.length ?? 0,
      (preview.layouts ?? []).map((l) => `${l.blockId}:${Math.round(l.x)}:${Math.round(l.y)}`).join(','),
    ].join('|');
    if (!force && key === lastKey) return false;
    lastKey = key;
    paint();
    return true;
  }

  /** The part of the paint that depends on a clip's own numbers, rounded so sub-pixel noise is not a change. */
  function searchKey(clip) {
    if (!clip) return '';
    return [
      clip.id,
      Math.round(clip.box.x * 1e4),
      Math.round(clip.box.y * 1e4),
      Math.round(clip.box.w * 1e4),
      Math.round(clip.box.h * 1e4),
      Math.round((Number(clip.rotation) || 0) * 100),
      // The crop is part of the paint (it decides which pixels and which shape), so a crop edit has to
      // change this key or the handles would follow the model while the picture stayed still.
      Math.round((clip.crop?.x ?? 0) * 1e4),
      Math.round((clip.crop?.y ?? 0) * 1e4),
      Math.round((clip.crop?.w ?? 1) * 1e4),
      Math.round((clip.crop?.h ?? 1) * 1e4),
      cropMode?.() ? 'crop' : '',
    ].join(':');
  }

  function select(blockId) {
    selectedId = blockId ?? null;
    if (selectedId && selectedClipId) {
      selectedClipId = null;
      onClipSelect?.(null);
    }
    onSelect?.(selectedId);
    refresh({ force: true });
    return selectedId;
  }

  function selectClip(clipId) {
    const next = clipId ?? null;
    selectedClipId = next;
    if (next && selectedId) {
      selectedId = null;
      onSelect?.(null);
    }
    onClipSelect?.(next);
    refresh({ force: true });
    return selectedClipId;
  }

  /**
   * Nothing is selected: both selections cleared, each change published.
   *
   * The caption side is published even when nothing was selected, because a click on empty space is how a
   * person says "none of these" — a panel still describing the last block after that click would be
   * arguing with them. The clip side is published only when there was a clip: it is a whole object with
   * nothing to re-assert, and a notification per empty click would be noise.
   */
  function clearSelection() {
    const hadClip = Boolean(selectedClipId);
    selectedId = null;
    selectedClipId = null;
    onSelect?.(null);
    if (hadClip) onClipSelect?.(null);
    refresh({ force: true });
    return true;
  }

  function emitPlace(blockId, anchor, info) {
    onPlace?.(blockId, anchor, info);
  }

  function emitClipBox(clipId, box, info) {
    onClipBox?.(clipId, box, info);
  }

  function emitClipRotate(clipId, degrees, info) {
    onClipRotate?.(clipId, degrees, info);
  }

  function emitClipCrop(clipId, crop, info) {
    onClipCrop?.(clipId, crop, info);
  }

  /**
   * Hold Alt to place something freely.
   *
   * Every edge, centre, third, safe area and visible caption is a snap target, which is what makes a
   * deliberately off-centre position hard to land — so the modifier takes the targets away for the rest
   * of the gesture. The guide lines go with them (`paint()` draws from the same set), so the overlay can
   * never promise a pull it will not make. Letting go puts the full set back, mid-drag included, so a
   * position can be nudged close with guides and then finished by hand.
   */
  function applyGuideModifier(free) {
    if (!guides) return;
    if (free) {
      guides.targets = NO_TARGETS;
      guides.snappedX = null;
      guides.snappedY = null;
      return;
    }
    if (guides.targets === NO_TARGETS) guides.targets = gestureTargets();
  }

  /** Drag: pointer down on a block. */
  function onPointerDown(e) {
    if (!enabled || !preview.document) return;
    const geo = geometry();
    const size = geo.size;
    const point = pointToLogical({ rect: geo.cRect, size, clientX: e.clientX, clientY: e.clientY });

    // 1. The selected clip — its handles first, then its own body, so the thing the user has selected
    //    stays grabbable even where a caption overlaps it.
    const selectedClip = clipById(selectedClipId);
    if (selectedClip) {
      const gesture = beginGestureOn(point, selectedClip, size);
      if (gesture) {
        startClipDrag(gesture, point, e);
        return;
      }
    }

    // 2. A caption box.
    const layout = hitTest(preview.layouts ?? [], point);
    if (layout) {
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
      guides = { targets: gestureTargets(), snappedX: null, snappedY: null };
      applyGuideModifier(e.altKey === true);
      overlay.setPointerCapture?.(e.pointerId);
      e.preventDefault?.();
      return;
    }

    // 3. Any other clip, topmost first.
    const clip = hitClip(point, clips(), size);
    if (clip) {
      startClipDrag({ mode: 'move', clipId: clip.id, handle: null }, point, e);
      return;
    }

    // 4. Nothing.
    clearSelection();
  }

  /** Which clip gesture the pointer starts, or `null` when it is not one — see `media-placement.js`. */
  function beginGestureOn(point, clip, size) {
    // While the panel is in crop mode its eight handles live on the **crop frame** — the whole picture's
    // outline — and cut the media instead of resizing the box. The round handle is still the turn, because
    // the two questions are different ones and a mode that hid rotation would make a turned clip
    // uncroppable. The body still moves, so a crop can be positioned without leaving the mode.
    if (cropMode?.()) {
      const rotation = Number(clip.rotation) || 0;
      const rect = cropRectFor(clip);
      const cropHandle = rect ? hitHandle(point, handlePointsForRect(rect, rotation)) : null;
      if (cropHandle) return { mode: 'crop', clipId: clip.id, handle: cropHandle.id };
      // A press *inside* the crop moves the window without changing its size — the gesture a crop needs
      // and a set of sliders cannot express. Outside it the ordinary box move still applies, so the clip
      // can be repositioned without leaving the mode.
      if (pointInRect(point, rect, rotation)) return { mode: 'crop-move', clipId: clip.id, handle: null };
      if (hitRotateHandle(point, clip, size)) return { mode: 'rotate', clipId: clip.id, handle: 'rotate' };
      if (pointInClip(point, clip, size)) return { mode: 'move', clipId: clip.id, handle: null };
      return null;
    }
    if (hitRotateHandle(point, clip, size)) {
      return { mode: 'rotate', clipId: clip.id, handle: 'rotate' };
    }
    const handle = hitHandle(point, handlePoints(clip, size));
    if (handle) return { mode: 'resize', clipId: clip.id, handle: handle.id };
    if (pointInClip(point, clip, size)) return { mode: 'move', clipId: clip.id, handle: null };
    return null;
  }

  /** Begin a clip gesture: remember where it started, so every move is measured from the same place. */
  function startClipDrag(gesture, point, e) {
    const clip = clipById(gesture.clipId);
    if (!clip) return false;
    selectClip(clip.id);
    const size = preview.renderer.size;
    clipDrag = {
      mode: gesture.mode,
      clipId: clip.id,
      handle: gesture.handle,
      startBox: { ...clip.box },
      startRotation: Number(clip.rotation) || 0,
      startPoint: point,
      // The angle the rotation handle had when it was grabbed. Measuring from the *handle* rather
      // than from the clip's own angle is what stops a clip that is already turned from jumping to
      // zero the moment the gesture starts.
      startGrip: gesture.mode === 'rotate' ? rotateHandlePoint(clip, size) : null,
      aspect: aspectFor(clip),
      // The crop a cut is measured against: the rectangle the gesture started with, in the file's frame,
      // and the whole-picture frame it is cut out of. Both are read once, at pointer-down, so every move
      // in the gesture is measured from the same place — dragging the same handle twice as far cannot make
      // the crop jump because a re-fit moved the frame under the pointer.
      startCrop: { ...clip.crop },
      // The whole-picture frame is only needed by the cut; a pan measures against it too, because a drag
      // *inside* the crop is the same number of file pixels whichever part of the picture it sits on.
      startCropFrame: gesture.mode === 'crop' || gesture.mode === 'crop-move' ? cropFrameFor(clip) : null,
      // The file's own size, read once: a pixel-snapped edge must be a pixel of *this* file, and a
      // file that changes size mid-gesture would move every edge the user had already placed.
      media: clipSize?.(clip.id) ?? null,
      box: null,
      rotation: null,
      crop: null,
      moved: false,
    };
    guides = { targets: gestureTargets(), snappedX: null, snappedY: null };
    applyGuideModifier(e.altKey === true);
    overlay.setPointerCapture?.(e.pointerId);
    e.preventDefault?.();
    refresh({ force: true });
    return true;
  }

  /** Drag: pointer move. Snap + clamp, then publish the new anchor immediately (live preview). */
  function onPointerMove(e) {
    if (!enabled) return;
    const geo = geometry();
    const size = geo.size;
    const point = pointToLogical({ rect: geo.cRect, size, clientX: e.clientX, clientY: e.clientY });
    // The modifier is read per event, not per gesture, so pressing or releasing Alt *during* a drag does
    // what it says: the guides come back under the key, which is how a person nudges something close and
    // then finishes the last few pixels by hand.
    if (drag || clipDrag) applyGuideModifier(e.altKey === true);

    if (clipDrag) {
      const clip = clipById(clipDrag.clipId);
      if (!clip) return;
      if (clipDrag.mode === 'rotate') {
        // `clipPixels` answers a *rect*, so its centre is `cx`/`cy` — the angle functions take a point,
        // and handing them the rect would turn the clip about its top-left corner instead of its middle.
        const start = clipPixels({ box: clipDrag.startBox }, size);
        const degrees = rotationFromPointer({
          centre: { x: start.cx, y: start.cy },
          from: clipDrag.startGrip,
          to: point,
          startRotation: clipDrag.startRotation,
        });
        // Shift is "put it on the step": the angle then takes the nearest 15 degrees however far away
        // that is, which is how a person asks for exactly 45 without aiming at it.
        const snapped = snapRotation(degrees, { force: e.shiftKey === true });
        clipDrag.rotation = snapped.degrees;
        clipDrag.moved = true;
        emitClipRotate(clip.id, snapped.degrees, { live: true, snapped: snapped.snapped, commit: false });
      } else if (clipDrag.mode === 'crop') {
        const crop = cropFromHandle({
          handle: clipDrag.handle,
          startCrop: clipDrag.startCrop,
          startRect: clipDrag.startCropFrame,
          point,
          rotation: clipDrag.startRotation,
          media: clipDrag.media,
          // Shift frees the ratio for one drag, the same way it inverts the shape lock: the picker says
          // what the default is, and the modifier says "not this time".
          ratio: e.shiftKey === true ? 0 : Number(cropRatio?.()) || 0,
        });
        clipDrag.crop = crop;
        clipDrag.moved = true;
        emitClipCrop(clip.id, crop, { live: true, commit: false });
      } else if (clipDrag.mode === 'crop-move') {
        const crop = cropFromMove({
          startCrop: clipDrag.startCrop,
          startRect: clipDrag.startCropFrame,
          from: clipDrag.startPoint,
          to: point,
          rotation: clipDrag.startRotation,
          media: clipDrag.media,
        });
        clipDrag.crop = crop;
        clipDrag.moved = true;
        emitClipCrop(clip.id, crop, { live: true, commit: false });
      } else if (clipDrag.mode === 'resize') {
        const resized = boxFromHandle({
          handle: clipDrag.handle,
          startBox: clipDrag.startBox,
          point,
          size,
          rotation: clipDrag.startRotation,
          // The lock is the default and shift inverts it, so one gesture can always do the other thing
          // than whatever the panel is set to.
          keepAspect: Boolean(keepAspect?.()) !== (e.shiftKey === true),
          aspect: clipDrag.aspect,
        });
        clipDrag.box = resized.box;
        clipDrag.moved = true;
        emitClipBox(clip.id, resized.box, { live: true, commit: false, resize: true, handle: clipDrag.handle });
      } else {
        const moved = boxFromMove({ startBox: clipDrag.startBox, startPoint: clipDrag.startPoint, point, size });
        const snapped = snapBox(moved, { targets: guides.targets, size, tolerance: snapTolerance });
        clipDrag.box = snapped.box;
        clipDrag.moved = true;
        guides.snappedX = snapped.snappedX;
        guides.snappedY = snapped.snappedY;
        emitClipBox(clip.id, snapped.box, { live: true, commit: false, guides: snapped });
      }
      refresh({ force: true });
      e.preventDefault?.();
      return;
    }

    if (drag) {
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
      return;
    }

    // Nothing is being dragged: the cursor says what a press would do here.
    updateCursor(point, geo);
  }

  /** Drag: pointer up. `commit` tells the caller this value should survive (undo/history). */
  function onPointerUp(e) {
    if (clipDrag) {
      const { clipId, mode, moved } = clipDrag;
      const box = clipDrag.box ?? clipDrag.startBox;
      const rotation = clipDrag.rotation ?? clipDrag.startRotation;
      const crop = clipDrag.crop ?? clipDrag.startCrop;
      clipDrag = null;
      guides = { targets: { x: [], y: [] }, snappedX: null, snappedY: null };
      // A press that never moved is a *selection*, not an edit: committing one would log a change to a
      // clip nobody changed.
      if (moved) {
        if (mode === 'rotate') emitClipRotate(clipId, rotation, { live: false, commit: true });
        else if (mode === 'crop' || mode === 'crop-move') emitClipCrop(clipId, crop, { live: false, commit: true });
        else emitClipBox(clipId, box, { live: false, commit: true });
      }
      overlay.releasePointerCapture?.(e?.pointerId);
      refresh({ force: true });
      return;
    }
    if (!drag) return;
    const { blockId, anchor } = drag;
    drag = null;
    guides = { targets: { x: [], y: [] }, snappedX: null, snappedY: null };
    emitPlace(blockId, anchor, { preset: presetFor(anchor), live: false, commit: true });
    overlay.releasePointerCapture?.(e?.pointerId);
    refresh({ force: true });
  }

  /** The cursor for the thing under the pointer: a handle's own, `move` over anything draggable, else none. */
  function updateCursor(point, geo) {
    if (!overlay.style) return;
    const clip = clipById(selectedClipId);
    if (clip) {
      if (hitRotateHandle(point, clip, geo.size)) {
        overlay.style.cursor = 'grab';
        return;
      }
      const rotation = Number(clip.rotation) || 0;
      if (cropMode?.()) {
        const rect = cropRectFor(clip);
        const cropHandle = rect ? hitHandle(point, handlePointsForRect(rect, rotation)) : null;
        if (cropHandle) {
          overlay.style.cursor = cropHandle.cursor;
          return;
        }
        if (pointInRect(point, rect, rotation)) {
          overlay.style.cursor = 'move';
          return;
        }
      }
      const handle = hitHandle(point, handlePoints(clip, geo.size));
      if (handle) {
        overlay.style.cursor = handle.cursor;
        return;
      }
    }
    overlay.style.cursor = hitClip(point, clips(), geo.size) || hitTest(preview.layouts ?? [], point) ? 'move' : '';
  }

  /** Keyboard nudge. Ignored while typing, so arrow keys in a text field still work. */
  function onKeyDown(e) {
    const step = ARROW_STEPS[e.key];
    if (!enabled || !step || isTyping(e.target)) return;

    // A selected clip is nudged *as a box*: the same step as a caption, applied to its position,
    // clamped into the frame by the model on the way out.
    const clip = clipById(selectedClipId);
    if (clip) {
      // In crop mode the arrows move the *crop window*, one file pixel at a time (ten with shift): a
      // fractional nudge of a 3840 px file is not a number anyone can check, and the whole point of a
      // precise crop is that the last few pixels can be reached by hand.
      const media = cropMode?.() ? (clipSize?.(clip.id) ?? null) : null;
      if (media) {
        const pixels = CROP_NUDGE_PX * (e.shiftKey ? 10 : 1);
        e.preventDefault?.();
        emitClipCrop(
          clip.id,
          moveCrop(clip.crop, media, step.dxSteps * pixels, step.dySteps * pixels),
          { live: false, commit: true, keyboard: true },
        );
        refresh({ force: true });
        return;
      }
      const multiplier = e.shiftKey ? NUDGE_MULTIPLIER : 1;
      e.preventDefault?.();
      emitClipBox(
        clip.id,
        {
          ...clip.box,
          x: clip.box.x + step.dxSteps * DEFAULT_NUDGE_STEP * multiplier,
          y: clip.box.y + step.dySteps * DEFAULT_NUDGE_STEP * multiplier,
        },
        { live: false, commit: true, keyboard: true },
      );
      refresh({ force: true });
      return;
    }

    if (!selectedId) return;
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
    clipDrag = null;
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
    selectClip,
    refresh,
    setEnabled,
    dispose,
    nudge: (steps, { multiplier = 1 } = {}) => {
      // A selected clip nudges as a box; a selected caption as an anchor. One entry point, because a
      // toolbar button should not have to know which kind of thing is selected.
      const clip = clipById(selectedClipId);
      if (clip) {
        emitClipBox(
          clip.id,
          {
            ...clip.box,
            x: clip.box.x + (steps.dxSteps ?? 0) * DEFAULT_NUDGE_STEP * multiplier,
            y: clip.box.y + (steps.dySteps ?? 0) * DEFAULT_NUDGE_STEP * multiplier,
          },
          { live: false, commit: true },
        );
        refresh({ force: true });
        return clip.box;
      }
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
    get selectedClipId() {
      return selectedClipId;
    },
    get enabled() {
      return enabled;
    },
    get dragging() {
      return Boolean(drag || clipDrag);
    },
    get clipDragging() {
      return clipDrag ? { ...clipDrag, startBox: { ...clipDrag.startBox } } : null;
    },
    get guides() {
      return { ...guides };
    },
  };
}
