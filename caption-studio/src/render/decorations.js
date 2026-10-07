/**
 * render/decorations.js — the emphasis layer and shared shape helpers.
 *
 * ## The verified Veed emphasis decoration
 *
 * v10 is the reference (`referece_material/version10/index.html`):
 *
 * ```js
 * ctx.shadowColor = 'transparent';                       // shadow suppressed on the decoration
 * ctx.fillStyle = '#22c55e';                             // opaque lime
 * const lineThickness = Math.max(4, effFont * 0.12);
 * const lineY = anchorY + (effFont * 0.55);              // anchorY == the line's middle
 * ctx.fillRect(startX, lineY, wWidth, lineThickness);    // word width, no padding
 * ```
 *
 * Two details that are easy to lose: there is **no horizontal padding** (the underline spans
 * exactly the word), and the shadow is suppressed by setting the *colour* transparent rather than
 * clearing the blur/offset — the net visual effect is the same and it keeps the shadow config
 * intact for the next word.
 *
 * ## px-valued constants
 *
 * Most geometry here is em-relative (`effFontSize × k`) and therefore already scales with the
 * canvas. Two constants are absolute pixels *in the reference video* (1280 px wide): the 4 px
 * minimum underline thickness and the shadow's blur/offset. They are multiplied by
 * `pxScale = canvasWidth / 1280` so the look is exact at the reference size and stays
 * proportionally identical at any other size.
 */

/** The reference width the absolute px constants in the verified spec were measured at. */
export const REFERENCE_WIDTH = 1280;

export const UNDERLINE = Object.freeze({
  /** `max(4 × pxScale, effFontSize × 0.12)` — v10, verbatim. */
  thicknessMin: 4,
  thicknessEm: 0.12,
  /** Distance below the line's middle: `effFontSize × 0.55` — v10, verbatim. */
  offsetEm: 0.55,
});

/**
 * The curved "sweep" underline — a tapered brush stroke that arcs beneath a word in a gentle
 * "S", sweeping slightly down and to the right, with both ends thinning to a point.
 *
 * It is the same *idea* as the parity underline (a decoration under the emphasised word) drawn
 * differently: where the verified Veed look is a flat lime bar, this is a single implied pen stroke.
 * Every number is em-relative except the minimum thickness, which is an absolute px value at the
 * 1280-wide reference and is scaled by `pxScale` exactly like the plain underline's 4 px floor.
 *
 * The geometry is a **polygon** (a ribbon around a sampled centreline), not a `bezierCurveTo`
 * call, for two reasons: a varying-width stroke cannot be drawn with a single `lineWidth`, and a
 * polygon of `lineTo` points is what the deterministic test context can record.
 */
export const SWEEP = Object.freeze({
  /** Distance below the line's middle — a touch lower than the plain underline. */
  offsetEm: 0.62,
  /** Maximum thickness at the fat point of the stroke. */
  thicknessEm: 0.13,
  /** `max(3 × pxScale, effFontSize × thicknessEm)` — the absolute floor. */
  thicknessMin: 3,
  /** How far the stroke overshoots the word on each side, so it reads as a pen flick. */
  overhangEm: 0.08,
  /** Vertical amplitude of the S — half the peak-to-peak of the wave. */
  ampEm: 0.05,
  /** Overall tilt of the stroke, left high to right low (`(u − 0.5) × f × tiltEm`). */
  tiltEm: 0.08,
  /** Polyline resolution. High enough to look smooth, low enough to stay cheap per frame. */
  segments: 24,
});

/** Default box styling for box-rendering display modes and word highlights. */
export const DEFAULT_BOX = Object.freeze({
  color: 'rgba(0, 0, 0, 0.65)',
  opacity: 1,
  radius: 0.2, // em
  paddingX: 0.32, // em
  paddingY: 0.14, // em
});

/** `canvasWidth / 1280` — the factor applied to the absolute px constants. */
export function pxScaleFor(canvasWidth) {
  return canvasWidth > 0 ? canvasWidth / REFERENCE_WIDTH : 1;
}

/**
 * The emphasis underline rectangle for one fragment.
 *
 * @param {{x:number, y:number, width:number}} fragment  laid-out run (in logical px)
 * @param {number} effFontSize                           the block's effective font size
 * @param {number} [pxScale=1]
 */
export function underlineRect(fragment, effFontSize, pxScale = 1) {
  const thickness = Math.max(UNDERLINE.thicknessMin * pxScale, effFontSize * UNDERLINE.thicknessEm);
  return {
    x: fragment.x,
    y: fragment.y + effFontSize * UNDERLINE.offsetEm,
    w: fragment.width,
    h: thickness,
  };
}

/**
 * The polygon for one curved-underline stroke under a fragment.
 *
 * Pure: a fragment, a font size and a px scale in, a closed path out. The centreline is sampled
 * from `u = 0..1` and offset by a tapering half-thickness on each side, so the ribbon is fat in the
 * middle and comes to a point at both ends — the way a brush stroke begins and lifts.
 *
 * @param {{x:number, y:number, width:number}} fragment  laid-out run (in logical px)
 * @param {number} effFontSize                           the block's effective font size
 * @param {number} [pxScale=1]
 * @returns {{ points: Array<{x:number,y:number}>, thickness: number, x0: number, x1: number, baselineY: number }}
 */
export function sweepGeometry(fragment, effFontSize, pxScale = 1) {
  const f = effFontSize > 0 ? effFontSize : 0;
  const width = Math.max(1, fragment?.width ?? 0);
  const x0 = (fragment?.x ?? 0) - SWEEP.overhangEm * f;
  const x1 = (fragment?.x ?? 0) + width + SWEEP.overhangEm * f;
  const span = x1 - x0;
  const baselineY = (fragment?.y ?? 0) + SWEEP.offsetEm * f;
  const thickness = Math.max(SWEEP.thicknessMin * pxScale, f * SWEEP.thicknessEm);
  const n = SWEEP.segments;

  /** The centreline point at `u` in 0..1: a gentle S plus an overall tilt. */
  const centre = (u) => {
    const x = x0 + u * span;
    const wave = SWEEP.ampEm * f * Math.sin(2 * Math.PI * u);
    const tilt = SWEEP.tiltEm * f * (u - 0.5);
    return { x, y: baselineY + tilt + wave };
  };
  /** Half-thickness at `u`: zero at both ends, widest in the middle (a `sin` window). */
  const halfWidth = (u) => (thickness / 2) * Math.pow(Math.sin(Math.PI * u), 0.6);

  const top = [];
  const bottom = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const c = centre(u);
    const a = centre(Math.max(0, u - 1 / n));
    const b = centre(Math.min(1, u + 1 / n));
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const hw = halfWidth(u);
    top.push({ x: c.x - ty * hw, y: c.y + tx * hw });
    bottom.push({ x: c.x + ty * hw, y: c.y - tx * hw });
  }
  return {
    points: [...top, ...bottom.reverse()],
    thickness,
    x0,
    x1,
    baselineY,
  };
}

/** A rounded/hard box hugging one fragment (the CapCut "highlight" / colour-highlight look). */
export function highlightRect(fragment, effFontSize, box = DEFAULT_BOX, lineHeight = 1.15) {
  const padX = (box.paddingX ?? DEFAULT_BOX.paddingX) * effFontSize;
  const padY = (box.paddingY ?? DEFAULT_BOX.paddingY) * effFontSize;
  const h = effFontSize * lineHeight + padY * 2;
  return {
    x: fragment.x - padX,
    y: fragment.y - h / 2,
    w: fragment.width + padX * 2,
    h,
    radius: (box.radius ?? DEFAULT_BOX.radius) * effFontSize,
  };
}

/** The box behind one whole line (LINE_BLOCK_ROUND / LINE_BLOCK_HARD). */
export function lineBoxRect(line, effFontSize, box = DEFAULT_BOX, lineAdvance) {
  const padX = (box.paddingX ?? DEFAULT_BOX.paddingX) * effFontSize;
  const padY = (box.paddingY ?? DEFAULT_BOX.paddingY) * effFontSize;
  const h = (lineAdvance ?? effFontSize * 1.15) + padY * 2;
  return {
    x: line.x - padX,
    y: line.y - h / 2,
    w: line.width + padX * 2,
    h,
    radius: (box.radius ?? DEFAULT_BOX.radius) * effFontSize,
  };
}

/** The box behind an entire block (BLOCK). */
export function blockBoxRect(layout, box = DEFAULT_BOX) {
  const padX = (box.paddingX ?? DEFAULT_BOX.paddingX) * layout.effFontSize * 1.6;
  const padY = (box.paddingY ?? DEFAULT_BOX.paddingY) * layout.effFontSize * 1.6;
  return {
    x: layout.x - padX,
    y: layout.y - padY,
    w: layout.width + padX * 2,
    h: layout.height + padY * 2,
    radius: (box.radius ?? DEFAULT_BOX.radius) * layout.effFontSize * 2,
  };
}

/** Rounded (or square, when `radius` is falsy) rectangle path. Manual, so it is not
 *  dependent on `ctx.roundRect` being present. */
export function roundRectPath(ctx, { x, y, w, h, radius = 0 }) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  if (!r) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Fill a decoration rectangle with the shadow suppressed (the v10 rule). */
export function fillDecoration(ctx, rect, color, { radius = 0, opacity = 1 } = {}) {
  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  roundRectPath(ctx, { ...rect, radius });
  ctx.fill();
  ctx.restore();
}

/**
 * Draw every emphasis underline for a block, once per fragment (a word hard-broken across two
 * lines gets an underline on each piece, which is what "underline the word" must look like).
 *
 * Called *after* the text so the underline sits above it (plan §9.2).
 */
export function drawEmphasisUnderlines(ctx, layout, states, style, pxScale = 1) {
  const color = style.emphasis?.decorationColor ?? '#22c55e';
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = 'transparent';
  for (const line of layout.lines) {
    for (const frag of line.fragments) {
      if (!states[frag.wordIndex]?.emphasis) continue;
      const rect = underlineRect(frag, layout.effFontSize, pxScale);
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
  }
  ctx.restore();
}

/**
 * Draw every curved "sweep" underline for a block, once per fragment — the `decoration: 'sweep'`
 * variant, a tapered pen stroke where the plain underline is a flat bar.
 *
 * Like the plain underline it is painted *after* the text, and it suppresses the shadow the same way
 * (by making the shadow's colour transparent), so the stroke reads as part of the caption rather than
 * as a separate drop shadow under it.
 */
export function drawEmphasisSweep(ctx, layout, states, style, pxScale = 1) {
  const color = style.emphasis?.decorationColor ?? '#ffffff';
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = 'transparent';
  for (const line of layout.lines) {
    for (const frag of line.fragments) {
      if (!states[frag.wordIndex]?.emphasis) continue;
      const { points } = sweepGeometry(frag, layout.effFontSize, pxScale);
      if (!points.length) continue;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Draw word-highlight boxes (the `decoration: 'highlight'` variant).
 *
 * Called *before* the text, because a highlight is a backdrop: text drawn on top of a highlight
 * is the CapCut look, whereas text *under* a highlight would be obscured.
 */
export function drawEmphasisHighlights(ctx, layout, states, style) {
  const box = { ...DEFAULT_BOX, ...(style.box ?? {}) };
  ctx.save();
  ctx.shadowColor = 'transparent';
  for (const line of layout.lines) {
    for (const frag of line.fragments) {
      if (!states[frag.wordIndex]?.emphasis) continue;
      const rect = highlightRect(frag, layout.effFontSize, box, layout.lineHeight);
      ctx.fillStyle = style.emphasis?.highlightColor ?? box.color;
      ctx.globalAlpha = box.opacity ?? 1;
      roundRectPath(ctx, rect);
      ctx.fill();
    }
  }
  ctx.restore();
}
