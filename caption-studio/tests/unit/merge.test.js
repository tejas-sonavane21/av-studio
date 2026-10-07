/**
 * merge.test.js — how a template, the document defaults and a block's overrides compose.
 *
 * The two properties that everything in the editor rests on:
 *
 * - **idempotence / order-independence** — applying a template twice, or in a different order, gives
 *   the same style. Without it, switching templates would accumulate leftovers and the picker's
 *   \"which template is this?\" question would become unanswerable.
 * - **overrides can only be sparse** — `null`/`undefined` means \"inherit\", which is what lets one
 *   block change just its size and lets \"reset this block\" be a single assignment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTemplate,
  clearBlockOverrides,
  clearBlockPlacement,
  createStyleResolver,
  currentTemplateId,
  findBlock,
  isTemplateUnmodified,
  overrideKeys,
  overrideSummary,
  promoteBlockToDocument,
  resetStyle,
  setBlockOverrides,
  setBlockPlacement,
  setDefaults,
  shiftDocumentPlacements,
  styleForTemplate,
} from '../../src/templates/merge.js';
import { createBlock, createDefaultStyle, createDocument, createWord, resolveStyle } from '../../src/model/schema.js';
import { stableStringify } from '../../src/util/math.js';

function makeDoc() {
  return createDocument({
    blocks: [
      createBlock(0, 1, [createWord('hello', 0, 0.5, { emphasis: true })]),
      createBlock(1, 2, [createWord('world', 1, 1.5)]),
    ],
  });
}

test('styleForTemplate is the parity base plus the template, tagged with its id', () => {
  // The invariant worth having: the parity template reproduces the verified default values exactly,
  // so "on the parity template" and "on the default style" are the same statement. (Compared field
  // by field rather than with a deep-equal because `mergeDeep` drops null-valued keys — `null` means
  // "inherit" — so the merged style legitimately omits `animation.out: null`.)
  const parity = styleForTemplate('veed-auto-highlight');
  const base = createDefaultStyle();
  assert.equal(parity.templateId, 'veed-auto-highlight');
  assert.deepEqual(parity.font, base.font);
  assert.deepEqual(parity.fill, base.fill);
  assert.deepEqual(parity.stroke, base.stroke);
  assert.deepEqual(parity.shadow, base.shadow);
  assert.deepEqual(parity.anchor, base.anchor);
  assert.equal(parity.display, base.display);
  assert.equal(parity.reveal, base.reveal);
  assert.equal(parity.wrapWidth, base.wrapWidth);
  assert.equal(parity.align, base.align);
  assert.equal(parity.emphasis.decoration, base.emphasis.decoration);
  assert.equal(parity.emphasis.decorationColor, base.emphasis.decorationColor);
  assert.equal(parity.emphasis.italic, base.emphasis.italic);
  assert.equal(parity.emphasis.source, base.emphasis.source);
  assert.equal(parity.animation.in, base.animation.in);
  assert.equal(parity.animation.inDur, base.animation.inDur);

  const neon = styleForTemplate('capcut-neon');
  assert.equal(neon.templateId, 'capcut-neon');
  assert.equal(neon.font.family, 'Poppins');
  // an unknown id degrades to the parity style rather than throwing — this is a lookup helper
  assert.deepEqual(styleForTemplate('nope'), createDefaultStyle());
});

test('applyTemplate replaces the defaults and refuses nonsense', () => {
  const doc = makeDoc();
  doc.defaults = { font: { size: 0.09 }, junk: true };
  applyTemplate(doc, 'capcut-neon');
  assert.equal(doc.defaults.templateId, 'capcut-neon');
  assert.equal(doc.defaults.font.size, 0.04, 'the stale size did not leak through');
  assert.equal(doc.defaults.junk, undefined);
  assert.throws(() => applyTemplate(doc, 'not-a-template'), /unknown template "not-a-template"/);
  assert.throws(() => applyTemplate(null, 'capcut-neon'), /a document is required/);
});

test('applying a template is idempotent', () => {
  const a = makeDoc();
  const b = makeDoc();
  applyTemplate(a, 'veed-karaoke');
  const once = stableStringify(a.defaults);
  applyTemplate(a, 'veed-karaoke');
  assert.equal(stableStringify(a.defaults), once);

  // …which means a template switch is also order-independent: T1→T2 === T2
  applyTemplate(b, 'capcut-neon');
  assert.equal(stableStringify(a.defaults), stableStringify(a.defaults));
  assert.equal(
    stableStringify(styleForTemplate('veed-auto-highlight')),
    stableStringify(styleForTemplate('veed-auto-highlight')),
  );
  applyTemplate(b, 'veed-karaoke');
  assert.equal(stableStringify(b.defaults), once, 'switching via a third template lands identically');
});

test('applying a template keeps per-block overrides and placements', () => {
  const doc = makeDoc();
  setBlockOverrides(doc, doc.blocks[0].id, { font: { size: 0.05 } });
  setBlockPlacement(doc, doc.blocks[1].id, { posX: 0.2, posY: 0.3, gravity: 'center' }, { preset: 'top-left' });
  applyTemplate(doc, 'capcut-yellow-pop');
  assert.deepEqual(doc.blocks[0].overrides, { font: { size: 0.05 } });
  assert.deepEqual(doc.blocks[1].placement, { posX: 0.2, posY: 0.3, gravity: 'center', preset: 'top-left' });
});

test('component overrides never carry a placement (they are separate fields)', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  applyTemplate(doc, 'veed-karaoke');
  setBlockOverrides(doc, id, { anchor: { posX: 0.1, posY: 0.1 } });
  const style = resolveStyle(doc, findBlock(doc, id));
  assert.deepEqual(style.anchor, { posX: 0.1, posY: 0.1, gravity: 'center' }, 'an anchor override still resolves');
  // …and clearing the style overrides leaves the placement alone
  clearBlockOverrides(doc, id, { keepPlacement: true });
  setBlockOverrides(doc, id, { font: { size: 0.05 } });
  clearBlockPlacement(doc, id);
  assert.equal(findBlock(doc, id).placement, null);
  assert.deepEqual(findBlock(doc, id).overrides, { font: { size: 0.05 } });
});

test('currentTemplateId / isTemplateUnmodified track edits without losing provenance', () => {
  const doc = makeDoc();
  applyTemplate(doc, 'capcut-basic-white');
  assert.equal(currentTemplateId(doc), 'capcut-basic-white');
  assert.equal(isTemplateUnmodified(doc), true);

  setDefaults(doc, { font: { size: 0.05 } });
  assert.equal(currentTemplateId(doc), 'capcut-basic-white', 'an edit keeps the template id');
  assert.equal(isTemplateUnmodified(doc), false, 'but the picker can now say "edited"');

  setDefaults(doc, { font: { size: styleForTemplate('capcut-basic-white').font.size } });
  assert.equal(isTemplateUnmodified(doc), true, 'editing back to the template value restores it');

  // a document with no template id at all is never "unmodified"
  const bare = makeDoc();
  bare.defaults = { ...createDefaultStyle(), templateId: undefined };
  assert.equal(currentTemplateId(bare), null);
  assert.equal(isTemplateUnmodified(bare), false);
});

test('resetStyle restores the verified parity style', () => {
  const doc = makeDoc();
  applyTemplate(doc, 'capcut-neon');
  resetStyle(doc);
  assert.deepEqual(doc.defaults, createDefaultStyle());
  assert.equal(currentTemplateId(doc), 'veed-auto-highlight');
  assert.equal(isTemplateUnmodified(doc), true);
  assert.equal(resetStyle(null), null);
});

test('overrideKeys lists leaf paths and ignores "inherit"', () => {
  assert.deepEqual(overrideKeys({ font: { size: 0.05, weight: 700 } }), ['font.size', 'font.weight']);
  assert.deepEqual(overrideKeys({ font: { size: 0.05, weight: null }, fill: undefined }), ['font.size']);
  assert.deepEqual(overrideKeys({}), []);
  assert.deepEqual(overrideKeys(null), []);
  assert.deepEqual(overrideKeys({ emoji: { enabled: false } }), ['emoji.enabled'], 'false is a real override');
});

test('overrideSummary counts style overrides and the placement', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  assert.deepEqual(overrideSummary(doc.blocks[0]), { count: 0, text: 'inherits' });
  setBlockOverrides(doc, id, { font: { size: 0.05 } });
  assert.deepEqual(overrideSummary(findBlock(doc, id)), { count: 1, text: '1 override(s)' });
  setBlockPlacement(doc, id, { posX: 0.1, posY: 0.2 });
  assert.deepEqual(overrideSummary(findBlock(doc, id)), { count: 2, text: '2 override(s)' });
  assert.equal(overrideSummary(null).count, 0);
});

test('setBlockOverrides merges sparsely; unknown blocks are a no-op', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  setBlockOverrides(doc, id, { font: { size: 0.05 } });
  setBlockOverrides(doc, id, { font: { weight: 700 }, fill: { color: '#ff0000' } });
  assert.deepEqual(findBlock(doc, id).overrides, {
    font: { size: 0.05, weight: 700 },
    fill: { color: '#ff0000' },
  });
  assert.equal(setBlockOverrides(doc, 'nope', { font: { size: 1 } }), null);
  assert.equal(findBlock(doc, 'nope'), null);
  // the resolved style keeps the inherited family, which is the point of sparse overrides
  assert.equal(resolveStyle(doc, findBlock(doc, id)).font.family, doc.defaults.font.family);
});

test('clearBlockOverrides drops the style and (by default) the position', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  setBlockOverrides(doc, id, { font: { size: 0.05 } });
  setBlockPlacement(doc, id, { posX: 0.1, posY: 0.2 });
  clearBlockOverrides(doc, id);
  assert.deepEqual(findBlock(doc, id).overrides, {});
  assert.equal(findBlock(doc, id).placement, null);
  assert.equal(clearBlockOverrides(doc, 'nope'), null);
});

test('promoteBlockToDocument folds a block\'s look and position into the defaults', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  setBlockOverrides(doc, id, { font: { size: 0.05 } });
  setBlockPlacement(doc, id, { posX: 0.25, posY: 0.75, gravity: 'center' }, { preset: 'center' });

  const defaults = promoteBlockToDocument(doc, id);
  assert.equal(defaults.font.size, 0.05);
  assert.deepEqual(defaults.anchor, { posX: 0.25, posY: 0.75, gravity: 'center', preset: 'center' });
  assert.deepEqual(findBlock(doc, id).overrides, {}, 'the promoted values are not left duplicated');
  assert.equal(findBlock(doc, id).placement, null);
  // the block is now identical to its siblings
  assert.deepEqual(resolveStyle(doc, doc.blocks[0]), resolveStyle(doc, doc.blocks[1]));
  assert.equal(promoteBlockToDocument(doc, 'nope'), null);
});

test('promote can be asked to leave the position behind', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  setBlockPlacement(doc, id, { posX: 0.25, posY: 0.75 });
  promoteBlockToDocument(doc, id, { includePlacement: false });
  assert.deepEqual(doc.defaults.anchor, createDefaultStyle().anchor, 'the document anchor is untouched');
  assert.deepEqual(findBlock(doc, id).placement, { posX: 0.25, posY: 0.75, gravity: 'center' });
});

test('setBlockPlacement normalises and keeps a preset id only when it is real', () => {
  const doc = makeDoc();
  const id = doc.blocks[0].id;
  assert.deepEqual(setBlockPlacement(doc, id, { posX: 0.1, posY: 0.2 }), {
    posX: 0.1,
    posY: 0.2,
    gravity: 'center',
  });
  assert.deepEqual(setBlockPlacement(doc, id, { posX: 0.1, posY: 0.2, gravity: 'bottom-left' }, { preset: 'bottom-left' }), {
    posX: 0.1,
    posY: 0.2,
    gravity: 'bottom-left',
    preset: 'bottom-left',
  });
  assert.equal(setBlockPlacement(doc, 'nope', { posX: 0, posY: 0 }), null);
});

test('the style resolver memoises on content, not identity', () => {
  const doc = makeDoc();
  const block = findBlock(doc, doc.blocks[0].id);
  const r = createStyleResolver({ max: 4 });
  assert.deepEqual(r.stats, { size: 0, hits: 0, misses: 0, max: 4 });

  const first = r.resolve(doc, block);
  assert.deepEqual(r.stats, { size: 1, hits: 0, misses: 1, max: 4 });
  const second = r.resolve(doc, block);
  assert.equal(second, first, 'a cache hit returns the very same object — allocation-free');
  assert.deepEqual(r.stats, { size: 1, hits: 1, misses: 1, max: 4 });
  assert.equal(r.resolve(doc, block), first);
  assert.equal(r.stats.hits, 2);

  // a content change must miss even though the objects are the same references
  block.overrides = { font: { size: 0.07 } };
  const changed = r.resolve(doc, block);
  assert.notEqual(changed, first);
  assert.equal(changed.font.size, 0.07);
  assert.equal(r.stats.misses, 2);
  assert.deepEqual(changed, resolveStyle(doc, block), 'a hit and a miss are indistinguishable');
});

test('shiftDocumentPlacements moves the default anchor and every placed caption by one delta', () => {
  const doc = makeDoc();
  const [a, b] = doc.blocks.map((block) => block.id);
  setBlockPlacement(doc, a, { posX: 0.2, posY: 0.3, gravity: 'center' }, { preset: 'middle-left' });
  setBlockOverrides(doc, b, { anchor: { posX: 0.6, posY: 0.7, gravity: 'bottom' } });
  const baseX = doc.defaults.anchor.posX;
  const baseY = doc.defaults.anchor.posY;

  shiftDocumentPlacements(doc, { dx: 0.05, dy: -0.1 });

  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  near(doc.defaults.anchor.posX, baseX + 0.05);
  near(doc.defaults.anchor.posY, baseY - 0.1);
  near(findBlock(doc, a).placement.posX, 0.25);
  near(findBlock(doc, a).placement.posY, 0.2);
  near(findBlock(doc, b).overrides.anchor.posX, 0.65);
  near(findBlock(doc, b).overrides.anchor.posY, 0.6);
  // a moved anchor no longer names the preset it used to
  assert.equal(findBlock(doc, a).placement.preset, undefined);
});

test('shiftDocumentPlacements clamps to the canvas and is a no-op at zero', () => {
  const doc = makeDoc();
  const blockId = doc.blocks[0].id;
  setBlockPlacement(doc, blockId, { posX: 0.98, posY: 0.02 });
  const before = JSON.stringify(doc.defaults.anchor);

  shiftDocumentPlacements(doc, {});
  assert.equal(JSON.stringify(doc.defaults.anchor), before, 'a zero delta changes nothing');

  shiftDocumentPlacements(doc, { dx: 0.5, dy: -0.5 });
  assert.equal(findBlock(doc, blockId).placement.posX, 1);
  assert.equal(findBlock(doc, blockId).placement.posY, 0);
  assert.ok(doc.defaults.anchor.posX <= 1 && doc.defaults.anchor.posY >= 0);
});

test('the style resolver evicts and can be invalidated', () => {
  const doc = makeDoc();
  const r = createStyleResolver({ max: 2 });
  const ids = doc.blocks.map((b) => b.id);
  for (const size of [0.02, 0.03, 0.04]) {
    setBlockOverrides(doc, ids[0], { font: { size } });
    r.resolve(doc, findBlock(doc, ids[0]));
  }
  assert.equal(r.stats.size, 2, 'never grows past max');
  r.invalidate();
  assert.equal(r.stats.size, 0);
  assert.equal(r.stats.hits, 0, 'invalidate clears the counter bookkeeping too');
});
