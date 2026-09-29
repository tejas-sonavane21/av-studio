/**
 * templates/defs/shorts-impact.js — oversized uppercase centre-screen, for 9:16.
 *
 * `display: 'OUTLINE'` here is the fill + thick stroke mode (Veed's own naming), which is what keeps
 * big white type readable over busy footage without a box. Because the text is centred with
 * `gravity: 'center'`, the anchor preset is reusable at any aspect ratio — the box is placed by its
 * centre, so the same template works on 16:9 and 9:16 without editing `posX`/`posY`.
 */

export default {
  id: 'shorts-impact',
  name: 'Shorts — Impact',
  origin: 'generic',
  description: 'Oversized uppercase with a heavy black outline and a bounce-in. Centre-screen; built for 9:16.',
  defaults: {
    font: { family: 'Anton', weight: 400, size: 0.05, sizeUnit: 'w', italic: false, letterSpacing: 0.01, lineHeight: 1.1, case: 'upper' },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0.07 },
    shadow: { color: 'rgba(0,0,0,0.45)', blur: 8, offsetX: 0, offsetY: 3, onDecoration: false },
    display: 'OUTLINE',
    reveal: 'progressive',
    wrapWidth: 0.74,
    maxLines: 2,
    align: 'center',
    anchor: { posX: 0.5, posY: 0.5, gravity: 'center', preset: 'center' },
    emphasis: { decoration: 'none', italic: false, weightBoost: 0, source: 'keyword' },
    animation: { in: 'bounce', inDur: 0.22, out: null, outDur: 0.1, loop: null },
  },
};
