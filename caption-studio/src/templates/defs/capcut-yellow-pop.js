/**
 * templates/defs/capcut-yellow-pop.js — bold yellow, black outline, per-word scale pop.
 *
 * The "pop" is the word-scope animation preset, i.e. it runs over `[word.start, word.start + inDur]`
 * for *each* word, so every word springs in as it is revealed. `display: 'OUTLINE'` is Veed's
 * fill + thick stroke mode, which is what gives the heavy black edge.
 */

export default {
  id: 'capcut-yellow-pop',
  name: 'CapCut — Yellow Pop',
  origin: 'capcut',
  description: 'Bold yellow caps with a black outline; each word pops in with a scale overshoot.',
  defaults: {
    font: { family: 'Montserrat', weight: 900, size: 0.042, sizeUnit: 'w', italic: false, letterSpacing: 0, lineHeight: 1.2, case: 'upper' },
    fill: { color: '#ffd400', opacity: 1 },
    stroke: { color: '#000000', width: 0.075 },
    shadow: { color: 'rgba(0,0,0,0.5)', blur: 6, offsetX: 0, offsetY: 3, onDecoration: false },
    display: 'OUTLINE',
    reveal: 'progressive',
    wrapWidth: 0.72,
    maxLines: 2,
    align: 'center',
    anchor: { posX: 0.5, posY: 0.52, gravity: 'center', preset: 'center' },
    emphasis: { decoration: 'none', italic: false, source: 'keyword' },
    animation: { in: 'pop', inDur: 0.16, out: null, outDur: 0.1, loop: null },
  },
};
