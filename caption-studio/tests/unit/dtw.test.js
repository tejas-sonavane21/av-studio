import test from 'node:test';
import assert from 'node:assert/strict';
import { dtwAlign } from '../../src/align/dtw.js';

const w = (text, start, end, key) => ({ text, start, end, mid: (start + end) / 2, key });

test('aligns equal-length sequences one-to-one', () => {
  const ai = [w('I', 0, 0.2, 'i'), w('crush', 0.2, 0.6, 'crush'), w('the', 0.6, 0.8, 'the'), w('falling,', 0.8, 1.2, 'falling')];
  const truth = [w('I', 0, 0.2, 'i'), w('catch', 0.2, 0.6, 'catch'), w('the', 0.6, 0.8, 'the'), w('falling,', 0.8, 1.2, 'falling')];
  const path = dtwAlign(ai, truth, { band: 6 });
  assert.equal(path.length, 4);
  assert.ok(path.every((s) => s.aiIndex != null && s.truthIndex != null));
  assert.deepEqual(path.map((s) => [s.aiIndex, s.truthIndex]), [[0, 0], [1, 1], [2, 2], [3, 3]]);
});

test('inserts a missing truth word without drifting the rest', () => {
  const ai = [w('the', 0, 0.3, 'the'), w('ultimate.', 0.3, 0.9, 'ultimate')];
  const truth = [w('the', 0, 0.3, 'the'), w('ultimate', 0.3, 0.7, 'ultimate'), w('toll,', 0.7, 0.9, 'toll')];
  const path = dtwAlign(ai, truth, { band: 6 });
  assert.deepEqual(path.map((s) => [s.aiIndex, s.truthIndex]), [[0, 0], [1, 1], [null, 2]]);
});

test('deletes an AI-only word', () => {
  const ai = [w('yeah', 0, 0.3, 'yeah'), w('hello', 0.3, 0.8, 'hello')];
  const truth = [w('hello', 0.3, 0.8, 'hello')];
  const path = dtwAlign(ai, truth, { band: 6 });
  assert.deepEqual(path.map((s) => [s.aiIndex, s.truthIndex]), [[0, null], [1, 0]]);
});

test('handles empty inputs', () => {
  assert.deepEqual(dtwAlign([], []), []);
  assert.deepEqual(dtwAlign([], [w('a', 0, 1, 'a')]).map((s) => s.truthIndex), [0]);
  assert.deepEqual(dtwAlign([w('a', 0, 1, 'a')], []).map((s) => s.aiIndex), [0]);
});
