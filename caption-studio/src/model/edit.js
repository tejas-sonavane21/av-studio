/**
 * model/edit.js — editing *what a caption says*.
 *
 * A block's text is not a free-standing string. The model's first load-bearing invariant is
 *
 *     block.text === words.map((w) => w.text).join(' ')
 *
 * and every word's `charFrom`/`charTo` addresses a slice of that text, `styles[]` are character
 * ranges into it, and each word's `emphasis` flag is *derived* from those ranges. So "just overwrite
 * `block.text`" is not a valid edit: it breaks the join invariant and leaves the emphasis ranges
 * pointing at the wrong characters. A text edit therefore rebuilds the block's word list and lets
 * `normalizeBlock` (model/document.js) — the single authority on what a consistent block is — put
 * the offsets, ranges and flags back in order.
 *
 * Two things are deliberately *not* touched:
 *
 * - `overrides` and `placement` — editing what a caption says is not an edit to how it looks, and a
 *   per-block look must survive a typo fix.
 * - `block.start` / `block.end` — the block's span is what its neighbours are laid out around, so an
 *   edit may not move the boundaries.
 *
 * ## Timing when the word count changes
 *
 * When the corrected line has the same number of words as before, every word keeps its own
 * `[start, end]` slot, so a spelling fix cannot nudge the sync. When the count changes there is no
 * slot to inherit, so the block's span is divided between the words in proportion to their length —
 * a rough stand-in for how long a word takes to say, but at least deterministic and explainable.
 *
 * ## What an edit cannot express
 *
 * Inside a block the model keeps words in time order (`normalizeBlock` sorts by `start`), so the
 * reading order *is* the timing order. That is why a wording fix such as
 * `"toll, comes the ultimate"` → `"comes the ultimate toll"` is expressed as a re-typed line: the
 * words change places together with their slots, which is the only arrangement the model can hold.
 */

import { createWord } from './schema.js';
import { isEmphasisStyle, normalizeBlock, rebuildBlockText } from './document.js';

/** Split a line into words exactly the way `block.text` is joined back together. */
export function splitWords(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Divide `[start, end]` across `tokens`, giving each word a share proportional to its length.
 *
 * Boundaries are cumulative, so the words sit end to end with no gap and the last one lands exactly
 * on `end` — rounding can never drift the block's own boundary.
 */
export function apportionTimes(start, end, tokens) {
  const n = tokens.length;
  if (n === 0) return [];
  const from = Number.isFinite(start) ? start : 0;
  const to = Number.isFinite(end) && end > from ? end : from;
  const span = to - from;
  const weights = tokens.map((t) => Math.max(1, String(t).length));
  const total = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = from + (span * acc) / total;
    acc += weights[i];
    const e = i === n - 1 ? to : from + (span * acc) / total;
    out.push({ start: s, end: Math.max(s, e) });
  }
  return out;
}

/**
 * Re-derive the block's emphasis ranges from its words' (already set) `emphasis` flags.
 *
 * The old ranges cannot be reused: they point into the *previous* text, which has just been
 * replaced. Rebuilding them from the words makes `computeEmphasisFlags` a no-op immediately after,
 * which is exactly the consistency `validateDocument` re-checks. The `id`/`style` payload of the
 * block's first emphasis range is carried over so a template's highlight look survives the edit;
 * non-emphasis ranges are dropped, because there is no way to know where their text moved to.
 */
function emphasisStylesFor(block, previous = []) {
  const source = previous.find((st) => isEmphasisStyle(st));
  const id = source?.id ?? 'auto-highlight';
  const style = source?.style ?? { italic: true, underline: true };
  const runs = [];
  let run = null;
  for (const w of block.words) {
    if (!w.emphasis) {
      run = null;
      continue;
    }
    // +1 spans the joining space, so two adjacent keyword words become one range
    if (run && w.charFrom <= run.to + 1) run.to = w.charTo;
    else runs.push((run = { from: w.charFrom, to: w.charTo }));
  }
  return runs.map((r) => ({ from: r.from, to: r.to, id, style }));
}

function findBlock(doc, blockId) {
  return (doc?.blocks ?? []).find((b) => b.id === blockId) ?? null;
}

/**
 * Replace the whole line of a block — the primary content edit.
 *
 * @param {object} doc
 * @param {string} blockId
 * @param {string} text       the caption exactly as it should read
 * @param {{preserveTiming?: boolean}} [options]  `preserveTiming: false` re-divides the span even
 *   when the word count is unchanged (useful when the *timing* was the thing that was wrong).
 * @returns {object|null} the edited block, or null when no such block exists
 */
export function setBlockText(doc, blockId, text, { preserveTiming = true } = {}) {
  const block = findBlock(doc, blockId);
  if (!block) return null;

  const tokens = splitWords(text);
  const previous = block.words ?? [];
  const previousFlags = previous.map((w) => !!w.emphasis);

  const keepSlots = preserveTiming && tokens.length > 0 && tokens.length === previous.length;
  const slots = keepSlots
    ? previous.map((w) => ({ start: w.start, end: w.end }))
    : apportionTimes(block.start, block.end, tokens);

  block.words = tokens.map((t, i) =>
    createWord(t, slots[i].start, slots[i].end, { emphasis: previousFlags[i] ?? false }),
  );
  rebuildBlockText(block); // fills block.text and each word's charFrom/charTo
  block.styles = emphasisStylesFor(block, block.styles);
  normalizeBlock(block);
  return block;
}

/**
 * Replace one word's text, leaving every other word's timing alone.
 *
 * Implemented as a one-word line edit so there is exactly one code path that has to keep the
 * text/word/offset invariants true. `wordIndex` indexes the words of `block.text` in reading order,
 * which for this model is also timing order. A replacement that itself contains whitespace adds
 * words (and may therefore re-divide the block) rather than being rejected.
 *
 * @returns {object|null} the edited block, or null when the block or index does not exist
 */
export function setWordText(doc, blockId, wordIndex, text) {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  const tokens = splitWords(block.text);
  if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= tokens.length) return null;
  tokens[wordIndex] = String(text ?? '');
  return setBlockText(doc, blockId, tokens.join(' '));
}
