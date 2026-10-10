/**
 * model/id.js — deterministic, dependency-free id generation.
 *
 * Ids must be *stable per run* so golden alignment tests are byte-identical.
 * A factory returns a counter-based generator; the app may use multiple factories
 * (e.g. one per document) and tests use a fresh one for reproducibility.
 */

export function createIdFactory(prefix = 'id') {
  let n = 0;
  return () => `${prefix}${(++n).toString(36).padStart(4, '0')}`;
}

/** Shared app-wide factories. */
export const newProjectId = createIdFactory('proj');
export const newBlockId = createIdFactory('blk');
export const newWordId = createIdFactory('w');
export const newCorrectionId = createIdFactory('cor');
export const newSegmentId = createIdFactory('seg');
