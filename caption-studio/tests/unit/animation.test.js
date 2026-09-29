/**
 * animation.test.js — easings and presets.
 *
 * The test that matters most is the parity guard: the default template's `animation.in` is
 * `'reveal'`, and v10's output was *completely static* text whose only motion was the reveal
 * itself. So `reveal` must be the exact identity transform at every instant. If a future change
 * makes `reveal` fade, slide or scale, parity silently breaks — this test stops that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EASINGS,
  IDENTITY,
  animationAt,
  animationNames,
  ease,
  getAnimation,
  registerAnimation,
} from '../../src/render/animation.js';
import { createDefaultStyle } from '../../src/model/schema.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const SCOPE = { start: 100, end: 101 };
const fresh = () => ({ opacity: 1, scale: 1, dx: 0, dy: 0 });

test('every easing maps 0 → 0 and 1 → 1', () => {
  for (const [name, fn] of Object.entries(EASINGS)) {
    close(fn(0), 0, 1e-9);
    close(fn(1), 1, 1e-9);
    assert.equal(typeof name, 'string');
  }
});

test('an unknown easing falls back to linear', () => {
  assert.equal(ease('does-not-exist', 0.25), 0.25);
  assert.equal(ease(undefined, 0.5), 0.5);
});

// ---------------------------------------------------------------------------
// the parity guard
// ---------------------------------------------------------------------------

test('PARITY: the default template animation is the identity transform', () => {
  const style = createDefaultStyle();
  assert.equal(style.animation.in, 'reveal', 'the parity template animates via reveal only');
  assert.equal(getAnimation('reveal').apply(), undefined);

  const out = fresh();
  for (const t of [99.9, 100, 100.06, 100.12, 100.5, 101, 105]) {
    animationAt(style.animation, SCOPE, t, out);
    close(out.opacity, 1);
    close(out.scale, 1);
    assert.equal(out.dx, 0);
    assert.equal(out.dy, 0);
  }
});

test('a missing or empty animation is the identity', () => {
  const out = fresh();
  animationAt(null, SCOPE, 100.05, out);
  assert.deepEqual(out, { opacity: 1, scale: 1, dx: 0, dy: 0 });
  animationAt({}, SCOPE, 100.05, out);
  assert.deepEqual(out, { opacity: 1, scale: 1, dx: 0, dy: 0 });
  animationAt({ in: 'nope', inDur: 0.2 }, SCOPE, 100.05, out);
  assert.deepEqual(out, { opacity: 1, scale: 1, dx: 0, dy: 0 });
});

test('a zero-length animation window is a no-op, not a NaN', () => {
  const out = fresh();
  animationAt({ in: 'fade', inDur: 0 }, SCOPE, 100, out);
  assert.deepEqual(out, { opacity: 1, scale: 1, dx: 0, dy: 0 });
});

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

test('fade ramps opacity across the in window and holds at 1 after', () => {
  const out = fresh();
  const anim = { in: 'fade', inDur: 0.2 };
  animationAt(anim, SCOPE, 100, out);
  close(out.opacity, 0);
  animationAt(anim, SCOPE, 100.1, out);
  close(out.opacity, 0.5);
  animationAt(anim, SCOPE, 100.2, out);
  close(out.opacity, 1);
  animationAt(anim, SCOPE, 100.9, out);
  close(out.opacity, 1, 1e-9);
});

test('the fade-out window is measured back from the scope end', () => {
  const out = fresh();
  const anim = { out: 'fade', outDur: 0.1 };
  animationAt(anim, SCOPE, 101, out);
  close(out.opacity, 0);
  animationAt(anim, SCOPE, 100.95, out);
  close(out.opacity, 0.5);
  animationAt(anim, SCOPE, 100.5, out);
  close(out.opacity, 1);
});

test('slide presets offset by one em at the start and land at zero', () => {
  const cases = [
    ['slideUp', 'dy', 1],
    ['slideDown', 'dy', -1],
    ['slideLeft', 'dx', 1],
    ['slideRight', 'dx', -1],
  ];
  for (const [name, axis, sign] of cases) {
    const out = fresh();
    animationAt({ in: name, inDur: 0.2 }, SCOPE, 100, out);
    close(out[axis], sign, 1e-9);
    close(out.opacity, 0);
    animationAt({ in: name, inDur: 0.2 }, SCOPE, 100.2, out);
    close(out[axis], 0, 1e-9);
    close(out.opacity, 1, 1e-9);
  }
});

test('scale presets stay finite and positive', () => {
  for (const name of ['zoomIn', 'pop', 'bounce', 'zoomOut']) {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const out = fresh();
      animationAt({ in: name, inDur: 1, inEase: 'quadOut' }, { start: 0, end: 1 }, p, out);
      assert.ok(Number.isFinite(out.scale), `${name} scale finite`);
      assert.ok(out.scale >= 0, `${name} scale non-negative at p=${p}`);
      assert.ok(Number.isFinite(out.opacity), `${name} opacity finite`);
      assert.ok(out.opacity >= 0 && out.opacity <= 1.0001, `${name} opacity in range at p=${p}`);
    }
  }
});

test('pop overshoots past 1 then settles exactly at 1', () => {
  const out = fresh();
  let maxScale = 0;
  for (let i = 0; i <= 20; i++) {
    animationAt({ in: 'pop', inDur: 1 }, { start: 0, end: 1 }, i / 20, out);
    maxScale = Math.max(maxScale, out.scale);
  }
  assert.ok(maxScale > 1, 'pop should overshoot');
  animationAt({ in: 'pop', inDur: 1 }, { start: 0, end: 1 }, 1, out);
  close(out.scale, 1, 1e-9);
});

test('in and out compose multiplicatively on opacity', () => {
  // a scope short enough that the two windows overlap: in [100,100.2], out [100,100.2]
  const anim = { in: 'fade', inDur: 0.2, out: 'fade', outDur: 0.2 };
  const scope = { start: 100, end: 100.2 };
  const out = fresh();
  animationAt(anim, scope, 100.1, out); // halfway through both
  close(out.opacity, 0.25, 1e-9);
  animationAt(anim, scope, 100, out); // start: fully in-transparent
  close(out.opacity, 0, 1e-9);
  animationAt(anim, scope, 100.2, out); // end: fully out-transparent
  close(out.opacity, 0, 1e-9);
});

test('the out window is inert while the in window is still running', () => {
  const out = fresh();
  animationAt({ in: 'fade', inDur: 0.1, out: 'fade', outDur: 0.1 }, { start: 100, end: 101 }, 100.05, out);
  close(out.opacity, 0.5, 1e-9); // out progress is clamped to 1 here, so it multiplies by 1
});

test('the scratch object is reused, so no per-frame allocation', () => {
  const out = fresh();
  const same = animationAt({ in: 'fade', inDur: 0.1 }, SCOPE, 100.05, out);
  assert.equal(same, out, 'must return the object it was given');
});

test('the registry exposes the planned vocabulary', () => {
  const names = animationNames();
  for (const expected of ['reveal', 'fade', 'slideUp', 'zoomIn', 'pop', 'bounce', 'typewriter', 'karaoke', 'boxHighlight']) {
    assert.ok(names.includes(expected), `missing preset: ${expected}`);
  }
  for (const name of ['typewriter', 'karaoke', 'highlight', 'boxHighlight', 'colourHighlight']) {
    assert.equal(getAnimation(name).decorationDriven, true, `${name} is decoration-driven`);
  }
  assert.equal(getAnimation('nope'), null);
});

test('a custom preset can be registered', () => {
  registerAnimation('test-only', { scope: 'word', apply: (n, p) => { n.opacity *= p; } });
  const out = fresh();
  animationAt({ in: 'test-only', inDur: 1 }, { start: 0, end: 1 }, 0.5, out);
  close(out.opacity, 0.5);
});

test('IDENTITY is frozen so a preset cannot corrupt the shared default', () => {
  assert.equal(Object.isFrozen(IDENTITY), true);
});
