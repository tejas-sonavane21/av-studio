import test from 'node:test';
import assert from 'node:assert/strict';
import { findAnchors, segmentAroundAnchors, STOP_WORDS } from '../../src/align/anchors.js';
import { matchKey } from '../../src/align/normalize.js';

const w = (text, start, end) => ({ text, start, end, mid: (start + end) / 2, key: matchKey(text) });

test('anchors words whose keys are equal and unique', () => {
  const ai = [w('I', 0, 0.2), w('shattering', 0.2, 0.6), w('the', 0.6, 0.8), w('skyline', 0.8, 1.2)];
  const truth = [w('I', 0, 0.2), w('shattering', 0.2, 0.6), w('the', 0.6, 0.8), w('skyline', 0.8, 1.2)];
  const anchors = findAnchors(ai, truth);
  // stop-words ("i", "the") never anchor on their own
  assert.deepEqual(anchors, [{ i: 1, j: 1 }, { i: 3, j: 3 }]);
  assert.ok(STOP_WORDS.includes('the'));
});

test('tolerates the multi-second drift of synthetic TRUTH timings', () => {
  // The real reference pair drifts 3–7 s (Knowledge Base §5.1): the old ±300 ms window found
  // nothing at all, so a large offset must still anchor.
  const ai = [w('beacon', 130, 130.5), w('of', 130.5, 130.7), w('hope,', 130.7, 131)];
  const truth = [w('beacon', 126.4, 126.9), w('of', 126.9, 127.1), w('hope,', 127.1, 127.4)];
  const anchors = findAnchors(ai, truth);
  assert.deepEqual(anchors.map((a) => [a.i, a.j]), [[0, 0], [2, 2]]);
});

test('prefers the nearest occurrence of a repeated key (chorus)', () => {
  const ai = [w('falling,', 100, 100.5)];
  const truth = [w('falling,', 20, 20.5), w('falling,', 99, 99.5), w('falling,', 180, 180.5)];
  const anchors = findAnchors(ai, truth);
  assert.deepEqual(anchors, [{ i: 0, j: 1 }]);
});

test('rejects an ambiguous repeated key instead of guessing', () => {
  // Two occurrences of the same key sit the same distance away: no anchor is better than a wrong one.
  const ai = [w('night,', 50, 50.5)];
  const truth = [w('night,', 48, 48.5), w('night,', 52, 52.5)];
  assert.deepEqual(findAnchors(ai, truth), []);
});

test('drops anchors that are not monotonic in both streams', () => {
  const ai = [w('alpha', 0, 0.2), w('bravo', 0.2, 0.4), w('charlie', 0.4, 0.6)];
  // TRUTH order puts alpha last: the chain may only keep a strictly increasing subset.
  const truth = [w('bravo', 0.2, 0.4), w('charlie', 0.4, 0.6), w('alpha', 0.6, 0.8)];
  const anchors = findAnchors(ai, truth);
  assert.deepEqual(anchors, [{ i: 1, j: 0 }, { i: 2, j: 1 }]);
});

test('segmentAroundAnchors covers both streams exactly once', () => {
  const anchors = [{ i: 2, j: 3 }];
  const segments = segmentAroundAnchors(anchors, 5, 6);
  assert.deepEqual(
    segments.map((s) => [s.aiStart, s.aiEnd, s.truthStart, s.truthEnd]),
    [[0, 2, 0, 3], [3, 5, 4, 6]],
  );
  assert.equal(segments[0].anchor.i, 2);
  assert.equal(segments[1].anchor, null);
});
