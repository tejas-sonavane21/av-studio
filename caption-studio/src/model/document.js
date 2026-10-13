/**
 * model/document.js — operations on a caption document.
 *
 * Invariants enforced here (see plan §5.2):
 *   1. blocks sorted by start, non-overlapping
 *   2. each block's words sorted by start
 *   3. block.text === words.map(text).join(' ')
 *   4. word.charFrom/charTo are consistent with block.text
 *   5. style ranges lie within block.text
 *   6. word.emphasis === overlap of emphasis styles with that word
 *   7. no NaN/Infinity/negative durations
 */

import { newWordId } from './id.js';
import { createDefaultStyle } from './schema.js';
// Normalizing the clip list with the document is deliberate: a `.caproj` is the one place clips arrive
// from outside the app, and a clip that cannot be one (no window, an unknown kind) has to be dropped
// where every other piece of untrusted input is — at the edge, with the rest of the import.
import { normalizeClips } from './media.js';
import { mergeDeep, isPlainObject } from '../util/math.js';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** Recompute block.text and every word's char offsets from its word list. */
export function rebuildBlockText(block) {
  let pos = 0;
  block.words.forEach((w) => {
    w.charFrom = pos;
    w.charTo = pos + String(w.text).length;
    pos = w.charTo + 1; // +1 for the joining space
  });
  block.text = block.words.map((w) => w.text).join(' ');
  return block;
}

/** True when a style range describes emphasis (the AI keyword highlight). */
export function isEmphasisStyle(st, styleId = 'auto-highlight') {
  if (!st) return false;
  if (styleId && st.id === styleId) return true;
  if (st.id === 'auto-highlight') return true;
  if (st.style && st.style.underline === true) return true;
  return false;
}

/** Recompute each word's `emphasis` flag from the block's character-range styles. */
export function computeEmphasisFlags(block, styleId = 'auto-highlight') {
  const n = block.words.length;
  const flags = new Array(n).fill(false);
  for (const st of block.styles || []) {
    if (!isEmphasisStyle(st, styleId)) continue;
    for (let i = 0; i < n; i++) {
      const w = block.words[i];
      const overlap = Math.max(0, Math.min(st.to, w.charTo) - Math.max(st.from, w.charFrom));
      if (overlap > 0 && overlap >= (w.charTo - w.charFrom) * 0.5) flags[i] = true;
    }
  }
  for (let i = 0; i < n; i++) block.words[i].emphasis = flags[i];
  return block.words;
}

/**
 * Bring a single block into canonical form in place:
 * assign ids, sort words, clamp times, rebuild text, recompute emphasis.
 */
export function normalizeBlock(block) {
  if (!Array.isArray(block.words)) block.words = [];
  if (!isPlainObject(block.overrides)) block.overrides = {};
  if (!Array.isArray(block.styles)) block.styles = [];

  block.words.forEach((w) => {
    if (!w.id) w.id = newWordId();
    if (!finite(w.start)) w.start = block.start || 0;
    if (!finite(w.end) || w.end < w.start) w.end = w.start;
  });
  block.words.sort((a, b) => a.start - b.start || a.charFrom - b.charFrom);

  if (finite(block.start) && finite(block.end) && block.end < block.start) {
    [block.start, block.end] = [block.end, block.start];
  }

  rebuildBlockText(block);
  // clamp style ranges to the text
  const len = block.text.length;
  block.styles = block.styles
    .map((st) => ({ ...st, from: Math.max(0, st.from | 0), to: Math.min(len, st.to | 0) }))
    .filter((st) => st.to > st.from);
  computeEmphasisFlags(block);
  return block;
}

/** Normalize a whole document in place. */
export function normalizeDocument(doc) {
  doc.defaults = mergeDeep(createDefaultStyle(), doc.defaults || {});
  if (!Array.isArray(doc.blocks)) doc.blocks = [];
  doc.blocks.forEach(normalizeBlock);
  doc.blocks.sort((a, b) => a.start - b.start);
  doc.media = normalizeClips(doc.media);
  return doc;
}

/**
 * Validate a document against the invariants. Returns { errors, warnings }.
 * Errors block export; warnings are surfaced but recoverable.
 */
export function validateDocument(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') return { errors: ['document is not an object'], warnings };

  if (doc.schemaVersion !== 1) warnings.push(`unexpected schemaVersion ${doc.schemaVersion}`);
  if (!doc.canvas || !finite(doc.canvas.width) || !finite(doc.canvas.height)) {
    errors.push('canvas dimensions missing/invalid');
  }
  if (!Array.isArray(doc.blocks)) return { errors: [...errors, 'blocks is not an array'], warnings };

  let prevEnd = -Infinity;
  doc.blocks.forEach((block, bi) => {
    const where = `block[${bi}] ${block.id || ''}`;
    if (!finite(block.start) || !finite(block.end) || block.end < block.start) {
      errors.push(`${where}: invalid time range`);
    }
    if (block.start < prevEnd - 1e-6) {
      errors.push(`${where}: overlaps previous block (starts ${block.start}, previous ended ${prevEnd})`);
    }
    prevEnd = Math.max(prevEnd, block.end);

    const words = block.words || [];
    for (let i = 1; i < words.length; i++) {
      if (words[i].start < words[i - 1].start - 1e-6) {
        warnings.push(`${where}: words out of order at index ${i}`);
      }
    }
    words.forEach((w, wi) => {
      if (!finite(w.start) || !finite(w.end) || w.end < w.start) {
        errors.push(`${where} word[${wi}]: invalid time range`);
      }
      if (w.start < block.start - 0.5 || w.end > block.end + 0.5) {
        warnings.push(`${where} word[${wi}] "${w.text}": outside block bounds by >0.5s`);
      }
    });

    if (block.text !== words.map((w) => w.text).join(' ')) {
      errors.push(`${where}: text does not match joined words`);
    }
    let pos = 0;
    words.forEach((w, wi) => {
      if (w.charFrom !== pos) errors.push(`${where} word[${wi}]: charFrom ${w.charFrom} !== ${pos}`);
      if (w.charTo !== w.charFrom + String(w.text).length) {
        errors.push(`${where} word[${wi}]: charTo inconsistent`);
      }
      pos = w.charTo + 1;
    });
    (block.styles || []).forEach((st, si) => {
      if (st.from < 0 || st.to > block.text.length || st.to <= st.from) {
        errors.push(`${where} style[${si}]: range [${st.from},${st.to}) outside text length ${block.text.length}`);
      }
    });

    // emphasis consistency (compare against a fresh recomputation)
    const before = words.map((w) => !!w.emphasis);
    computeEmphasisFlags(block);
    words.forEach((w, wi) => {
      if (!!w.emphasis !== before[wi]) {
        warnings.push(`${where} word[${wi}]: emphasis flag was stale and has been corrected`);
      }
    });
  });

  return { errors, warnings };
}

/** The block active at time t, or null. */
export function activeBlockAtTime(doc, t) {
  for (const b of doc.blocks) {
    if (t >= b.start && t <= b.end) return b;
  }
  return null;
}

/** Every block active at time t (blocks are non-overlapping, but this is future-proof). */
export function activeBlocksAtTime(doc, t) {
  return doc.blocks.filter((b) => t >= b.start && t <= b.end);
}

export function totalWords(doc) {
  return doc.blocks.reduce((n, b) => n + b.words.length, 0);
}
