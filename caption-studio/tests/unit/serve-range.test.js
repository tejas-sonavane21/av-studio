/**
 * serve-range.test.js — the dev server's HTTP Range parser.
 *
 * Worth testing because byte ranges are load-bearing: `<video>` seeking in Chrome requires a 206
 * with a correct `Content-Range`, so a bug here shows up as "the preview cannot be scrubbed" and
 * "the visual parity harness cannot seek", not as an obvious server error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { contentRange, parseRange } from '../../tools/range.js';

const SIZE = 56_190_240; // the reference video, in bytes

test('no header means serve normally', () => {
  assert.equal(parseRange(undefined, SIZE), null);
  assert.equal(parseRange('', SIZE), null);
  assert.equal(parseRange('bytes=-', SIZE), null, 'an empty range is not a range');
});

test('an explicit closed range is satisfiable', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=100-', SIZE), { start: 100, end: SIZE - 1 });
  assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: SIZE - 1 });
});

test('a suffix range returns the LAST n bytes', () => {
  assert.deepEqual(parseRange('bytes=-500', SIZE), { start: SIZE - 500, end: SIZE - 1 });
  // a suffix longer than the file starts at 0 rather than going negative
  assert.deepEqual(parseRange(`bytes=-${SIZE + 10}`, SIZE), { start: 0, end: SIZE - 1 });
});

test('an end past the file is clamped, not rejected', () => {
  assert.deepEqual(parseRange(`bytes=0-${SIZE + 999}`, SIZE), { start: 0, end: SIZE - 1 });
});

test('unsatisfiable ranges are rejected so the caller can answer 416', () => {
  assert.equal(parseRange(`bytes=${SIZE}-`, SIZE), 'invalid', 'start at EOF');
  assert.equal(parseRange(`bytes=${SIZE + 1}-`, SIZE), 'invalid');
  assert.equal(parseRange('bytes=200-100', SIZE), 'invalid', 'inverted');
  assert.equal(parseRange('bytes=-0', SIZE), 'invalid', 'zero-length suffix');
});

test('whitespace is tolerated and nonsense is ignored', () => {
  assert.deepEqual(parseRange(' bytes=0-9 ', SIZE), { start: 0, end: 9 });
  assert.equal(parseRange('items=0-9', SIZE), null, 'other units are not our business');
  assert.equal(parseRange('bytes=abc-def', SIZE), null);
  assert.equal(parseRange('bytes=1-2,5-6', SIZE), null, 'multi-range is not supported');
});

test('a zero-size resource cannot be ranged', () => {
  assert.equal(parseRange('bytes=0-0', 0), 'invalid');
});

test('contentRange renders the documented spelling', () => {
  assert.equal(contentRange({ start: 0, end: 99 }, SIZE), `bytes 0-99/${SIZE}`);
  assert.equal(contentRange({ start: 10, end: SIZE - 1 }, SIZE), `bytes 10-${SIZE - 1}/${SIZE}`);
});
