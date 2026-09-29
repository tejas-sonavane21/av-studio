/**
 * templates/defs/cinematic-elegant.js — wide-tracked uppercase, low in frame.
 *
 * Two things worth knowing about this one:
 *
 * - `letterSpacing` is an **em fraction**, not pixels (see `render/layout.js#letterSpacingPx`). So
 *   `0.14` means 14 % of the font size between glyphs, which is the "documentary title" look. It is
 *   applied by hand rather than via `ctx.letterSpacing`, which is Chromium-only — a CSS-only feature
 *   would silently render differently in export.
 * - The case is applied at **layout time only** (`applyCase`), so the stored word text keeps its
 *   original casing. A template change is therefore never destructive, and the quality-correction
 *   engine still sees the real words.
 */

export default {
  id: 'cinematic-elegant',
  name: 'Cinematic — Tracked',
  origin: 'generic',
  description: 'Wide-tracked uppercase near the bottom edge; subtle fade. For documentary/interview cuts.',
  defaults: {
    font: { family: 'Lato', weight: 400, size: 0.028, sizeUnit: 'w', italic: false, letterSpacing: 0.14, lineHeight: 1.5, case: 'upper' },
    fill: { color: '#f5f5f0', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.8)', blur: 10, offsetX: 0, offsetY: 2, onDecoration: false },
    display: 'DROPSHADOW',
    reveal: 'all',
    wrapWidth: 0.7,
    maxLines: 3,
    align: 'center',
    anchor: { posX: 0.5, posY: 0.88, gravity: 'center', preset: 'bottom-center' },
    emphasis: { decoration: 'none', italic: false, weightBoost: 0, source: 'keyword' },
    animation: { in: 'fade', inDur: 0.5, out: 'fade', outDur: 0.35, loop: null },
  },
};
