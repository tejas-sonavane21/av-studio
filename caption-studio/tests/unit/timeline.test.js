/**
 * timeline.test.js — the timeline's pure arithmetic: clock formatting and ruler spacing.
 *
 * The strip itself is DOM (positions, clicks, scrolling) and is exercised through the UI smoke run;
 * the two decisions that can be got wrong without a browser are tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captionSpan, formatClock, tickStep } from '../../src/editor/timeline.js';

test('formatClock reads like a transport clock', () => {
  assert.equal(formatClock(0), '0:00.0');
  assert.equal(formatClock(12.34), '0:12.3');
  assert.equal(formatClock(62.5), '1:02.5');
  assert.equal(formatClock(3723.4), '1:02:03.4', 'past an hour it grows an hours field');
  assert.equal(formatClock(-5), '0:00.0', 'a negative clock is clamped, never printed');
  assert.equal(formatClock(NaN), '0:00.0');
  assert.equal(formatClock(undefined), '0:00.0');
});

test('tickStep keeps ruler ticks at least the requested distance apart', () => {
  for (const pps of [1, 3, 10, 45, 100, 400]) {
    const step = tickStep(pps);
    assert.ok(step * pps >= 72, `${step}s at ${pps}px/s is ${step * pps}px, which must be >= 72`);
  }
});

test('tickStep picks a sensible step at either extreme', () => {
  assert.equal(tickStep(100), 1, 'zoomed in, ticks are a second apart');
  assert.equal(tickStep(10), 10);
  assert.equal(tickStep(0.01), 600, 'zoomed out past the table, the largest step stands');
});

test('a caption inside the recording is drawn exactly where it was timed', () => {
  const span = captionSpan({ start: 3, end: 5.5 }, 20);
  assert.deepEqual(span, { start: 3, end: 5.5, beyond: false, outside: false });
});

test('a caption that outlives the recording is clipped to it, and flagged', () => {
  // The bug this exists for: a 161 s picture with captions timed against a 182 s master, drawn past
  // the end of the strip as if the recording continued.
  const span = captionSpan({ start: 160, end: 171.54 }, 160.98);
  assert.equal(span.end, 160.98, 'the clip stops at the end of the recording');
  assert.equal(span.beyond, true, 'and the strip is told, so the fault is visible');
  assert.equal(span.outside, false);
});

test('a caption that begins after the recording ends is pinned to the end, not placed past it', () => {
  const span = captionSpan({ start: 200, end: 205 }, 181.73);
  assert.equal(span.start, 181.73);
  assert.equal(span.end, 181.73);
  assert.equal(span.beyond, true);
  assert.equal(span.outside, true);
});

test('a caption with no usable timing collapses to a marker at its own start', () => {
  assert.deepEqual(captionSpan({ start: 2, end: 2 }, 10), { start: 2, end: 2, beyond: false, outside: false });
  assert.deepEqual(captionSpan({}, 10), { start: 0, end: 0, beyond: false, outside: false });
  assert.deepEqual(captionSpan({ start: 5, end: 1 }, 10), { start: 5, end: 5, beyond: false, outside: false });
});

test('a negative start is not a position on the strip', () => {
  assert.equal(captionSpan({ start: -4, end: 3 }, 10).start, 0);
});

test('with no known recording length nothing is clipped', () => {
  // Before any media is loaded the document is its own clock, so there is no limit to clip against.
  const span = captionSpan({ start: 1, end: 9e9 }, 0);
  assert.equal(span.end, 9e9);
  assert.equal(span.beyond, false);
});
