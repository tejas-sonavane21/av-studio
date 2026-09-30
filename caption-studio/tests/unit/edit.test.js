/**
 * edit.test.js — editing a caption's text without breaking the model.
 *
 * A text edit is the one operation that can touch every part of a block at once: the words, their
 * timings, the joined `block.text`, the `charFrom`/`charTo` offsets and the emphasis ranges. The
 * tests below are grouped by the promise each behaviour makes:
 *
 * - the text reads back exactly what was typed (the reported wording fix);
 * - a same-length line keeps its sync, a different-length line stays inside the block's span;
 * - the keyword highlight follows the *words*, not stale character offsets;
 * - an edit to content is never an edit to looks or position.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apportionTimes, setBlockText, setWordText, splitWords } from '../../src/model/edit.js';
import { normalizeDocument, validateDocument } from '../../src/model/document.js';
import { createBlock, createDocument, createWord } from '../../src/model/schema.js';

/** A document whose blocks are normalized, i.e. exactly what the editor would be holding. */
function makeDoc(blocks) {
  return normalizeDocument(createDocument({ blocks }));
}

/** The classic reported case: `block.text` is `"toll, comes the ultimate"` but the audio says otherwise. */
function reportedDoc() {
  const block = createBlock(10, 14, [
    createWord('toll,', 10, 11),
    createWord('comes', 11, 12),
    createWord('the', 12, 12.5),
    createWord('ultimate', 12.5, 14),
  ]);
  block.styles = [
    { from: 0, to: 5, id: 'auto-highlight', style: { italic: true, underline: true, color: '#fff' } },
  ];
  return makeDoc([block]);
}

test('splitWords collapses whitespace and drops empties', () => {
  assert.deepEqual(splitWords('  a  b\n c '), ['a', 'b', 'c']);
  assert.deepEqual(splitWords(''), []);
  assert.deepEqual(splitWords(null), []);
});

test('apportionTimes covers the span exactly and lengthens with the word', () => {
  const slots = apportionTimes(0, 4, ['a', 'elongate']);
  assert.equal(slots[0].start, 0);
  assert.equal(slots[slots.length - 1].end, 4);
  assert.ok(slots[1].start >= slots[0].end);
  const short = slots[0].end - slots[0].start;
  const long = slots[1].end - slots[1].start;
  assert.ok(long > short, 'a longer word should be given more of the span');
  assert.deepEqual(apportionTimes(0, 1, []), []);
});

test('a re-typed line with the same word count keeps every timing slot', () => {
  const doc = reportedDoc();
  const id = doc.blocks[0].id;
  const before = doc.blocks[0].words.map((w) => [w.start, w.end]);

  const block = setBlockText(doc, id, 'comes the ultimate toll');

  assert.equal(block.text, 'comes the ultimate toll');
  assert.deepEqual(
    block.words.map((w) => [w.start, w.end]),
    before,
    'sync must not move for a same-length fix',
  );
  assert.equal(block.start, 10);
  assert.equal(block.end, 14);
});

test('a text edit keeps text, offsets and ranges mutually consistent', () => {
  const doc = reportedDoc();
  const block = setBlockText(doc, doc.blocks[0].id, 'the ultimate toll comes');

  assert.equal(block.text, block.words.map((w) => w.text).join(' '));
  let pos = 0;
  for (const w of block.words) {
    assert.equal(w.charFrom, pos);
    assert.equal(w.charTo, pos + w.text.length);
    pos = w.charTo + 1;
  }
  for (const st of block.styles) {
    assert.ok(st.from >= 0 && st.to <= block.text.length && st.to > st.from);
  }
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('emphasis follows the word position, and its payload survives the edit', () => {
  const doc = reportedDoc();
  const block = setBlockText(doc, doc.blocks[0].id, 'comes the ultimate toll');

  // the original range covered word 0 (`toll,`) — after the reorder it still covers word 0 (`comes`)
  assert.deepEqual(block.words.map((w) => w.emphasis), [true, false, false, false]);
  assert.equal(block.styles.length, 1);
  assert.deepEqual(block.styles[0].style, { italic: true, underline: true, color: '#fff' });
  assert.deepEqual([block.styles[0].from, block.styles[0].to], [0, 5]);
  assert.equal(block.styles[0].id, 'auto-highlight');
});

test('a changed word count re-divides the span instead of leaving the block', () => {
  const doc = makeDoc([createBlock(0, 4, [createWord('one', 0, 2), createWord('two', 2, 4)])]);
  const block = setBlockText(doc, doc.blocks[0].id, 'one two three four five');

  assert.equal(block.words.length, 5);
  assert.equal(block.start, 0);
  assert.equal(block.end, 4);
  assert.equal(block.words[0].start, 0);
  assert.equal(block.words[block.words.length - 1].end, 4);
  for (let i = 1; i < block.words.length; i++) {
    assert.ok(block.words[i].start >= block.words[i - 1].end - 1e-9, 'words stay in time order');
  }
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('preserveTiming:false re-divides even when the word count is unchanged', () => {
  const doc = makeDoc([createBlock(0, 4, [createWord('a', 0, 1), createWord('b', 1, 4)])]);
  const block = setBlockText(doc, doc.blocks[0].id, 'a b', { preserveTiming: false });

  assert.deepEqual(
    block.words.map((w) => [w.start, w.end]),
    [[0, 2], [2, 4]],
    'the shorter first word should no longer hold its original third of the block',
  );
});

test('an empty line clears the words but never the block span', () => {
  const doc = makeDoc([createBlock(3, 5, [createWord('gone', 3, 5)])]);
  const block = setBlockText(doc, doc.blocks[0].id, '   ');

  assert.deepEqual(block.words, []);
  assert.equal(block.text, '');
  assert.equal(block.start, 3);
  assert.equal(block.end, 5);
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('an edit leaves the neighbouring blocks and validated layout alone', () => {
  const doc = makeDoc([
    createBlock(0, 2, [createWord('first', 0, 2)]),
    createBlock(2, 4, [createWord('second', 2, 4)]),
  ]);
  const neighbour = doc.blocks[1];
  const snapshot = JSON.stringify(neighbour);

  setBlockText(doc, doc.blocks[0].id, 'first one edited');

  assert.equal(JSON.stringify(neighbour), snapshot, 'the other block is untouched');
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('an edit to content is never an edit to looks or position', () => {
  const doc = reportedDoc();
  const block = doc.blocks[0];
  block.overrides = { font: { size: 0.05 } };
  block.placement = { posX: 0.2, posY: 0.8, gravity: 'center' };

  setBlockText(doc, block.id, 'comes the ultimate toll');

  assert.deepEqual(block.overrides, { font: { size: 0.05 } });
  assert.deepEqual(block.placement, { posX: 0.2, posY: 0.8, gravity: 'center' });
});

test('non-emphasis ranges are dropped rather than left pointing into the old text', () => {
  const block = createBlock(0, 2, [createWord('alpha', 0, 1), createWord('beta', 1, 2)]);
  block.styles = [{ from: 0, to: 5, id: 'fancy', style: { bold: true } }];
  const doc = makeDoc([block]);

  setBlockText(doc, block.id, 'alpha beta gamma');

  assert.deepEqual(block.styles, []);
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('setWordText fixes one word and leaves the others in place', () => {
  const doc = makeDoc([
    createBlock(0, 3, [createWord('teh', 0, 1), createWord('cat', 1, 3)]),
  ]);
  const id = doc.blocks[0].id;
  const before = doc.blocks[0].words.map((w) => [w.start, w.end]);

  const block = setWordText(doc, id, 0, 'the');

  assert.equal(block.text, 'the cat');
  assert.deepEqual(
    block.words.map((w) => [w.start, w.end]),
    before,
    'a one-word fix keeps every slot',
  );
});

test('setWordText refuses a missing block or an out-of-range index', () => {
  const doc = makeDoc([createBlock(0, 1, [createWord('one', 0, 1)])]);
  const id = doc.blocks[0].id;

  assert.equal(setWordText(doc, id, 4, 'x'), null);
  assert.equal(setWordText(doc, id, -1, 'x'), null);
  assert.equal(setBlockText(doc, 'nope', 'x'), null);
  assert.equal(doc.blocks[0].text, 'one', 'a refused edit changes nothing');
});
