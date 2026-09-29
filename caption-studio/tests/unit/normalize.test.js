import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, matchKey, levenshtein, similarity, classifyTextDiff } from '../../src/align/normalize.js';

test('canonical unifies quotes, dashes and ellipsis', () => {
  assert.equal(canonical('“Don’t” — go…'), '"Don\'t" - go...');
});

test('matchKey strips punctuation and case', () => {
  assert.equal(matchKey('Falling,'), 'falling');
  assert.equal(matchKey("A hero's burden,"), 'a heros burden');
});

test('levenshtein and similarity', () => {
  assert.equal(levenshtein('crush', 'catch'), 3);
  assert.equal(similarity('crush', 'catch'), 0.4);
  assert.equal(similarity('Boy', 'boy'), 1);
});

test('classifyTextDiff separates punctuation/case/replace', () => {
  assert.equal(classifyTextDiff('shadows', 'shadows,'), 'punctuation');
  assert.equal(classifyTextDiff('king', 'King'), 'case');
  assert.equal(classifyTextDiff('crush', 'catch'), 'replace');
  assert.equal(classifyTextDiff('same', 'same'), 'same');
});
