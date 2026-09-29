/**
 * templates/defs/minimal-lower-third.js — small, left-aligned, out of the way.
 *
 * The only template here that is **left**-anchored, which is what exercises the horizontal gravity
 * maths in `render/placement.js` and `render/layout.js`: the text box is placed by its left edge at
 * `posX`, so changing the anchor preset moves a different edge than it does for the centred
 * templates. It sits above the common lower-third graphics band rather than inside it.
 */

export default {
  id: 'minimal-lower-third',
  name: 'Minimal — Lower Third',
  origin: 'generic',
  description: 'Small left-aligned sans above the bottom edge. Unobtrusive; good over busy footage.',
  defaults: {
    font: { family: 'Source Sans 3', weight: 600, size: 0.024, sizeUnit: 'w', italic: false, letterSpacing: 0.01, lineHeight: 1.35, case: 'none' },
    fill: { color: '#ffffff', opacity: 0.95 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.9)', blur: 9, offsetX: 1, offsetY: 2, onDecoration: false },
    display: 'NORMAL',
    reveal: 'all',
    wrapWidth: 0.62,
    maxLines: 2,
    align: 'left',
    anchor: { posX: 0.1, posY: 0.9, gravity: 'bottom-left', preset: 'bottom-left' },
    emphasis: { decoration: 'none', italic: false, weightBoost: 0, source: 'keyword' },
    animation: { in: 'fade', inDur: 0.3, out: 'fade', outDur: 0.25, loop: null },
  },
};
