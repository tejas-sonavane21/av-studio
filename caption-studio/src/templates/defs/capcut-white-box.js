/**
 * templates/defs/capcut-white-box.js — the rounded line block.
 *
 * `display: 'LINE_BLOCK_ROUND'` draws one rounded panel per **line** rather than per word, so the
 * box hugs the wrapped line. That makes it the display mode most sensitive to the wrap width — a
 * line that wraps where it should not produces two boxes instead of one, which is exactly the class
 * of defect the layout engine was written to fix.
 */

export default {
  id: 'capcut-white-box',
  name: 'CapCut — White on Box',
  origin: 'capcut',
  description: 'White text on a rounded dark panel hugging each line. Line-level blocks, not word-level.',
  defaults: {
    font: { family: 'Montserrat', weight: 800, size: 0.034, sizeUnit: 'w', italic: false, letterSpacing: 0, lineHeight: 1.25, case: 'none' },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.4)', blur: 6, offsetX: 0, offsetY: 2, onDecoration: false },
    display: 'LINE_BLOCK_ROUND',
    reveal: 'progressive',
    wrapWidth: 0.78,
    maxLines: 2,
    box: { color: 'rgba(17,17,17,0.82)', opacity: 1, radius: 0.28, paddingX: 0.42, paddingY: 0.2 },
    align: 'center',
    anchor: { posX: 0.5, posY: 0.82, gravity: 'center', preset: 'bottom-center' },
    emphasis: { decoration: 'none', italic: false, weightBoost: 0, source: 'keyword' },
    animation: { in: 'fade', inDur: 0.16, out: null, outDur: 0.1, loop: null },
  },
};
