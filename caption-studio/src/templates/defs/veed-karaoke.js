/**
 * templates/defs/veed-karaoke.js — karaoke: the *spoken* word lights up.
 *
 * This is the template that needed the `emphasis.source` generalisation. The verified original uses
 * `source: 'keyword'` — the AI's keyword flags decide which words carry a decoration. Karaoke
 * instead uses `source: 'active'`, so the decoration follows the playhead: the highlight backdrop
 * is drawn behind whichever word is being spoken right now.
 *
 * Notice the split of responsibilities, which is deliberate end to end:
 *
 * - **timing** (`reveal`, `emphasis.source`) comes from the AI source, because word timing is what
 *   the AI source is authoritative about;
 * - **spelling** comes from TRUTH;
 * - **look** is this file.
 *
 * `decoration: 'highlight'` draws a backdrop, so it paints *under* the text (see the paint order in
 * `render/draw-text.js`) — the reverse of the underline, which paints over it.
 */

export default {
  id: 'veed-karaoke',
  name: 'Veed — Karaoke',
  origin: 'veed',
  description: 'White text; the word being spoken sits on a violet highlight block. Emphasis follows the playhead, not the AI keywords.',
  defaults: {
    font: { family: 'Inter', weight: 800, size: 0.034, sizeUnit: 'w', italic: false, letterSpacing: 0, lineHeight: 1.2, case: 'none' },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    shadow: { color: 'rgba(0,0,0,0.6)', blur: 8, offsetX: 0, offsetY: 2, onDecoration: false },
    display: 'NORMAL',
    reveal: 'progressive',
    wrapWidth: 0.86,
    maxLines: 2,
    box: { color: 'rgba(124,58,237,0.95)', opacity: 1, radius: 0.26, paddingX: 0.34, paddingY: 0.16 },
    align: 'center',
    anchor: { posX: 0.5, posY: 0.84, gravity: 'center', preset: 'bottom-center' },
    // source:'active' + decoration:'highlight' is the whole karaoke behaviour.
    emphasis: {
      styleId: 'karaoke',
      decoration: 'highlight',
      decorationColor: null,
      highlightColor: null, // null falls back to box.color
      italic: false,
      weightBoost: 0,
      source: 'active',
    },
    animation: { in: 'karaoke', inDur: 0.08, out: null, outDur: 0.1, loop: null },
  },
};
