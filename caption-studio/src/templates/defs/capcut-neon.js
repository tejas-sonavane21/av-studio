/**
 * templates/defs/capcut-neon.js — magenta-outlined cyan, with a glow.
 *
 * `display: 'OUTLINED'` is Veed's *stroke-only* mode (distinct from `'OUTLINE'`, which is fill +
 * stroke). So the fill here is what the stroke is painted around, and the outer glow comes from
 * `shadow` — a zero-offset, wide-blur shadow reads as a halo rather than a drop shadow.
 *
 * A caveat worth stating plainly: the glow is a Canvas `shadowBlur`, which is a blur of the glyph
 * silhouette, not a real bloom. It is cheap and it survives export, which a filter-based bloom
 * would not (WASM rendering later has no CSS filters).
 */

export default {
  id: 'capcut-neon',
  name: 'CapCut — Neon',
  origin: 'capcut',
  description: 'Uppercase cyan with a magenta outline and a soft glow halo.',
  defaults: {
    font: { family: 'Poppins', weight: 900, size: 0.04, sizeUnit: 'w', italic: false, letterSpacing: 0.02, lineHeight: 1.2, case: 'upper' },
    fill: { color: '#00e5ff', opacity: 1 },
    stroke: { color: '#ff00d4', width: 0.06 },
    shadow: { color: 'rgba(255,0,212,0.55)', blur: 18, offsetX: 0, offsetY: 0, onDecoration: false },
    display: 'OUTLINED',
    reveal: 'progressive',
    wrapWidth: 0.76,
    maxLines: 2,
    align: 'center',
    anchor: { posX: 0.5, posY: 0.5, gravity: 'center', preset: 'center' },
    emphasis: { decoration: 'underline', decorationColor: '#00e5ff', italic: false, weightBoost: 0, source: 'active' },
    animation: { in: 'zoomIn', inDur: 0.14, out: null, outDur: 0.1, loop: null },
  },
};
