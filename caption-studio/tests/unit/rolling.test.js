import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineOccurrences, flattenOccurrences, wordsFromCues } from '../../src/align/rolling.js';

const cues = [
  { start: 0, end: 4, lines: ['A', 'B'] },
  { start: 4, end: 8, lines: ['A', 'B', 'C'] },
  { start: 8, end: 12, lines: ['B', 'C', 'D'] },
  { start: 12, end: 16, lines: ['C', 'D', 'E'] },
];

test('birth-cue rule assigns each new line its own cue window', () => {
  const occ = buildLineOccurrences(cues);
  assert.deepEqual(occ.map((o) => o.line), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual([occ[0].start, occ[0].end], [0, 2]); // cue 0 split between its two new lines
  assert.deepEqual([occ[2].start, occ[2].end], [4, 8]); // C born in cue 1
  assert.deepEqual([occ[4].start, occ[4].end], [12, 16]);
});

test('a returning line starts a new occurrence', () => {
  const occ = buildLineOccurrences([
    { start: 0, end: 4, lines: ['A', 'B', 'C'] },
    { start: 4, end: 8, lines: ['B', 'C', 'D'] },
    { start: 8, end: 12, lines: ['C', 'D', 'A'] }, // A returns as the new line
  ]);
  const aOcc = occ.filter((o) => o.line === 'A');
  assert.equal(aOcc.length, 2);
  assert.equal(aOcc[1].start, 8);
});

test('flattened words are monotonic and cover the cue spans', () => {
  const words = flattenOccurrences(buildLineOccurrences(cues));
  assert.ok(words.length >= 5);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].start >= words[i - 1].start - 1e-9, 'start monotonic');
    assert.ok(words[i].end >= words[i].start, 'end >= start');
  }
  assert.equal(words[0].start, 0);
  assert.ok(Math.abs(words[words.length - 1].end - 16) < 1e-6);
});

test('wordsFromCues returns both occurrences and words', () => {
  const { occurrences, words } = wordsFromCues(cues);
  assert.equal(occurrences.length, 5);
  assert.ok(words.length > 0);
});
