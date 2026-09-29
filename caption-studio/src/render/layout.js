/**
 * render/layout.js — measure, wrap and place text. **Pure.**
 *
 * This is the module the old replica never had. v10 drew one unwrapped line and, if it overflowed,
 * shrank the whole line to fit 90 % of the canvas (its "F7 overflow guard"). Here we wrap properly
 * (plan §9.3) while staying *geometry-identical* to v10 for every line v10 kept on one line — which
 * is Phase 2's exit criterion: "matches the v10 output (which already matched the verified spec)
 * **and** wraps".
 *
 * ## Why the geometry is expressed this way (parity)
 *
 * v10's loop is the reference:
 *
 * ```js
 * ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
 * const wWidth = ctx.measureText(word.text).width;
 * let startX = anchorX - totalW / 2;            // totalW = Σ(word + space) - space
 * ctx.fillText(word.text, startX, anchorY);     // middle-baseline at anchorY
 * startX += wWidth + spaceW;                    // unrevealed words still advance
 * ```
 *
 * So: a word's box is `[x, x + width)` with its **vertical middle on the line's middle y**, and
 * inter-word gaps are a measured space. We reproduce exactly that, then generalise:
 *
 *   line.y       = the *middle* of the line (matching `textBaseline = 'middle'`)
 *   line.x       = left edge of the line
 *   fragment.x   = left edge of one drawable run
 *   boxHeight    = lines.length × fontSize × lineHeight
 *   box centred  = gravity point coincides with the anchor
 *
 * For a single line with `align: 'center'` and `gravity: 'center'` this collapses to
 * `line.x = anchorX − lineWidth / 2` and `line.y = anchorY` — v10 exactly.
 *
 * ## Measuring
 *
 * `measureText` is **injected** so the whole module is testable in Node with no browser (plan §9.3):
 * the tests pass a deterministic fake metric. `letterSpacing` is applied manually
 * (`width += lsPx × (n − 1)`) because canvas `letterSpacing` is Chromium-only.
 */

import { clamp } from '../util/math.js';
import { familyStack } from '../fonts/registry.js';

/** Font size reference: `sizeUnit: 'w'` (Veed parity) or `'h'` (the v10 replica's rule). */
export function fontSizePx(font, canvas) {
  const ref = font?.sizeUnit === 'h' ? canvas.height : canvas.width;
  return (font?.size ?? 0.036) * ref;
}

/** Letter spacing is stored as a fraction of the em (Veed ships it per-mille → ÷1000). */
export function letterSpacingPx(font, effFontSize) {
  return (font?.letterSpacing ?? 0) * effFontSize;
}

/** The CSS `font` shorthand for one fragment. */
export function fontString(font, { size, italic = false }) {
  const weight = font?.weight ?? 900;
  return `${italic ? 'italic ' : ''}${weight} ${size}px ${familyStack(font?.family)}`;
}

/**
 * Apply the display case. Case is applied at **layout time only** so the stored text stays
 * editable (plan §11.4). `toUpperCase` can change a string's length (e.g. `ß` → `SS`), which would
 * desynchronise word char-offsets, so a length-changing mapping is rejected and the original is
 * returned instead.
 */
export function applyCase(text, mode = 'none') {
  const src = String(text);
  let out = src;
  switch (mode) {
    case 'upper':
      out = src.toUpperCase();
      break;
    case 'lower':
      out = src.toLowerCase();
      break;
    case 'title':
      out = src.replace(/\p{L}[\p{L}'’]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
      break;
    case 'sentence':
      out = src.replace(/^\s*(\p{L})/u, (m, c) => m.slice(0, m.length - 1) + c.toUpperCase());
      break;
    default:
      return src;
  }
  return out.length === src.length ? out : src;
}

/** Parse `gravity` ('center', 'bottom-right', 'top') into per-axis values. */
export function normalizeGravity(gravity = 'center') {
  const parts = String(gravity).toLowerCase().split(/[-\s_]+/);
  return {
    x: parts.find((p) => p === 'left' || p === 'right') ?? 'center',
    y: parts.find((p) => p === 'top' || p === 'bottom') ?? 'center',
  };
}

/** Em-relative width of one run, letter-spacing included. */
export function textWidth(measure, text, css, lsPx) {
  const n = [...String(text)].length;
  const base = measure(String(text), css);
  return lsPx && n > 1 ? base + lsPx * (n - 1) : base;
}

/**
 * A measure cache keyed by `(css font, text)`. Created via `createMeasurer(fn)`; `fn` is
 * `(text, cssFont) => pxWidth`. Cleared whenever a font finishes loading (`engine.invalidate()`).
 */
export function createMeasurer(measureText) {
  const cache = new Map();
  return {
    width(text, css) {
      const key = `${css}\u0000${text}`;
      let w = cache.get(key);
      if (w === undefined) {
        w = measureText(text, css) ?? 0;
        // guard against unbounded growth over a long session
        if (cache.size > 20000) cache.clear();
        cache.set(key, w);
      }
      return w;
    },
    clear() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
  };
}

/** Signature of everything a layout depends on — used as the layout cache key. */
export function layoutSignature(block, style, canvas) {
  const f = style.font ?? {};
  const a = style.anchor ?? {};
  const e = style.emphasis ?? {};
  const flags = block.words.map((w) => (w.emphasis ? 1 : 0)).join('');
  return [
    block.text,
    flags,
    f.family, f.weight, f.size, f.sizeUnit, f.italic, f.letterSpacing, f.lineHeight, f.case,
    style.wrapWidth, style.maxLines, style.align,
    a.posX, a.posY, a.gravity,
    e.italic,
    canvas.width, canvas.height,
  ].join('|');
}

/**
 * Lay out one block.
 *
 * @param {object}   o
 * @param {object}   o.block                      caption block (`words[]` with times)
 * @param {object}   o.style                      resolved style (defaults ⊕ overrides)
 * @param {number}   o.canvasWidth
 * @param {number}   o.canvasHeight
 * @param {object}   [o.measurer]                 from `createMeasurer`; built from `measureText` otherwise
 * @param {Function} [o.measureText]              `(text, cssFont) => px`
 * @param {number}   [o.maxAttempts=3]            shrink-to-fit retries (plan §9.3 step 2)
 * @param {number}   [o.shrinkStep=0.95]          font-size reduction per retry
 */
export function layoutBlock({
  block,
  style,
  canvasWidth,
  canvasHeight,
  measurer,
  measureText,
  maxAttempts = 3,
  shrinkStep = 0.95,
}) {
  const measure = measurer ?? createMeasurer(measureText ?? (() => 0));
  const warnings = [];
  const canvas = { width: canvasWidth, height: canvasHeight };

  const font = style.font ?? {};
  const align = style.align ?? 'center';
  const lineHeight = font.lineHeight > 0 ? font.lineHeight : 1.15;
  const baseFontSize = fontSizePx(font, canvas);
  const wrapLimit =
    style.wrapWidth > 0 ? clamp(style.wrapWidth, 0.02, 1) * canvasWidth : Infinity;
  const maxLines = style.maxLines > 0 ? style.maxLines : Infinity;
  const italicOnEmphasis = !!style.emphasis?.italic;

  let effFontSize = baseFontSize;
  let wrapped = null;

  const wrapAt = (eff) => {
    const italic = italicOnEmphasis;
    const regular = fontString(font, { size: eff, italic: false });
    const faded = fontString(font, { size: eff, italic: true });
    const spaceW = measure.width(' ', regular);
    const lsPx = letterSpacingPx(font, eff);

    const tokens = block.words.map((w, wordIndex) => {
      const isItalic = italic && !!w.emphasis;
      const css = isItalic ? faded : regular;
      const text = applyCase(w.text, font.case);
      return {
        wordIndex,
        text,
        css,
        italic: isItalic,
        lsPx,
        width: textWidth(measure.width.bind(measure), text, css, lsPx),
      };
    });

    const lines = [];
    let cur = [];
    let curW = 0;
    const flush = () => {
      if (cur.length) lines.push({ fragments: cur, width: curW });
      cur = [];
      curW = 0;
    };

    for (const token of tokens) {
      const parts =
        Number.isFinite(wrapLimit) && token.width > wrapLimit
          ? hardBreak(token, wrapLimit, measure, warnings)
          : [token];
      for (const part of parts) {
        if (cur.length && curW + spaceW + part.width > wrapLimit) flush();
        curW = cur.length === 0 ? part.width : curW + spaceW + part.width;
        cur.push(part);
      }
    }
    flush();
    return { lines, spaceW, effFontSize: eff };
  };

  // Shrink-to-fit: retry with a smaller font while the block needs more lines than allowed.
  for (let attempt = 0; ; attempt++) {
    wrapped = wrapAt(effFontSize);
    if (wrapped.lines.length <= maxLines || attempt >= maxAttempts) break;
    effFontSize *= shrinkStep;
  }
  // Refinement vs plan §9.3 (which said "clip with a warning"): we never drop words. The block
  // keeps every line and reports the overflow so the UI can flag it; the quality target of 0 %
  // overflow is still measurable from `warnings`.
  if (wrapped.lines.length > maxLines) {
    warnings.push(
      `block needs ${wrapped.lines.length} lines but maxLines is ${maxLines}; all lines kept`,
    );
  }

  const eff = wrapped.effFontSize;
  const lineAdvance = eff * lineHeight;
  const spaceW = wrapped.spaceW;
  const boxHeight = wrapped.lines.length * lineAdvance;
  const boxWidth = wrapped.lines.reduce((m, l) => Math.max(m, l.width), 0);

  const gravity = normalizeGravity(style.anchor?.gravity);
  const anchorX = (style.anchor?.posX ?? 0.5) * canvasWidth;
  const anchorY = (style.anchor?.posY ?? 0.5) * canvasHeight;
  const boxLeft =
    gravity.x === 'left' ? anchorX : gravity.x === 'right' ? anchorX - boxWidth : anchorX - boxWidth / 2;
  const boxTop =
    gravity.y === 'top' ? anchorY : gravity.y === 'bottom' ? anchorY - boxHeight : anchorY - boxHeight / 2;

  const lines = wrapped.lines.map((line, index) => {
    const y = boxTop + (index + 0.5) * lineAdvance;
    const x =
      align === 'left'
        ? boxLeft
        : align === 'right'
          ? boxLeft + boxWidth - line.width
          : boxLeft + (boxWidth - line.width) / 2;
    let cursor = x;
    const fragments = line.fragments.map((f) => {
      const frag = { ...f, x: cursor, lineIndex: index, y };
      cursor += f.width + spaceW;
      return frag;
    });
    // per-word fragment index, so a word spanning a hard break can be decorated as a whole
    const byWord = [];
    fragments.forEach((f) => {
      (byWord[f.wordIndex] ??= []).push(f);
    });
    return { index, fragments, byWord, width: line.width, x, y };
  });

  return {
    blockId: block.id,
    effFontSize: eff,
    baseFontSize,
    scale: baseFontSize > 0 ? eff / baseFontSize : 1,
    lineHeight,
    lineAdvance,
    spaceW,
    wrapLimit,
    width: boxWidth,
    height: boxHeight,
    x: boxLeft,
    y: boxTop,
    align,
    gravity,
    anchorX,
    anchorY,
    lines,
    warnings,
  };
}

/**
 * Split a word that is wider than the whole wrap width into character runs. Every run keeps the
 * source `wordIndex` so the decoration layer can still underline the word as one unit.
 */
function hardBreak(token, limit, measure, warnings) {
  const chars = [...token.text];
  const parts = [];
  let buf = '';
  for (const ch of chars) {
    const next = buf + ch;
    const w = textWidth(measure.width.bind(measure), next, token.css, token.lsPx);
    if (buf && w > limit) {
      parts.push(makePart(token, buf, measure));
      buf = ch;
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(makePart(token, buf, measure));
  warnings.push(`word "${token.text}" is wider than the wrap width and was hard-broken`);
  return parts;
}

function makePart(token, text, measure) {
  return {
    ...token,
    text,
    broken: true,
    width: textWidth(measure.width.bind(measure), text, token.css, token.lsPx),
  };
}

/**
 * A stateful layout engine: measure cache + layout cache + invalidation.
 * The renderer owns exactly one of these (plan §9.3: "cached by (text, font, wrapWidth)").
 */
export function createLayoutEngine({ measureText, maxEntries = 256 } = {}) {
  const measurer = createMeasurer(measureText ?? (() => 0));
  const cache = new Map();
  return {
    /** Layout a block, reusing a cached result when nothing relevant changed. */
    layout(block, style, canvas) {
      const key = layoutSignature(block, style, canvas);
      const hit = cache.get(key);
      if (hit) return hit;
      const fresh = layoutBlock({
        block,
        style,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        measurer,
      });
      if (cache.size >= maxEntries) cache.clear();
      cache.set(key, fresh);
      return fresh;
    },
    measure: measurer,
    /** Call after a font loads or a style changes. */
    invalidate() {
      cache.clear();
      measurer.clear();
    },
    get cacheSize() {
      return cache.size;
    },
  };
}
