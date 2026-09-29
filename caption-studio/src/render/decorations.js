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
