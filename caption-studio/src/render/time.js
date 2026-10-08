/**
 * render/time.js — what a caption looks like *at one instant*.
 *
 * Pure: (block, word, t) → plain numbers. No canvas, no DOM, no renderer state.
 * Everything downstream (layout, draw, decorations) is a function of this module's output,
 * which is what makes the renderer reproducible frame-by-frame offline (plan §9.1, §16.3).
 *
 * ## The parity contract (verified against v10's renderer)
 *
 * v10 (`referece_material/version10/index.html`) is the version whose output matched the
 * frame-by-frame analysis of the real Veed video, so its timing rules are the reference:
 *
 * ```js
 * const isRevealed = time >= word.s;          // progressive word-by-word reveal
 * if (isRevealed) { fillText(...); if (highlighted) underline(...); }
 * ```
 *
 * Two consequences worth stating explicitly, because they are easy to get wrong:
 *
 * 1. **Unrevealed words still occupy layout space** — v10 advances `startX` for them too, so a
 *    line never reflows as words appear. We lay out the *full* line and draw only revealed
 *    fragments.
 * 2. **The emphasis decoration is not limited to `[word.start, word.end]`.** v10 draws the lime
 *    underline whenever the word is revealed, and the block itself is only drawn while
 *    `block.start <= t <= block.end`. So the underline is on screen for
 *    `[word.start, block.end]` — the whole remaining lifetime of the caption, not just the word's
 *    own speaking time. (This is the "static underline, not karaoke" in plan §9.4: karaoke would
 *    move the highlight from word to word; a static underline stays put.)
 */

import { DRAW_EASE, ease } from './animation.js';
import { clamp } from '../util/math.js';

/** Extra on-screen padding around a block, in seconds. 0 = the v10 behaviour. */
export const DEFAULT_WINDOW = { lead: 0, tail: 0 };

/**
 * How words appear (plan §9.4 + the CapCut/TikTok templates that need more than the Veed rule).
 *
 * - `progressive` — word-by-word at each word's start time. **The default and the Veed parity rule.**
 * - `all` — the whole line appears when the block starts (classic subtitles).
 * - `active` — only the word currently being spoken is visible (TikTok/"one word at a time").
 *   Note layout is unaffected: the other words still occupy their measured space.
 */
export const REVEAL_MODES = ['progressive', 'all', 'active'];

/**
 * Which words an emphasis decoration applies to.
 *
 * - `keyword` — the AI-keyword words (the injected Veed `styles[]` ranges). **The Veed rule.**
 * - `active` — the word currently being spoken, i.e. karaoke / CapCut word highlighting. This is
 *   what makes `capcut-karaoke`, `highlight`, `boxHighlight` and `colourHighlight` real rather
 *   than cosmetic: those presets move the highlight word-by-word instead of marking keywords.
 */
export const EMPHASIS_SOURCES = ['keyword', 'active'];

/** Is a word visible at `t` under the given reveal mode? */
export function isRevealed(word, block, t, mode = 'progressive') {
  switch (mode) {
    case 'all':
      return true;
    case 'active':
      return t >= word.start && t <= word.end;
    case 'progressive':
    default:
      return t >= word.start;
  }
}

/** Is this block on screen at `t`? */
export function isBlockActive(block, t, window = DEFAULT_WINDOW) {
  const lead = window.lead ?? DEFAULT_WINDOW.lead;
  const tail = window.tail ?? DEFAULT_WINDOW.tail;
  return t >= block.start - lead && t <= block.end + tail;
}

/** Every block on screen at `t`, in document order (blocks are non-overlapping by invariant). */
export function activeBlocks(doc, t, window = DEFAULT_WINDOW) {
  return doc.blocks.filter((b) => isBlockActive(b, t, window));
}

/** The single block on screen at `t`, or null. */
export function activeBlock(doc, t, window = DEFAULT_WINDOW) {
  return doc.blocks.find((b) => isBlockActive(b, t, window)) ?? null;
}

/**
 * Visibility of one word at `t`.
 *
 * - `revealed` — the word has been revealed and stays revealed for the rest of the block.
 * - `active`   — `t` is inside the word's own spoken window `[start, end]`. Only karaoke-style
 *                templates use this; the Veed parity look ignores it (that is the whole point).
 * - `emphasis` — whether the word's emphasis decoration should be drawn right now. Equal to
 *                `revealed && word.emphasis` — see the module comment for why it is *not*
 *                gated on `word.end`.
 */
/**
 * Visibility of one word at `t`.
 *
 * @param {object} word
 * @param {number} t
 * @param {object} [opts]
 * @param {string} [opts.reveal='progressive']   REVEAL_MODES
 * @param {string} [opts.emphasisSource='keyword']  EMPHASIS_SOURCES
 */
export function wordState(word, t, { reveal = 'progressive', emphasisSource = 'keyword' } = {}) {
  const revealed = isRevealed(word, null, t, reveal);
  const active = t >= word.start && t <= word.end;
  const emphasis = isEmphasised(word, t, { revealed, active, emphasisSource });
  return { revealed, active, emphasis, emphasisNow: active && emphasisSource === 'active' };
}

/**
 * Should this word's emphasis decoration be drawn right now?
 *
 * `keyword` mode deliberately outlives the word (see the module comment). `active` mode is the
 * opposite: the decoration exists only while the word is being spoken, which is what karaoke
 * highlighting *is*.
 */
export function isEmphasised(word, t, { revealed, active, emphasisSource = 'keyword' }) {
  if (emphasisSource === 'active') return active;
  return revealed && !!word.emphasis;
}

/**
 * How long the emphasis decoration takes to be *drawn*, in seconds.
 *
 * Short enough that a keyword is decorated almost as soon as it is spoken (the word itself is
 * animated over `animation.inDur`, 0.12 s by default) and long enough that the growth is legible at
 * 25–30 fps — about ten frames. Per document, via `style.emphasis.drawDuration`.
 */
export const DEFAULT_DRAW_DURATION = 0.4;

/**
 * When the emphasis decoration for a word first becomes visible.
 *
 * `keyword` decorations are painted whenever the word is revealed (see the module comment), so the
 * moment depends on the reveal mode: a progressive reveal starts each word's decoration at that
 * word's own start, while an `all` reveal puts the whole line (and its decorations) on screen at the
 * block's start. `active` (karaoke) decoration exists only while the word is spoken, so it always
 * begins with the word.
 */
export function emphasisStart(word, block, { reveal = 'progressive', emphasisSource = 'keyword' } = {}) {
  if (emphasisSource === 'active') return word?.start ?? 0;
  if (reveal === 'all') return block?.start ?? word?.start ?? 0;
  return word?.start ?? 0;
}

/**
 * How much of a word's emphasis decoration has been drawn at `t`, in `0..1`.
 *
 * This is the "flow" of the underline: at the instant the decoration appears it is zero, and it
 * grows to its full length — the length the word itself asked for — over `duration` seconds. The
 * value is *eased* (`DRAW_EASE`), not linear, because a constant-rate bar reads as a wipe rather
 * than as a line being drawn.
 *
 * Two boundaries the naive version gets wrong, and this one does not:
 *
 * 1. **A scrub must land on a finished decoration.** The whole thing is a function of absolute
 *    time, so seeking past `start + duration` always yields 1. There is no "has it played yet"
 *    state anywhere.
 * 2. **A decoration may not outlive its own visibility.** `keyword` decorations stay up until the
 *    block ends, so they have room for the full duration; an `active` (karaoke) decoration exists
 *    only inside `[word.start, word.end]`, so the duration is clamped to that window and the line
 *    completes exactly as the word stops being spoken rather than freezing part-drawn.
 *
 * `animate: false` returns 1 everywhere — the pre-Phase-4 behaviour, and the escape hatch for
 * anyone who wants the static parity look.
 */
export function emphasisDrawProgress(
  word,
  block,
  t,
  { reveal = 'progressive', emphasisSource = 'keyword', animate = true, duration = DEFAULT_DRAW_DURATION } = {},
) {
  if (!animate) return 1;
  const start = emphasisStart(word, block, { reveal, emphasisSource });
  const end = emphasisSource === 'active' ? (word?.end ?? start) : (block?.end ?? word?.end ?? start);
  const window = Math.max(0, end - start);
  // A block shorter than the configured duration draws over its whole life instead of freezing
  // half-finished; a zero-length window is "already drawn" rather than a divide-by-zero.
  const dur = Math.min(Math.max(0, duration), window);
  if (!(dur > 0)) return t >= start ? 1 : 0;
  return ease(DRAW_EASE, clamp((t - start) / dur, 0, 1));
}

/** `wordState` for every word in a block, indexed to match `block.words`. */
export function wordStates(block, t, opts) {
  return block.words.map((w) => wordState(w, t, opts));
}

/** Count of revealed words in a block at `t` (used by the typewriter preset and tests). */
export function revealedCount(block, t, reveal = 'progressive') {
  return block.words.reduce((n, w) => n + (isRevealed(w, block, t, reveal) ? 1 : 0), 0);
}

/**
 * Normalised progress through a scope's `in` animation window: `[start, start + dur]`.
 * Returns 1 when `dur <= 0`, i.e. "already finished" — so a zero-length animation is a no-op
 * rather than a divide-by-zero.
 */
export function progressIn(start, dur, t) {
  if (!(dur > 0)) return 1;
  return clamp((t - start) / dur, 0, 1);
}

/** Normalised progress through a scope's `out` animation window: `[end - dur, end]`. */
export function progressOut(end, dur, t) {
  if (!(dur > 0)) return 1;
  return clamp((end - t) / dur, 0, 1);
}

/**
 * The active time window of a block, as `{ start, end }` — the thing `in`/`out` animations
 * are measured against. Also the "static" span used to decide whether a caption is on screen.
 */
export function blockWindow(block, animationWindow = {}) {
  return {
    start: block.start - (animationWindow.lead ?? 0),
    end: block.end + (animationWindow.tail ?? 0),
  };
}
