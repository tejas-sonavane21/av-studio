/**
 * timeline.test.js — the timeline's pure arithmetic: clock formatting and ruler spacing.
 *
 * The strip itself is DOM (positions, clicks, scrolling) and is exercised through the UI smoke run;
 * the two decisions that can be got wrong without a browser are tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatClock, tickStep } from '../../src/editor/timeline.js';

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
