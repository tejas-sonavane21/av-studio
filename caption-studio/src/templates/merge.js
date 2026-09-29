/**
 * templates/merge.js — how templates, document defaults and per-block overrides compose.
 *
 * ## The merge order, and why it is exactly this
 *
 * ```
 * createDefaultStyle()      ← the verified Veed parity style: the invariant floor
 *   ⊕ document.defaults     ← the chosen template, plus any style edits
 *   ⊕ block.overrides       ← a sparse patch for one block
 *   ⊕ { anchor: block.placement }   ← the per-block position, kept as its own field
 * ```
 *
 * Three decisions in there are load-bearing:
 *
 * 1. **The base is `createDefaultStyle()`, never the current defaults.** Applying a template must be
 *    idempotent and order-independent: `apply(T1)` then `apply(T2)` must equal `apply(T2)`. If the
 *    merge target were the live defaults, a stale value from T1 would leak through any key T2 does
 *    not mention, and switching back and forth would accumulate junk. Merging over a fresh base
 *    makes each template a *complete* style, so switching twice is the same as switching once.
 * 2. **Block overrides can only ever be sparse.** `mergeDeep` treats `null`/`undefined` as "inherit"
 *    (see `util/math.js`), which is what lets a block say `{ font: { size: 0.05 } }` without having
 *    to restate the family — and what makes "reset this block" a one-liner.
 * 3. **`anchor` is promoted from `block.placement`, not from `block.overrides.anchor`.** Position is
 *    edited by dragging and by presets, so it needs to be readable and writable without going
 *    through the generic override bag. Keeping it in one place means `clearOverrides` cannot
 *    accidentally throw away where the user dragged the text to.
 *
 * ## Why there is a cache here
 *
 * `resolveStyle` runs once per active block per frame. It is a deep merge, so it allocates — and the
 * render loop is explicitly not allowed to allocate per frame (plan §13.5). The resolver below
 * memoises on the *content* of the three inputs, so a cache hit and a cache miss are
 * indistinguishable from the outside; only the number of merges changes.
 */

import { createDefaultStyle, resolveStyle as mergeResolveStyle } from '../model/schema.js';
import { mergeDeep, stableStringify, isPlainObject } from '../util/math.js';
import { getTemplate, templateDefaults, hasTemplate } from './index.js';

/** A complete style for a template id: parity base ⊕ the template's defaults. */
export function styleForTemplate(id) {
  const defaults = templateDefaults(id);
  if (!defaults) return createDefaultStyle();
  return { ...mergeDeep(createDefaultStyle(), defaults), templateId: id };
}

/**
 * Apply a template to a document.
 *
 * Replaces `doc.defaults` wholesale (see decision 1 in the module comment) but **preserves per-block
 * overrides and placements**, because those are the user's explicit per-shot decisions rather than
 * an artifact of the template. Mutates `doc` and returns it.
 *
 * @param {object} doc
 * @param {string} id
 * @param {{ overrides?: object }} [patch]  extra defaults merged on top (e.g. keep the user's size)
 */
export function applyTemplate(doc, id, patch = {}) {
  if (!doc) throw new Error('applyTemplate(): a document is required');
  if (!hasTemplate(id)) throw new Error(`applyTemplate(): unknown template "${id}"`);
  doc.defaults = mergeDeep(styleForTemplate(id), patch.overrides ?? null);
  return doc;
}

/** Restore the document to the verified Veed parity style. */
export function resetStyle(doc) {
  if (!doc) return doc;
  doc.defaults = createDefaultStyle();
  return doc;
}

/**
 * Merge a sparse patch into the document defaults (a style edit).
 * Importantly it does **not** clear `templateId`: after editing, the picker should still show which
 * template the style was derived from, exactly as Veed and CapCut do.
 */
export function setDefaults(doc, patch) {
  if (!doc) return null;
  doc.defaults = mergeDeep(doc.defaults, patch);
  return doc.defaults;
}

/** Which template id the document claims, whether or not its style still matches it. */
export function currentTemplateId(doc) {
  return doc?.defaults?.templateId ?? null;
}

/**
 * Is the current style still exactly what `templateId` produces?
 * Lets the UI show "Veed — Auto Highlight (edited)" instead of silently implying an unmodified
 * template.
 */
export function isTemplateUnmodified(doc) {
  const id = currentTemplateId(doc);
  if (!id || !hasTemplate(id)) return false;
  const canonical = styleForTemplate(id);
  const actual = mergeDeep(createDefaultStyle(), doc.defaults);
  // templateId is bookkeeping, not style — exclude it from the comparison on both sides.
  delete canonical.templateId;
  delete actual.templateId;
  return stableStringify(canonical) === stableStringify(actual);
}

// ---------------------------------------------------------------------------
// per-block overrides
// ---------------------------------------------------------------------------

/** Every leaf path in a sparse patch — e.g. `['font.size', 'fill.color']`. */
export function overrideKeys(overrides, prefix = '') {
  const out = [];
  if (!isPlainObject(overrides)) return out;
  for (const [k, v] of Object.entries(overrides)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (isPlainObject(v)) out.push(...overrideKeys(v, path));
    else out.push(path);
  }
  return out;
}

/** A short "3 overrides" style summary for the block list. */
export function overrideSummary(block) {
  const n = overrideKeys(block?.overrides).length;
  const placed = block?.placement ? 1 : 0;
  return { count: n + placed, text: n + placed ? `${n + placed} override(s)` : 'inherits' };
}

/** Merge a sparse patch into one block's overrides. */
export function setBlockOverrides(doc, blockId, patch) {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  block.overrides = mergeDeep(block.overrides, patch);
  return block.overrides;
}

/** Drop a block's style overrides and its placement, so it inherits the document again. */
export function clearBlockOverrides(doc, blockId, { keepPlacement = false } = {}) {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  block.overrides = {};
  if (!keepPlacement) block.placement = null;
  return block;
}

/**
 * "Apply this look to every caption" — fold one block's overrides into the document defaults and
 * clear them from the block, so the block and its siblings are identical again.
 *
 * Order matters: the patch is captured *before* the block's overrides are cleared, otherwise the
 * promoted values would be wiped from both places.
 */
export function promoteBlockToDocument(doc, blockId, { includePlacement = true } = {}) {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  const patch = block.overrides ?? {};
  if (includePlacement && block.placement) patch.anchor = block.placement;
  doc.defaults = mergeDeep(doc.defaults, patch);
  block.overrides = {};
  if (includePlacement) block.placement = null;
  return doc.defaults;
}

/** Set a block's position (normalized fractions) without touching its other overrides. */
export function setBlockPlacement(doc, blockId, placement, { preset = null } = {}) {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  block.placement = {
    posX: placement.posX,
    posY: placement.posY,
    gravity: placement.gravity ?? 'center',
    ...(preset ? { preset } : {}),
  };
  return block.placement;
}

/** Move a block's position to match the document default (undo a drag). */
export function clearBlockPlacement(doc, blockId) {
  const block = findBlock(doc, blockId);
  if (!block) return null;
  block.placement = null;
  return block;
}

export function findBlock(doc, blockId) {
  return (doc?.blocks ?? []).find((b) => b.id === blockId) ?? null;
}

// ---------------------------------------------------------------------------
// cached resolution
// ---------------------------------------------------------------------------

/**
 * A memoising style resolver.
 *
 * Internal-change tracking is intentionally *not* used: blocks are plain JSON, and a version counter
 * would be one more thing an edit path could forget to bump. Hashing the inputs cannot go stale.
 *
 * @param {{ max?: number }} [options]
 */
export function createStyleResolver({ max = 128 } = {}) {
  const cache = new Map();
  let hits = 0;
  let misses = 0;

  function keyFor(doc, block) {
    return stableStringify({
      d: doc?.defaults ?? null,
      o: block?.overrides ?? null,
      p: block?.placement ?? null,
    });
  }

  function resolve(doc, block) {
    const key = keyFor(doc, block);
    const hit = cache.get(key);
    if (hit) {
      hits++;
      // refresh recency: Map preserves insertion order, so re-inserting moves it to the end
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    misses++;
    const style = mergeResolveStyle(doc, block);
    cache.set(key, style);
    while (cache.size > max) cache.delete(cache.keys().next().value);
    return style;
  }

  return {
    resolve,
    invalidate() {
      cache.clear();
    },
    get stats() {
      return { size: cache.size, hits, misses, max };
    },
  };
}
