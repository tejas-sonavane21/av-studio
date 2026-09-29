/**
 * render/renderer.js — the renderer contract and its factory.
 *
 * The point of this file is to keep the *interface* independent of Canvas 2D, so a WebGL2
 * implementation can be dropped in later (the plan's endgame, since Veed's own renderer is
 * WebGL2 + WASM) without touching the editor, the exporter or the tests.
 *
 * ```
 * attach(canvas)            → renderer      bind to a <canvas>; returns the renderer
 * resize({width,height,dpr}) → {width,height}  size the backing store
 * fit(document, box)        → {width,height}  size to the document's aspect inside a box
 * ensureFonts(document)     → Promise<{ok, results}>   never rejects
 * measure(block, style)     → layout        layout without drawing
 * draw(document, time, opts)→ {width,height,blocks,layouts}
 * clear()                   → void
 * dispose()                 → void
 * ```
 *
 * Contract rules every implementation must honour:
 *
 * 1. **`draw(doc, t, opts)` is the only way pixels change**, and it depends on nothing but its
 *    arguments. No accumulated state between frames — that is what makes offline frame rendering
 *    (`export/frames.js`) and the visual-diff harness reproducible.
 * 2. **`time` is seconds as a float**, the same unit as the document model.
 * 3. **`ensureFonts` never rejects and never hangs** — a missing font degrades to a fallback face
 *    and is reported, because a stalled font request must not freeze the app.
 * 4. Drawing happens in **logical units**; DPR is handled inside `resize`/`draw`.
 */

import { createCanvas2DRenderer } from './canvas2d.js';

/** The methods a renderer must expose. Used by `assertRenderer` and the tests. */
export const RENDERER_API = [
  'attach',
  'resize',
  'fit',
  'ensureFonts',
  'measure',
  'draw',
  'clear',
  'dispose',
];

export const RENDERER_KINDS = ['canvas2d'];

/**
 * Create a renderer.
 *
 * @param {'canvas2d'} [kind='canvas2d']
 * @param {object} [options]
 * @param {number} [options.lead=0]   extra seconds of visibility before a block starts
 * @param {number} [options.tail=0]   extra seconds of visibility after a block ends
 * @param {boolean} [options.allowNetworkFonts=true]  permit loading fonts from Google Fonts
 */
export function createRenderer(kind = 'canvas2d', options = {}) {
  switch (kind) {
    case 'canvas2d':
      return createCanvas2DRenderer(options);
    default:
      throw new Error(
        `createRenderer(): unknown renderer "${kind}". Available: ${RENDERER_KINDS.join(', ')}. ` +
          '(A WebGL2 renderer is a planned drop-in implementation of the same interface.)',
      );
  }
}

/** Throw early (with a useful message) if something is not a renderer. */
export function assertRenderer(renderer) {
  const missing = RENDERER_API.filter((m) => typeof renderer?.[m] !== 'function');
  if (missing.length) {
    throw new Error(`not a renderer — missing: ${missing.join(', ')}`);
  }
  return renderer;
}
