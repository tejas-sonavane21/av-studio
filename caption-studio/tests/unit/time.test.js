/**
 * time.test.js — the per-instant state rules.
 *
 * The behaviour worth defending here is the one that is easy to "fix" wrongly: the emphasis
 * decoration is on screen for `[word.start, block.end]`, **not** `[word.start, word.end]`.
 * v10 draws the underline whenever the word is revealed, and the block stops being drawn when the
 * block ends — so in a rolling-caption context the lime bar stays put for the rest of the caption
 * instead of blinking off when the word stops being spoken.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPHASIS_SOURCES,
  REVEAL_MODES,
  activeBlock,
  activeBlocks,
  blockWindow,
  isBlockActive,
  isEmphasised,
  isRevealed,
  progressIn,
  progressOut,
  revealedCount,
  wordState,
  wordStates,
} from '../../src/render/time.js';
import { createDemoDocument } from '../../src/model/demo.js';
import { validateDocument } from '../../src/model/document.js';

const doc = createDemoDocument();
const block = doc.blocks[0]; // 15.20–16.72: Just | an | ordinary | boy
/** Reveal flags for the demo block, so the mode tests read as tables. */
const t2 = (t, opts) => wordStates(block, t, opts).map((w) => w.revealed);

test('the demo document is itself valid', () => {
  const { errors, warnings } = validateDocument(doc);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(doc.blocks.length, 3);
  assert.equal(doc.blocks[0].text, 'Just an ordinary boy');
  assert.equal(doc.blocks[0].words.length, 4);
});

test('isBlockActive is inclusive at both ends', () => {
  assert.equal(isBlockActive(block, 15.2), true);
  assert.equal(isBlockActive(block, 16.72), true);
  assert.equal(isBlockActive(block, 15.19), false);
  assert.equal(isBlockActive(block, 16.73), false);
});

test('lead and tail widen the visible window', () => {
  assert.equal(isBlockActive(block, 15.0), false);
  assert.equal(isBlockActive(block, 15.0, { lead: 0.25 }), true);
  assert.equal(isBlockActive(block, 16.9, { tail: 0.2 }), true);
  assert.equal(isBlockActive(block, 17.1, { tail: 0.2 }), false);
  assert.deepEqual(blockWindow(block, { lead: 0.2, tail: 0.3 }), {
    start: block.start - 0.2,
    end: block.end + 0.3,
  });
});

test('activeBlocks/activeBlock select by time', () => {
  assert.deepEqual(activeBlocks(doc, 15.5).map((b) => b.id), [block.id]);
  assert.equal(activeBlock(doc, 15.5).id, block.id);
  assert.deepEqual(activeBlocks(doc, 5), []);
  assert.equal(activeBlock(doc, 5), null);
  // in the silent gap between block 1 and block 2
  assert.equal(activeBlock(doc, 17.0), null);
});

test('words are revealed progressively and stay revealed', () => {
  const t = (s) => wordStates(block, s).map((w) => w.revealed);
  assert.deepEqual(t(15.2), [true, false, false, false]);
  assert.deepEqual(t(15.4), [true, true, false, false]);
  assert.deepEqual(t(16.5), [true, true, true, true]);
  assert.deepEqual(t(15.19), [false, false, false, false]);
});

test('active is the word’s own spoken window', () => {
  // "Just" is 15.20–15.36
  assert.equal(wordState(block.words[0], 15.2).active, true);
  assert.equal(wordState(block.words[0], 15.36).active, true);
  assert.equal(wordState(block.words[0], 15.4).active, false);
  assert.equal(wordState(block.words[2], 15.4).revealed, false);
});

test('THE RULE: emphasis outlives the word, up to the end of the block', () => {
  const just = block.words[0]; // emphasised, spoken 15.20–15.36
  assert.equal(just.emphasis, true, 'block 0 word 0 is an AI keyword');

  // during the word
  assert.equal(wordState(just, 15.2).emphasis, true);
  assert.equal(wordState(just, 15.36).emphasis, true);
  // long after the word stopped being spoken, still on screen
  assert.equal(wordState(just, 16.0).emphasis, true);
  assert.equal(wordState(just, 16.71).emphasis, true);
  // and it never appears before the word does
  assert.equal(wordState(just, 15.19).emphasis, false);
  // the word is no longer "active" even though its decoration still is
  assert.equal(wordState(just, 16.0).active, false);
});

test('unemphasised words never get an emphasis state', () => {
  const an = block.words[1];
  assert.equal(an.emphasis, false);
  for (const t of [15.2, 15.5, 16.0, 16.7]) {
    assert.equal(wordState(an, t).emphasis, false);
  }
});

test('revealedCount increases monotonically to the word count', () => {
  // "boy" starts at 16.1, so 16.0 still has only three words revealed
  const counts = [15.0, 15.2, 15.4, 16.0, 16.2, 16.9].map((t) => revealedCount(block, t));
  assert.deepEqual(counts, [0, 1, 2, 3, 4, 4]);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1]);
});

test('the reveal and emphasis vocabularies are the ones templates are validated against', () => {
  assert.deepEqual(REVEAL_MODES, ['progressive', 'all', 'active']);
  assert.deepEqual(EMPHASIS_SOURCES, ['keyword', 'active']);
});

test('reveal "all" shows the whole line from the block start', () => {
  assert.deepEqual(t2(15.2, { reveal: 'all' }), [true, true, true, true]);
  // …and even before the block starts, because "revealed" is only about the word
  assert.deepEqual(t2(0, { reveal: 'all' }), [true, true, true, true]);
});

test('reveal "progressive" is the default, and an unknown mode falls back to it', () => {
  assert.deepEqual(t2(15.4), [true, true, false, false]);
  assert.deepEqual(t2(15.4, { reveal: 'progressive' }), [true, true, false, false]);
  // a typo in a template must not make every word invisible
  assert.deepEqual(t2(15.4, { reveal: 'sometimes' }), [true, true, false, false]);
  assert.equal(isRevealed(block.words[3], block, 15.2, 'nonsense'), false, 'word 4 starts at 16.1');
});

test('reveal "active" shows only the word being spoken', () => {
  // Just 15.20–15.36 · an 15.36–15.48 · ordinary 15.48–16.10 · boy 16.10–16.72
  assert.deepEqual(t2(15.25, { reveal: 'active' }), [true, false, false, false]);
  assert.deepEqual(t2(15.4, { reveal: 'active' }), [false, true, false, false]);
  assert.deepEqual(t2(16.7, { reveal: 'active' }), [false, false, false, true]);
  // in the silent gap between the demo's blocks nothing is being spoken at all
  assert.deepEqual(t2(17.0, { reveal: 'active' }), [false, false, false, false]);
  // and the boundaries are inclusive on both ends, so a word never blinks out between two cues
  assert.deepEqual(t2(15.36, { reveal: 'active' }), [true, true, false, false]);
});

test('emphasisSource "active" moves the emphasis onto the spoken word', () => {
  // In keyword mode the AI-emphasised word keeps its decoration for the rest of the block…
  assert.equal(wordState(block.words[0], 15.4).emphasis, true);
  // …in playhead mode the decoration follows the voice instead, which is what karaoke is
  assert.equal(wordState(block.words[0], 15.4, { emphasisSource: 'active' }).emphasis, false);
  assert.equal(wordState(block.words[1], 15.4, { emphasisSource: 'active' }).emphasis, true);
  assert.equal(wordState(block.words[1], 15.4, { emphasisSource: 'active' }).emphasisNow, true);
  // a word that never carries an AI keyword can still be emphasised by the playhead
  assert.equal(block.words[1].emphasis, false);
  assert.equal(wordState(block.words[1], 15.4).emphasis, false, 'and the keyword rule still says no');
  // at the exact boundaries the word counts as spoken, on both ends
  assert.equal(wordState(block.words[0], 15.36, { emphasisSource: 'active' }).emphasis, true);
  assert.equal(wordState(block.words[0], 15.3601, { emphasisSource: 'active' }).emphasis, false);
});

test('isEmphasised is the rule itself, usable without a word object', () => {
  assert.equal(isEmphasised({ emphasis: true }, 0, { revealed: true }), true);
  assert.equal(isEmphasised({ emphasis: true }, 0, { revealed: false }), false, 'never before it is revealed');
  assert.equal(isEmphasised({ emphasis: false }, 0, { revealed: true }), false);
  assert.equal(isEmphasised({ emphasis: false }, 0, { active: true, emphasisSource: 'active' }), true);
  assert.equal(isEmphasised({ emphasis: true }, 0, { active: false, emphasisSource: 'active' }), false);
});

test('progressIn / progressOut are clamped and safe with a zero duration', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  assert.equal(progressIn(10, 0.2, 9.9), 0);
  close(progressIn(10, 0.2, 10.1), 0.5);
  // (10.2 − 10) / 0.2 is 1 − 3.6e-15 in binary floating point — compare with a tolerance
  close(progressIn(10, 0.2, 10.2), 1);
  assert.equal(progressIn(10, 0.2, 10.21), 1);
  assert.equal(progressIn(10, 0.2, 99), 1);
  assert.equal(progressIn(10, 0, 9), 1, 'zero duration means "already finished", never NaN');

  // the out window is [end − dur, end], so t *after* the end is already finished
  close(progressOut(10, 0.2, 9.9), 0.5);
  assert.equal(progressOut(10, 0.2, 10.1), 0, 'past the end → fully out');
  assert.equal(progressOut(10, 0.2, 9.0), 1, 'before the window → untouched');
  assert.equal(progressOut(10, 0, 50), 1);
});
