/**
 * model/pipeline.js — glue between the alignment engine and the caption document.
 *
 * Kept out of `main.js` so that non-UI consumers can build a renderable document from an alignment
 * result without touching the DOM. The visual parity harness (`tests/visual/`) needs exactly this:
 * the same document the app would render, produced by the same code path, or it would be verifying
 * something the app never shows.
 */

import { normalizeDocument } from './document.js';
import { createDefaultStyle, createDocument } from './schema.js';
import { mergeDeep } from '../util/math.js';

/**
 * Wrap an `alignCaptions()` result in a full caption document.
 *
 * The blocks already satisfy the model invariants — the integration test asserts `validateDocument`
 * reports zero errors *and* zero warnings on the real pair — so normalising here is a safety net
 * (it (re)assigns ids and emphasis flags) rather than a transformation.
 *
 * @param {{blocks: Array, corrections?: Array, report?: object}} aligned
 * @param {object} [aiDoc]  the imported AI document, for canvas size / provenance / style
 * @param {object} [patch]  extra document fields (e.g. `{ name }`)
 */
export function documentFromAlignment(aligned, aiDoc = null, patch = {}) {
  const doc = createDocument({
    name: 'Corrected captions',
    canvas: { ...(aiDoc?.canvas ?? { width: 1280, height: 720 }), fps: 25 },
    sources: {
      ai: aiDoc?.sources?.ai ?? { kind: 'veed-json' },
      truth: aiDoc?.sources?.truth ?? null,
    },
    defaults: mergeDeep(createDefaultStyle(), aiDoc?.defaults),
    blocks: aligned?.blocks ?? [],
    ...patch,
  });
  doc.corrections = aligned?.corrections ?? [];
  if (aligned?.report) doc.meta.report = aligned.report;
  normalizeDocument(doc);
  return doc;
}

/**
 * "Fully revealed" instants for each block — the times at which every word of a block is on screen,
 * which are the only times worth comparing renders at.
 *
 * Returns, per block, the block's last word start (plus a small epsilon) clamped inside the block.
 * Used by the visual harness so a diff is never taken mid-reveal.
 */
export function fullyRevealedTimes(doc, { epsilon = 0.05 } = {}) {
  return (doc?.blocks ?? []).map((block) => {
    const last = block.words[block.words.length - 1];
    if (!last) return block.start;
    return Math.min(block.end, Math.max(block.start, last.start + epsilon));
  });
}
