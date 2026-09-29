/**
 * align/corrections.js — typed, auditable corrections.
 *
 * Every change the aligner makes is recorded as a correction with a type, confidence
 * and reason. Nothing is silent (plan §8.8) — the UI can accept/reject each one.
 */

import { classifyTextDiff, similarity } from './normalize.js';

/**
 * @returns {'punctuation'|'case'|'replace'|null}
 */
export function classifySubstitution(aiText, truthText) {
  const kind = classifyTextDiff(aiText, truthText);
  return kind === 'same' ? null : kind;
}

export function makeCorrection(id, { type, from = null, to = null, blockId = null, wordId = null, confidence = 1, reason = '' }) {
  return { id, blockId, wordId, type, from, to, confidence, reason, applied: true };
}

export function confidenceFor(type, aiText = '', truthText = '') {
  if (type === 'punctuation' || type === 'case') return 0.99;
  if (type === 'replace') return Math.max(0.3, similarity(aiText, truthText));
  if (type === 'insert') return 0.6;
  if (type === 'delete') return 0.6;
  return 0.5;
}
