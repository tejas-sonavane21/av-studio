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
 *
 * ## Shaping
 *
 * A block is not only a string: it is the unit the renderer reveals and the unit a line break
 * belongs to. The second half of this module edits *where the captions are* rather than what they
 * say — `splitBlock` cuts one caption into two at a word boundary, `joinBlockWithPrevious` puts it
 * back. Neither touches a word's own timing, so neither can move the sync.
 */

import { createBlock, createWord } from './schema.js';
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

// ---------------------------------------------------------------------------
// shaping — splitting a caption in two, and joining it back
// ---------------------------------------------------------------------------

/**
 * Why splitting exists at all.
 *
 * Inside a block, a word stays on screen once it has been spoken (`render/time.js`), so a caption
 * holding a whole sentence keeps growing until the sentence ends. That is the one thing a real
 * Veed/CapCut caption never does — it breaks the line, and each line reveals on its own. The cure is
 * therefore a content operation, not a rendering one: the user draws the line break, and a line
 * break in this model *is* a block boundary. `splitBlock` is how the editor writes one.
 *
 * Two rules make a split safe to perform mid-session:
 *
 * - **Nothing is re-timed.** The words move between the two blocks carrying their own
 *   `[start, end]`, so a split cannot nudge the sync — unlike re-typing a line whose word count
 *   changed, which has to re-divide the block's span (`apportionTimes`). The only new number is the
 *   cut time, and it is derived from the two words it sits between.
 * - **The look follows the text.** Both halves inherit the original's `overrides` and `placement`
 *   as copies, because a split is not a style edit — and the two halves are independent from then
 *   on, so promoting one later must not drag the other with it.
 */

function indexOfBlock(doc, blockId) {
  return (doc?.blocks ?? []).findIndex((b) => b.id === blockId);
}

/** A deep copy, so two blocks never share a mutable subtree. Documents are plain JSON by contract. */
const cloneJSON = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/**
 * The time a caption is cut at, between two adjacent words.
 *
 * Normally the midpoint of the silence between them, so each half's window ends just after its own
 * last word and begins just before its first. When the words touch it collapses onto that instant,
 * and when they overlap (a bad import can produce that) it lands in the middle of the overlap. The
 * result is always somewhere in `[prev.end, next.start]` or `[next.start, prev.end]`, which is what
 * keeps the two halves exactly contiguous: block windows stay gap-free and non-overlapping whatever
 * the input looked like.
 */
export function splitTimeBetween(prev, next) {
  const from = Number.isFinite(prev?.end) ? prev.end : Number(next?.start) || 0;
  const to = Number.isFinite(next?.start) ? next.start : from;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return Math.min(hi, Math.max(lo, (from + to) / 2));
}

/**
 * Split one caption in two at a word boundary.
 *
 * @param {object} doc
 * @param {string} blockId
 * @param {number} wordIndex  the first word of the **new** block; the split lands before it
 * @returns {{first: object, second: object, cut: number}|null}
 *   null when there is no such block, when the index is not strictly inside its words (a split at
 *   the very first or last word would leave one half empty — a deletion, not a split), or when the
 *   cut would fall on the block's own edge and leave a half with no duration.
 */
export function splitBlock(doc, blockId, wordIndex) {
  const blocks = doc?.blocks ?? [];
  const at = indexOfBlock(doc, blockId);
  if (at < 0) return null;
  const block = blocks[at];
  const words = block.words ?? [];
  if (!Number.isInteger(wordIndex) || wordIndex <= 0 || wordIndex >= words.length) return null;

  const cut = splitTimeBetween(words[wordIndex - 1], words[wordIndex]);
  // A split hands out two *windows*, and a window of no length is not a caption — it would flash
  // for one frame and could only ever be joined back. This is reachable: when two words touch, the
  // cut between them lands on the instant they share, which is the block's own first or last
  // moment when the caption was itself cut there a moment ago.
  if (!(cut > block.start && cut < block.end)) return null;
  // `splice` hands the tail — with its words' own ids, timings and emphasis flags — to the new
  // block in one move, so nothing is re-timed and nothing needs re-identifying.
  const second = createBlock(cut, block.end, words.splice(wordIndex), {
    overrides: cloneJSON(block.overrides ?? {}),
    placement: cloneJSON(block.placement),
    locked: !!block.locked,
  });

  block.end = cut;
  // Order matters. `emphasisStylesFor` reads each word's `charFrom`/`charTo`, and at this instant
  // those still address the *original* block's text — so the halves must re-address their own text
  // first. Skipping this does not fail loudly: the second half's range lands past its own end and
  // `normalizeBlock` drops it, and the highlight silently disappears from the new caption.
  rebuildBlockText(block);
  rebuildBlockText(second);
  // Both halves derive their ranges from their own words, and both read the emphasis *payload*
  // (id/style) off the original block, so the highlight keeps its look in whichever half the word
  // it follows ended up in. `normalizeBlock` then does what a text edit would: re-derive the text,
  // the offsets and the flags. The first half keeps the original id, so the selection and the
  // overlay still know it.
  second.styles = emphasisStylesFor(second, block.styles);
  block.styles = emphasisStylesFor(block, block.styles);
  normalizeBlock(block);
  normalizeBlock(second);

  blocks.splice(at + 1, 0, second);
  return { first: block, second, cut };
}

/**
 * Split a caption at the word boundary nearest an arbitrary time — the "split here" gesture.
 *
 * Returns null when the time is outside the block, because splitting a caption the playhead is not
 * in is never what the user meant; they would have to guess which boundary was chosen.
 */
export function splitBlockAtTime(doc, blockId, time) {
  const block = findBlock(doc, blockId);
  if (!block || !Number.isFinite(time)) return null;
  const words = block.words ?? [];
  if (words.length < 2) return null;
  if (time < block.start || time > block.end) return null;

  let best = -1;
  let bestDistance = Infinity;
  for (let i = 1; i < words.length; i++) {
    const cut = splitTimeBetween(words[i - 1], words[i]);
    // Skip the boundaries `splitBlock` would refuse, so "nearest" is chosen among the cuts that
    // can actually be made rather than landing on a dead end.
    if (!(cut > block.start && cut < block.end)) continue;
    const distance = Math.abs(cut - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best < 0 ? null : splitBlock(doc, blockId, best);
}

/**
 * Merge a caption back into the one before it — the inverse of `splitBlock`.
 *
 * The word lists are concatenated as they are, so every word keeps the timing and the emphasis flag
 * it had in whichever half it came from; a split followed by a join is therefore lossless (only the
 * word ids of a re-typed line would differ, and a split never re-ids anything). The **earlier**
 * block survives and keeps its own id, look and position: joining is reaching backwards for text,
 * and the caption you were already on is the one that stays selected.
 *
 * @returns {object|null} the merged block, or null when there is no block before this one
 */
export function joinBlockWithPrevious(doc, blockId) {
  const blocks = doc?.blocks ?? [];
  const at = indexOfBlock(doc, blockId);
  if (at <= 0) return null;
  const previous = blocks[at - 1];
  const block = blocks[at];

  previous.words = [...(previous.words ?? []), ...(block.words ?? [])];
  // `max` rather than assignment: the survivor must span both, and with sorted non-overlapping
  // blocks this restores exactly the span a split had cut in half.
  previous.end = Math.max(previous.end, block.end);
  // Same ordering rule as `splitBlock`, for the same reason: the second block's words were
  // addressed into *its* text, so the offsets have to be re-derived before the ranges are.
  rebuildBlockText(previous);
  previous.styles = emphasisStylesFor(previous, previous.styles);
  normalizeBlock(previous);
  blocks.splice(at, 1);
  return previous;
}
