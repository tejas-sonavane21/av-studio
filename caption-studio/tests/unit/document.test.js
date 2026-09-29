import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildBlockText, computeEmphasisFlags, validateDocument, normalizeDocument } from '../../src/model/document.js';
import { createBlock, createWord } from '../../src/model/schema.js';

test('rebuildBlockText computes character offsets', () => {
  const b = createBlock(0, 1, [createWord('Just', 0, 0.5), createWord('boy', 0.5, 1)]);
  rebuildBlockText(b);
  assert.equal(b.text, 'Just boy');
  assert.deepEqual([b.words[0].charFrom, b.words[0].charTo], [0, 4]);
  assert.deepEqual([b.words[1].charFrom, b.words[1].charTo], [5, 8]);
});

test('computeEmphasisFlags flags >=50% character overlap', () => {
  const b = createBlock(0, 1, [
    createWord('I', 0, 0.2),
    createWord('catch', 0.2, 0.6),
    createWord('the', 0.6, 0.8),
    createWord('falling,', 0.8, 1),
  ]);
  rebuildBlockText(b); // text = "I catch the falling," ; catch occupies 2..7
  b.styles = [{ from: 2, to: 7, id: 'auto-highlight', style: { italic: true, underline: true } }];
  computeEmphasisFlags(b);
  assert.deepEqual(b.words.map((w) => w.emphasis), [false, true, false, false]);
});

test('validateDocument catches overlapping blocks', () => {
  const doc = normalizeDocument({
    schemaVersion: 1,
    canvas: { width: 1280, height: 720 },
    blocks: [
      { id: 'a', start: 0, end: 5, words: [createWord('a', 0, 5)], styles: [], overrides: {} },
      { id: 'b', start: 4, end: 8, words: [createWord('b', 4, 8)], styles: [], overrides: {} },
    ],
  });
  const { errors } = validateDocument(doc);
  assert.ok(errors.some((e) => /overlaps/.test(e)), errors.join('; '));
});

test('validateDocument accepts a clean document', () => {
  const doc = normalizeDocument({
    schemaVersion: 1,
    canvas: { width: 1280, height: 720 },
    blocks: [{ id: 'a', start: 0, end: 5, words: [createWord('hello', 0, 5)], styles: [], overrides: {} }],
  });
  assert.deepEqual(validateDocument(doc).errors, []);
});
