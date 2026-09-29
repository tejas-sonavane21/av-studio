/** templates/defs/capcut-basic-white.js — plain white, centred lower third, no emphasis. */

export default {
  id: 'capcut-basic-white',
  name: 'CapCut — Basic White',
  origin: 'capcut',
  description: 'Plain white sans in the centre-lower third. No emphasis, no box — the safe default.',
  defaults: {
    font: { family: 'Montserrat', weight: 700, size: 0.032, sizeUnit: 'w', italic: false, letterSpacing: 0, lineHeight: 1.25, case: 'none' },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.6)', blur: 8, offsetX: 0, offsetY: 2, onDecoration: false },
    display: 'NORMAL',
    reveal: 'progressive',
    wrapWidth: 0.8,
    maxLines: 3,
    align: 'center',
    anchor: { posX: 0.5, posY: 0.84, gravity: 'center', preset: 'bottom-center' },
    emphasis: { decoration: 'none', italic: false, source: 'keyword' },
    animation: { in: 'fade', inDur: 0.18, out: null, outDur: 0.1, loop: null },
  },
};
