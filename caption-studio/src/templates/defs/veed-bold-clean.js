/**
 * templates/defs/veed-bold-clean.js — Veed's "bold clean": heavy white, soft shadow, no emphasis.
 *
 * The one place this differs from `veed-auto-highlight` beyond colour is `emphasis.decoration:
 * 'none'` — no underline, no italic, no keyword marking. The reveal stays word-by-word, because
 * that is a property of Veed's captions rather than of the highlight template.
 */

export default {
  id: 'veed-bold-clean',
  name: 'Veed — Bold Clean',
  origin: 'veed',
  description: 'Heavy white Inter with a soft drop shadow and no emphasis at all.',
  defaults: {
    font: { family: 'Inter', weight: 900, size: 0.034, sizeUnit: 'w', italic: false, letterSpacing: 0, lineHeight: 1.15, case: 'none' },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.75)', blur: 12, offsetX: 0, offsetY: 2, onDecoration: false },
    display: 'DROPSHADOW',
    reveal: 'progressive',
    wrapWidth: 0.9,
    maxLines: 3,
    align: 'center',
    anchor: { posX: 0.5, posY: 0.848, gravity: 'center', preset: 'bottom-center' },
    emphasis: { decoration: 'none', italic: false, weightBoost: 0, source: 'keyword' },
    animation: { in: 'none', inDur: 0.1, out: null, outDur: 0.1, loop: null },
  },
};
