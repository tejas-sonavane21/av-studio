/**
 * render/canvas2d.js — the Canvas 2D renderer.
 *
 * Implements the contract in `renderer.js`. The one rule that keeps this module honest:
 *
 * > **The only input to drawing is `(captionDocument, time, opts)`.** No renderer state survives a
 * > frame (plan §9.1).
 *
 * Everything the renderer caches (measured widths, laid-out blocks) is a pure function of the
 * document + canvas size, so a cache miss and a cache hit are indistinguishable — which is what
 * makes offline frame rendering and the visual-diff harness reproducible.
 *
 * Device pixel ratio: the backing store is `logical × dpr` and the context is pre-scaled once per
 * frame, so all drawing happens in logical units and nothing in the layout/draw code needs to know
 * about DPR.
 */

import { resolveStyle } from '../model/schema.js';
import { createLogger } from '../util/log.js';
import { ensureFontsFor } from '../fonts/loader.js';
import { animationAt } from './animation.js';
import { blockBoxRect, pxScaleFor } from './decorations.js';
import { drawBlock, drawGuideRect } from './draw-text.js';
import { createEmojiLayer } from './emoji.js';
import { createLayoutEngine } from './layout.js';
import { SAFE_AREAS } from './placement.js';
import { DEFAULT_DRAW_DURATION, activeBlocks, emphasisDrawProgress, wordState } from './time.js';

const log = createLogger('render');

/**
 * Title-safe / action-safe fractions (plan §12.4).
 * Re-exported from `placement.js`, which is the canonical definition — the guide rectangles drawn
 * here and the safe-area snap targets the editor uses must be the same numbers, or a caption could
 * snap to a line that is not where it is drawn.
 */
export { SAFE_AREAS };

export function createCanvas2DRenderer(options = {}) {
  const { lead = 0, tail = 0, allowNetworkFonts = true, emojiResolution = 64 } = options;

  let canvas = null;
  let ctx = null;
  let engine = null;
  let emoji = null;
  let logical = { width: 1280, height: 720 };
  let dpr = 1;
  let fontsReady = false;

  // Reusable scratch objects — the render loop must not allocate per frame (plan §13.5).
  const states = [];
  const scratch = [];

  function attach(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el?.getContext) throw new Error('renderer.attach(): a <canvas> element is required');
    canvas = el;
    ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      // Fail here rather than inside the first measureText() with an opaque TypeError.
      throw new Error('renderer.attach(): the canvas has no 2D context');
    }
    engine = createLayoutEngine({
      measureText: (text, css) => {
        ctx.font = css;
        return ctx.measureText(text).width;
      },
    });
    emoji = createEmojiLayer({ allowNetwork: allowNetworkFonts, resolution: emojiResolution });
    return api;
  }

  /**
   * Resize the backing store to `logical × dpr`.
   * `applyCssSize` also sets the element's CSS size, which is what a preview wants; an export
   * canvas would pass `false` and be sized by its own container.
   */
  function resize({
    width,
    height,
    devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    applyCssSize = true,
  } = {}) {
    if (!canvas) return logical;
    const w = Math.max(1, Math.round(width ?? logical.width));
    const h = Math.max(1, Math.round(height ?? logical.height));
    dpr = Math.max(1, Number(devicePixelRatio) || 1);
    logical = { width: w, height: h };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (applyCssSize && canvas.style) {
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    engine?.invalidate();
    return logical;
  }

  /**
   * Fit the document's aspect ratio inside a box and resize to it.
   * Returns the logical size actually used (plan §9.8: export must not depend on window size).
   */
  function fit(doc, box = {}, opts = {}) {
    const aspect = (doc?.canvas?.width ?? 16) / (doc?.canvas?.height ?? 9);
    const maxW = Math.max(1, box.width ?? logical.width);
    const maxH = Math.max(1, box.height ?? logical.height);
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    return resize({ width: Math.round(w), height: Math.round(h), ...opts });
  }

  /** Load every font the document needs, then invalidate measurements. Never rejects. */
  async function ensureFonts(doc) {
    const result = await ensureFontsFor(doc, { allowNetwork: allowNetworkFonts });
    const missing = result.results.filter((r) => !r.ok);
    if (missing.length) {
      log.warn(
        `font(s) unavailable — layout will use fallback faces: ${missing
          .map((m) => `${m.family} ${m.weight}`)
          .join(', ')}`,
      );
    }
    fontsReady = true;
    engine?.invalidate();
    return result;
  }

  /**
   * Build (into a reused array) the per-word render state for a block at time `t`.
   *
   * Beyond visibility and the word's own entrance transform, this is where the emphasis decoration's
   * **draw progress** is computed — the single number that makes an underline flow instead of appear.
   * It is derived from `t` and nothing else (see `time.js#emphasisDrawProgress`), so seeking to the
   * middle of a caption paints the decoration exactly as playing through it would have.
   */
  function buildStates(block, style, t) {
    const words = block.words;
    const timing = { reveal: style.reveal, emphasisSource: style.emphasis?.source };
    const draw = {
      ...timing,
      // `animate` defaults to on, so only an explicit `false` turns the flow off.
      animate: style.emphasis?.animate !== false,
      duration: style.emphasis?.drawDuration ?? DEFAULT_DRAW_DURATION,
    };
    states.length = words.length;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const state =
        states[i] ?? (states[i] = { revealed: false, active: false, emphasis: false, drawProgress: 1 });
      const st = wordState(word, t, timing);
      state.revealed = st.revealed;
      state.active = st.active;
      state.emphasis = st.emphasis;
      state.drawProgress = emphasisDrawProgress(word, block, t, draw);
      const s = scratch[i] ?? (scratch[i] = { opacity: 1, scale: 1, dx: 0, dy: 0 });
      animationAt(style.animation, { start: word.start, end: block.end }, t, s);
      state.opacity = s.opacity;
      state.scale = s.scale;
      state.dx = s.dx;
      state.dy = s.dy;
    }
    return states;
  }

  /** Clear the canvas. */
  function clear() {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw(doc, t, opts = {}) {
    if (!ctx || !doc) return null;
    const { guides = false, safeAreas = false } = opts;
    const { width, height } = logical;
    const pxScale = pxScaleFor(width);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const drawn = [];
    for (const block of activeBlocks(doc, t, { lead, tail })) {
      const style = resolveStyle(doc, block);
      const layout = engine.layout(block, style, logical);
      const blockStates = buildStates(block, style, t);
      drawBlock(ctx, layout, blockStates, style, { t, pxScale });
      if (style.emoji?.enabled) {
        emoji.draw(ctx, layout, block, blockStates, style, { canvasWidth: width });
      }
      drawn.push(layout);
    }

    if (guides || safeAreas) drawGuides(doc, { theme: opts.theme, layouts: drawn, safeAreas });
    return { width, height, blocks: drawn.length, layouts: drawn };
  }

  /** Safe-area rectangles, centre lines and the block box — for the editor, never for export. */
  function drawGuides(doc, { layouts = [], safeAreas = false } = {}) {
    const { width, height } = logical;
    ctx.save();
    for (const layout of layouts) {
      drawGuideRect(ctx, blockBoxRect(layout, { radius: 0, paddingX: 0, paddingY: 0 }), {
        color: 'rgba(34,197,94,0.55)',
      });
    }
    if (safeAreas) {
      for (const [name, frac] of Object.entries(SAFE_AREAS)) {
        const w = width * frac;
        const h = height * frac;
        drawGuideRect(
          ctx,
          { x: (width - w) / 2, y: (height - h) / 2, w, h },
          { color: name === 'titleSafe' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.2)' },
        );
      }
    }
    // centre lines
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Measure one block without drawing it (the `measure()` half of the contract). */
  function measure(block, style, canvas = logical) {
    return engine.layout(block, style, canvas);
  }

  function dispose() {
    engine?.invalidate();
    emoji?.clear();
    engine = null;
    emoji = null;
    ctx = null;
    canvas = null;
  }

  const api = {
    kind: 'canvas2d',
    attach,
    resize,
    fit,
    ensureFonts,
    measure,
    draw,
    clear,
    dispose,
    get canvas() {
      return canvas;
    },
    get context() {
      return ctx;
    },
    get size() {
      return { ...logical, dpr };
    },
    get fontsReady() {
      return fontsReady;
    },
    get layoutEngine() {
      return engine;
    },
  };
  return api;
}
