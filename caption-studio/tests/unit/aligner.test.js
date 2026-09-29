import test from 'node:test';
import assert from 'node:assert/strict';
import { alignCaptions } from '../../src/align/aligner.js';
import { validateDocument } from '../../src/model/document.js';

const CANVAS = { width: 1280, height: 720 };

test('corrects crush -> catch and carries emphasis to the corrected word', () => {
  const aiBlocks = [{
    start: 0, end: 1.2,
    words: [
      { text: 'I', start: 0, end: 0.2, emphasis: false },
      { text: 'crush', start: 0.2, end: 0.6, emphasis: true },
      { text: 'the', start: 0.6, end: 0.8, emphasis: false },
      { text: 'falling,', start: 0.8, end: 1.2, emphasis: false },
    ],
  }];
  const truthCues = [{ start: 0, end: 1.2, lines: ['I catch the falling,'] }];
  const { blocks, corrections, report } = alignCaptions({ aiBlocks, truthCues });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'I catch the falling,');
  const rep = corrections.find((c) => c.type === 'replace');
  assert.ok(rep);
  assert.equal(rep.from, 'crush');
  assert.equal(rep.to, 'catch');
  assert.equal(blocks[0].words[1].emphasis, true, 'emphasis follows the corrected word');
  assert.equal(report.replacements, 1);
  // timing is inherited from the AI word unchanged
  assert.deepEqual([blocks[0].words[1].start, blocks[0].words[1].end], [0.2, 0.6]);
  assert.deepEqual(validateDocument({ schemaVersion: 1, canvas: CANVAS, blocks }).errors, []);
});

test('inserts a missing word without shifting later words', () => {
  const aiBlocks = [{
    start: 0, end: 1.0,
    words: [
      { text: 'the', start: 0, end: 0.3, emphasis: false },
      { text: 'ultimate.', start: 0.3, end: 1.0, emphasis: false },
    ],
  }];
  const truthCues = [{ start: 0, end: 1.0, lines: ['the ultimate toll,'] }];
  const { blocks, corrections } = alignCaptions({ aiBlocks, truthCues });

  assert.equal(blocks[0].text, 'the ultimate toll,');
  assert.equal(corrections.filter((c) => c.type === 'insert').length, 1);
  assert.deepEqual([blocks[0].words[0].start, blocks[0].words[0].end], [0, 0.3]);
  assert.equal(blocks[0].words[2].text, 'toll,');
});

test('preserves a timing gap instead of stretching across it', () => {
  const aiBlocks = [
    { start: 0, end: 1, words: [{ text: 'hello', start: 0, end: 1, emphasis: false }] },
    { start: 20, end: 21, words: [{ text: 'world', start: 20, end: 21, emphasis: false }] },
  ];
  const truthCues = [
    { start: 0, end: 1, lines: ['hello'] },
    { start: 20, end: 21, lines: ['world'] },
  ];
  const { blocks, report } = alignCaptions({ aiBlocks, truthCues });
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].end <= 1.001);
  assert.ok(blocks[1].start >= 19.999);
  assert.equal(report.gaps.length, 1);
  assert.ok(report.gaps[0].duration >= 19);
});

test('empty TRUTH acts as a pass-through (AI text preserved)', () => {
  const aiBlocks = [{ start: 0, end: 1, words: [{ text: 'hello', start: 0, end: 1, emphasis: false }] }];
  const { blocks, corrections } = alignCaptions({ aiBlocks, truthCues: [] });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'hello');
  assert.equal(corrections.length, 0);
});

test('alignment is deterministic across runs', () => {
  const aiBlocks = [{ start: 0, end: 1, words: [
    { text: 'the', start: 0, end: 0.4, emphasis: false },
    { text: 'ultimate.', start: 0.4, end: 1, emphasis: true },
  ] }];
  const truthCues = [{ start: 0, end: 1, lines: ['the ultimate toll,'] }];
  const a = JSON.stringify(alignCaptions({ aiBlocks, truthCues }).blocks);
  const b = JSON.stringify(alignCaptions({ aiBlocks, truthCues }).blocks);
  assert.equal(a, b);
});
