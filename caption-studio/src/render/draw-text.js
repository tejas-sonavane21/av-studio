/**
 * render/draw-text.js — turn a resolved layout into pixels, one display mode at a time.
 *
 * ## Paint order (plan §9.2, extended with the highlight backdrop)
 *
 * ```
 * 1. block/line background boxes        BLOCK, LINE_BLOCK_ROUND, LINE_BLOCK_HARD
 * 2. emphasis highlight backdrops       decoration === 'highlight'
 * 3. text                               shadow → stroke → fill   (per display mode)
 * 4. emphasis underlines                decoration === 'underline' | 'sweep'  ← above the text
 * 5. emoji stickers                     render/emoji.js
 * ```
 *
 * The underline goes on top because the verified Veed look has the lime bar crossing the glyph
 * descenders; the highlight goes underneath because a backdrop that covers the text would be
 * useless. That ordering is the whole reason this module exists separately from `layout.js`.
 *
 * ## Transform model
 *
 * `states[wordIndex]` is produced by `time.js` + `animation.js`: it carries `revealed` plus the
 * animation transform `{ opacity, scale, dx, dy }`. `dx`/`dy` are in **em** (fractions of the
 * effective font size) so a `slideUp` preset looks the same at every output resolution.
 *
 * Transforms are applied about the fragment's centre so scaling does not shift inline text.
 */

import {
  DEFAULT_BOX,
  blockBoxRect,
  drawEmphasisHighlights,
  drawEmphasisSweep,
  drawEmphasisUnderlines,
  fillDecoration,
  lineBoxRect,
  roundRectPath,
} from './decorations.js';

const BOX_MODES = new Set(['BLOCK', 'LINE_BLOCK_ROUND', 'LINE_BLOCK_HARD']);

/** Is this display mode one that paints a background box? */
export function isBoxMode(mode) {
  return BOX_MODES.has(mode);
}

/**
 * Configure the 2D context shadow from the style, scaled by `pxScale`.
 * `shadow.onDecoration === false` is handled where decorations are drawn, not here.
 */
export function applyShadow(ctx, shadow, pxScale = 1) {
  if (!shadow?.color || (shadow.blur ?? 0) <= 0) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    return;
  }
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = (shadow.blur ?? 0) * pxScale;
  ctx.shadowOffsetX = (shadow.offsetX ?? 0) * pxScale;
  ctx.shadowOffsetY = (shadow.offsetY ?? 0) * pxScale;
}

/** Draw one background box for the block or its lines, per display mode. */
export function drawDisplayBoxes(ctx, layout, style) {
  const mode = style.display ?? 'NORMAL';
  if (!isBoxMode(mode)) return;
  const box = { ...DEFAULT_BOX, ...(style.box ?? {}) };
  const color = box.color ?? DEFAULT_BOX.color;
  const radius = mode === 'LINE_BLOCK_HARD' ? 0 : box.radius;
  const opacity = box.opacity ?? 1;

  if (mode === 'BLOCK') {
    fillDecoration(ctx, blockBoxRect(layout, box), color, { radius: radius * layout.effFontSize * 2, opacity });
    return;
  }
  for (const line of layout.lines) {
    fillDecoration(ctx, lineBoxRect(line, layout.effFontSize, box, layout.lineAdvance), color, {
      radius: radius * layout.effFontSize,
      opacity,
    });
  }
}

/**
 * Draw the text of a block.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} layout                          from `layout.js`
 * @param {Array}  states                          per-word `{ revealed, emphasis, opacity, scale, dx, dy }`
 * @param {object} style                           resolved style
 * @param {object} [opts]
 * @param {number} [opts.pxScale=1]                scale for absolute px constants
 */
export function drawBlockText(ctx, layout, states, style, { pxScale = 1 } = {}) {
  const mode = style.display ?? 'NORMAL';
  if (mode === 'none') return;

  const fill = style.fill ?? { color: '#ffffff', opacity: 1 };
  const stroke = style.stroke ?? { color: '#000000', width: 0 };
  const eff = layout.effFontSize;
  const strokeW = (stroke.width ?? 0) * eff;
  const strokeColor = stroke.color ?? '#000000';
  const outlined = mode === 'OUTLINED';
  const outlinedFilled = mode === 'OUTLINE';

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  for (const line of layout.lines) {
    for (const frag of line.fragments) {
      const state = states[frag.wordIndex];
      // Progressive reveal: an unrevealed word is simply not drawn. It still occupies its
      // measured space (its `x` was baked into the layout), so nothing reflows.
      if (!state?.revealed) continue;

      ctx.save();
      if (state.dx || state.dy || (state.scale ?? 1) !== 1) {
        const cx = frag.x + frag.width / 2;
        ctx.translate(cx + (state.dx ?? 0) * eff, frag.y + (state.dy ?? 0) * eff);
        ctx.scale(state.scale ?? 1, state.scale ?? 1);
        ctx.translate(-cx, -frag.y);
      }
      // the fill's own opacity times the animation's — a `fade` preset must actually fade
      ctx.globalAlpha = (fill.opacity ?? 1) * (state.opacity ?? 1);
      ctx.font = frag.css;

      if (outlined) {
        // stroke only — hollow text
        ctx.lineWidth = strokeW || eff * 0.04;
        ctx.strokeStyle = strokeColor;
        applyShadow(ctx, null, pxScale);
        ctx.strokeText(frag.text, frag.x, frag.y);
        ctx.restore();
        continue;
      }

      if (outlinedFilled && strokeW > 0) {
        // stroke first, then fill on top, so the fill hides the inner half of the stroke
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = strokeColor;
        applyShadow(ctx, null, pxScale);
        ctx.strokeText(frag.text, frag.x, frag.y);
      }

      applyShadow(ctx, style.shadow, pxScale);
      ctx.fillStyle = fill.color ?? '#ffffff';
      ctx.fillText(frag.text, frag.x, frag.y);
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Draw one block completely, in the documented paint order.
 * This is the single entry point used by the Canvas2D renderer.
 */
export function drawBlock(ctx, layout, states, style, opts = {}) {
  const mode = style.display ?? 'NORMAL';
  if (mode === 'none') return;

  ctx.save();
  drawDisplayBoxes(ctx, layout, style);
  if (style.emphasis?.decoration === 'highlight') {
    drawEmphasisHighlights(ctx, layout, states, style);
  }
  ctx.restore();

  drawBlockText(ctx, layout, states, style, opts);

  const decoration = style.emphasis?.decoration;
  if (decoration === 'underline' || decoration === 'sweep') {
    ctx.save();
    if (style.shadow?.onDecoration === false) ctx.shadowColor = 'transparent';
    if (decoration === 'sweep') drawEmphasisSweep(ctx, layout, states, style, opts.pxScale ?? 1);
    else drawEmphasisUnderlines(ctx, layout, states, style, opts.pxScale ?? 1);
    ctx.restore();
  }
}

/** Draw a simple selection/guide rectangle (used by the preview overlay and the editor). */
export function drawGuideRect(ctx, rect, { color = 'rgba(34,197,94,0.9)', dash = [6, 4], width = 1.5 } = {}) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  roundRectPath(ctx, { ...rect, radius: 0 });
  ctx.stroke();
  ctx.restore();
}
