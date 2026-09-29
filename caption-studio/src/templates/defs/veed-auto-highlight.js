/**
 * templates/defs/veed-auto-highlight.js — **the verified original.**
 *
 * Every value here is the locked spec from the frame-by-frame analysis of the real Veed video, and
 * it is also what `model/schema.js#createDefaultStyle()` returns. This file exists so the template
 * is a first-class, selectable entry with provenance rather than only an implicit default.
 */

export default {
  id: 'veed-auto-highlight',
  name: 'Veed — Auto Highlight',
  origin: 'veed',
  description:
    'The verified original: white Inter 900, lime underline + italic on AI keywords, bottom-right, ' +
    'word-by-word reveal, static (no motion) other than the reveal itself.',
  defaults: {
    font: { family: 'Inter', weight: 900, size: 0.036, sizeUnit: 'w', italic: false, letterSpacing: 0, lineHeight: 1.15, case: 'none' },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.85)', blur: 10, offsetX: 3, offsetY: 3, onDecoration: false },
    display: 'NORMAL',
    reveal: 'progressive',
    wrapWidth: 0.9,
    maxLines: 3,
    align: 'center',
    anchor: { posX: 0.772, posY: 0.848, gravity: 'center', preset: 'bottom-right' },
    emphasis: { styleId: 'auto-highlight', decoration: 'underline', decorationColor: '#22c55e', italic: true, weightBoost: 0, source: 'keyword' },
    animation: { in: 'reveal', inDur: 0.12, out: null, outDur: 0.1, loop: null },
  },
};
