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
 *
 * The second half is about *shaping* rather than wording: splitting one caption into two and joining
 * it back. A block is the unit the renderer reveals, so a long line that holds a whole sentence keeps
 * every spoken word on screen until it ends — drawing the line break is the fix, and in this model a
 * line break is a block boundary. Those promises are:
 *
 * - a split never re-times a word, and the two halves meet exactly at the cut;
 * - both halves keep the look and the position the original had, as independent copies;
 * - the keyword highlight travels with its word into whichever half it lands in;
 * - joining is the exact inverse, and refuses the first caption.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  apportionTimes,
  joinBlockWithPrevious,
  setBlockText,
  setWordText,
  splitBlock,
  splitBlockAtTime,
  splitTimeBetween,
  splitWords,
} from '../../src/model/edit.js';
import { normalizeBlock, normalizeDocument, validateDocument } from '../../src/model/document.js';
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

// ---------------------------------------------------------------------------
// shaping — splitting a caption in two, and joining it back
// ---------------------------------------------------------------------------

/** A caption holding a whole sentence: the shape that keeps too much on screen at once. */
function longLineDoc() {
  const words = [
    ['beacon', 10.0, 10.4],
    ['of', 10.4, 10.55],
    ['hope,', 10.55, 11.0],
    ["I'll", 11.0, 11.2],
    ['hold', 11.35, 11.7],
    ['the', 11.7, 11.85],
    ['line,', 11.85, 12.3],
    ['and', 12.3, 12.45],
    ['I', 12.45, 12.55],
    ['swing', 12.55, 12.9],
  ];
  const block = createBlock(10, 12.9, words.map(([text, start, end]) => createWord(text, start, end)));
  block.overrides = { font: { size: 0.05 } };
  block.placement = { posX: 0.2, posY: 0.8, gravity: 'center' };
  return makeDoc([block]);
}

/** Give one word of an already-normalized block the keyword highlight. */
function emphasiseWord(block, index) {
  const w = block.words[index];
  block.styles = [
    {
      from: w.charFrom,
      to: w.charTo,
      id: 'auto-highlight',
      style: { italic: true, underline: true, color: '#fff' },
    },
  ];
  normalizeBlock(block);
  return block;
}

const slotsOf = (block) => block.words.map((w) => [w.text, w.start, w.end]);

function twoNeighbours() {
  return makeDoc([
    createBlock(0, 2, [createWord('first', 0, 1), createWord('one', 1, 2)]),
    createBlock(2, 4, [createWord('sec', 2, 3), createWord('ond', 3, 4)]),
  ]);
}

test('splitTimeBetween cuts halfway through the silence between two words', () => {
  assert.equal(splitTimeBetween({ end: 1 }, { start: 2 }), 1.5);
});

test('splitTimeBetween collapses onto words that touch, and into an overlap', () => {
  assert.equal(splitTimeBetween({ end: 2 }, { start: 2 }), 2, 'touching words still leave one cut');
  const cut = splitTimeBetween({ end: 2 }, { start: 1.5 });
  assert.ok(cut >= 1.5 && cut <= 2, `the cut stays inside the overlap, got ${cut}`);
});

test('a split moves the words into a second caption without re-timing one of them', () => {
  const doc = longLineDoc();
  const original = doc.blocks[0];
  const before = slotsOf(original);
  const ids = original.words.map((w) => w.id);

  const parts = splitBlock(doc, original.id, 4);

  assert.deepEqual(slotsOf(parts.first), before.slice(0, 4));
  assert.deepEqual(slotsOf(parts.second), before.slice(4));
  assert.deepEqual(parts.second.words.map((w) => w.id), ids.slice(4), 'the words keep their identities');
  assert.equal(parts.first.text, 'beacon of hope, I\'ll');
  assert.equal(parts.second.text, 'hold the line, and I swing');
});

test('the two halves meet exactly at the cut and the document stays valid', () => {
  const doc = longLineDoc();
  const { first, second, cut } = splitBlock(doc, doc.blocks[0].id, 4);

  assert.equal(first.end, cut);
  assert.equal(second.start, cut);
  assert.ok(cut > first.words[first.words.length - 1].end, 'the cut lands after the first half’s last word');
  assert.ok(cut < second.words[0].start, 'and before the second half’s first');
  assert.equal(first.start, 10, 'the outer edges are the span the original had');
  assert.equal(second.end, 12.9);
  assert.equal(doc.blocks.length, 2);
  assert.deepEqual(doc.blocks.map((b) => b.id), [first.id, second.id], 'inserted right after its parent');
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('both halves keep the look and the position, as independent copies', () => {
  const doc = longLineDoc();
  const { first, second } = splitBlock(doc, doc.blocks[0].id, 4);

  assert.deepEqual(second.overrides, { font: { size: 0.05 } });
  assert.deepEqual(second.placement, { posX: 0.2, posY: 0.8, gravity: 'center' });

  second.overrides.font.size = 0.02; // a copy, not a shared subtree
  second.placement.posX = 0.9;
  assert.equal(first.overrides.font.size, 0.05);
  assert.deepEqual(first.placement, { posX: 0.2, posY: 0.8, gravity: 'center' });
});

test('each half holds the text/offset/range invariants on its own', () => {
  const doc = longLineDoc();
  emphasiseWord(doc.blocks[0], 6); // "line,"
  const { first, second } = splitBlock(doc, doc.blocks[0].id, 4);

  for (const half of [first, second]) {
    assert.equal(half.text, half.words.map((w) => w.text).join(' '));
    let pos = 0;
    for (const w of half.words) {
      assert.equal(w.charFrom, pos);
      assert.equal(w.charTo, pos + w.text.length);
      pos = w.charTo + 1;
    }
    for (const st of half.styles) {
      assert.ok(st.from >= 0 && st.to <= half.text.length && st.to > st.from);
    }
  }
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('the keyword highlight travels with its word into the second half', () => {
  const doc = longLineDoc();
  emphasiseWord(doc.blocks[0], 6);
  const { first, second } = splitBlock(doc, doc.blocks[0].id, 4);

  assert.deepEqual(second.words.map((w) => !!w.emphasis), [false, false, true, false, false, false]);
  assert.equal(second.styles.length, 1, 'only the half that holds the word keeps a range');
  assert.deepEqual(
    [second.styles[0].from, second.styles[0].to],
    [second.words[2].charFrom, second.words[2].charTo],
  );
  assert.equal(second.styles[0].style.color, '#fff', 'and it keeps the look it had');
  assert.deepEqual(first.styles, []);
});

test('a highlight on a word in the first half stays there', () => {
  const doc = longLineDoc();
  emphasiseWord(doc.blocks[0], 1);
  const { first, second } = splitBlock(doc, doc.blocks[0].id, 4);

  assert.deepEqual(first.words.map((w) => !!w.emphasis), [false, true, false, false]);
  assert.equal(first.styles.length, 1);
  assert.deepEqual(second.styles, []);
});

test('a split never moves a neighbouring caption', () => {
  const doc = twoNeighbours();
  const neighbour = doc.blocks[1];
  const snapshot = JSON.stringify(neighbour);

  splitBlock(doc, doc.blocks[0].id, 1);

  assert.equal(JSON.stringify(neighbour), snapshot);
  assert.equal(doc.blocks[2], neighbour, 'the untouched caption still closes the document');
});

test('a split refuses a boundary that would leave a half empty', () => {
  const doc = longLineDoc();
  const snapshot = JSON.stringify(doc.blocks);

  assert.equal(splitBlock(doc, doc.blocks[0].id, 0), null, 'before the first word');
  assert.equal(splitBlock(doc, doc.blocks[0].id, 10), null, 'after the last word');
  assert.equal(splitBlock(doc, doc.blocks[0].id, -1), null);
  assert.equal(splitBlock(doc, doc.blocks[0].id, 2.5), null);
  assert.equal(splitBlock(doc, 'nope', 2), null);

  const single = makeDoc([createBlock(0, 1, [createWord('solo', 0, 1)])]);
  assert.equal(splitBlock(single, single.blocks[0].id, 1), null, 'a one-word caption cannot be split');

  assert.equal(JSON.stringify(doc.blocks), snapshot, 'a refused split changes nothing');
});

test('a split refuses a cut that would leave a caption with no duration', () => {
  // The pathological shape: the first two words touch at the block's own first instant (a
  // zero-length word is representable, and alignment can produce one). The cut between them is the
  // block's start, so the first half would have nothing to show.
  const doc = makeDoc([createBlock(5, 7, [createWord('now', 5, 5), createWord('go', 5, 7)])]);
  const block = doc.blocks[0];
  assert.equal(splitTimeBetween(block.words[0], block.words[1]), 5);
  assert.equal(splitBlock(doc, block.id, 1), null);
  assert.equal(splitBlockAtTime(doc, block.id, 5.2), null, 'and a playhead split has nowhere to land');
  assert.equal(doc.blocks.length, 1);

  // With a later boundary available, the playhead takes that one instead of the dead end.
  const three = makeDoc([
    createBlock(5, 9, [createWord('so', 5, 5), createWord('go', 5, 6), createWord('far', 6, 9)]),
  ]);
  assert.equal(splitBlockAtTime(three, three.blocks[0].id, 5.01).cut, 6);
});

test('splitting at the playhead picks the nearest word boundary', () => {
  const doc = longLineDoc();
  const parts = splitBlockAtTime(doc, doc.blocks[0].id, 11.6);

  assert.equal(parts.cut, 11.7, 'the gap after “hold” is the closest boundary to 11.6');
  assert.equal(parts.first.words.length, 5);
  assert.equal(parts.second.words.length, 5);
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('a playhead split is refused outside the caption', () => {
  const doc = longLineDoc();
  const snapshot = JSON.stringify(doc.blocks);

  assert.equal(splitBlockAtTime(doc, doc.blocks[0].id, 9), null, 'before the caption');
  assert.equal(splitBlockAtTime(doc, doc.blocks[0].id, 20), null, 'after it');
  assert.equal(splitBlockAtTime(doc, doc.blocks[0].id, NaN), null);
  assert.equal(splitBlockAtTime(doc, 'nope', 11), null);
  assert.equal(JSON.stringify(doc.blocks), snapshot);
});

test('joining puts a split back exactly as it was', () => {
  const doc = longLineDoc();
  const before = JSON.stringify(doc.blocks[0].words);
  const { second } = splitBlock(doc, doc.blocks[0].id, 4);

  const merged = joinBlockWithPrevious(doc, second.id);

  assert.equal(doc.blocks.length, 1);
  assert.equal(merged.text, 'beacon of hope, I\'ll hold the line, and I swing');
  assert.equal(JSON.stringify(merged.words), before, 'every word is back in its original slot');
  assert.equal(merged.start, 10);
  assert.equal(merged.end, 12.9, 'the span a split had halved is restored');
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('a join keeps every word’s timing and emphasis across the seam', () => {
  const doc = longLineDoc();
  emphasiseWord(doc.blocks[0], 8); // "I" — lands in the second half
  const flags = doc.blocks[0].words.map((w) => !!w.emphasis);
  const slots = slotsOf(doc.blocks[0]);

  const { second } = splitBlock(doc, doc.blocks[0].id, 4);
  joinBlockWithPrevious(doc, second.id);

  const merged = doc.blocks[0];
  assert.deepEqual(slotsOf(merged), slots);
  assert.deepEqual(merged.words.map((w) => !!w.emphasis), flags);
  assert.equal(merged.styles.length, 1);
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('splitting twice and joining twice rebuilds the original line', () => {
  const doc = longLineDoc();
  const original = doc.blocks[0];
  const text = original.text;
  const slots = slotsOf(original);

  const firstCut = splitBlock(doc, original.id, 3);
  const secondCut = splitBlock(doc, firstCut.second.id, 2);
  assert.equal(doc.blocks.length, 3);

  joinBlockWithPrevious(doc, secondCut.second.id);
  const merged = joinBlockWithPrevious(doc, doc.blocks[1].id);

  assert.equal(doc.blocks.length, 1);
  assert.equal(merged.id, original.id, 'the caption that was selected first survives');
  assert.equal(merged.text, text);
  assert.deepEqual(slotsOf(merged), slots);
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('the first caption has nothing before it to join with', () => {
  const doc = longLineDoc();

  assert.equal(joinBlockWithPrevious(doc, doc.blocks[0].id), null);
  assert.equal(joinBlockWithPrevious(doc, 'nope'), null);
  assert.equal(doc.blocks.length, 1);
});
