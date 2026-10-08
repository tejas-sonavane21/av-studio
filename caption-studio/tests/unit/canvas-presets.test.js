/**
 * canvas-presets.test.js — the frame-ratio presets.
 *
 * Two properties are worth defending here, and both are the kind that fail *silently* in a browser:
 *
 * 1. **A preset's canvas is the ratio it names.** The sizes are rounded to even numbers for the
 *    encoder's sake, so a preset could easily drift into being a slightly different shape.
 * 2. **A preset never invents pixels.** Re-cutting a 720p landscape clip as 9:16 must not produce a
 *    1080×1920 project, because the export would then upscale a picture that has no such detail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CANVAS_PRESETS, canvasForPreset, presetIdFor } from '../../src/model/schema.js';
import { fitRect } from '../../src/util/math.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('every preset resolves to the aspect ratio it names', () => {
  for (const [id, preset] of Object.entries(CANVAS_PRESETS)) {
    const canvas = canvasForPreset(id);
    const [w, h] = id.split(':').map(Number);
    const target = w / h;
    assert.ok(canvas.width > 0 && canvas.height > 0, `${id} produced a usable canvas`);
    assert.ok(
      Math.abs(canvas.width / canvas.height - target) / target < 0.01,
      `${id} → ${canvas.width}×${canvas.height} is not ${w}:${h}`,
    );
    assert.ok(canvas.width <= preset.width && canvas.height <= preset.height, `${id} does not exceed its own target`);
  }
});

test('presets resolve to their own delivery size when nothing constrains them', () => {
  assert.deepEqual(canvasForPreset('16:9'), { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(canvasForPreset('9:16'), { width: 1080, height: 1920, fps: 30 });
  assert.deepEqual(canvasForPreset('1:1'), { width: 1080, height: 1080, fps: 30 });
});

test('dimensions are always even, because an encoder will not take an odd one', () => {
  for (const id of Object.keys(CANVAS_PRESETS)) {
    const canvas = canvasForPreset(id, { source: { width: 1281, height: 721 } });
    assert.equal(canvas.width % 2, 0, `${id} width`);
    assert.equal(canvas.height % 2, 0, `${id} height`);
  }
});

test('a preset is capped at the picture’s own long edge — no invented detail', () => {
  const small = { width: 1280, height: 720 };
  assert.deepEqual(canvasForPreset('9:16', { source: small }), { width: 720, height: 1280, fps: 30 });
  assert.deepEqual(canvasForPreset('16:9', { source: small }), { width: 1280, height: 720, fps: 30 });
  // a bigger picture is not used as an excuse to grow past the preset either
  assert.deepEqual(canvasForPreset('9:16', { source: { width: 3840, height: 2160 } }), {
    width: 1080,
    height: 1920,
    fps: 30,
  });
});

test('the frame rate is carried through, and defaults rather than going missing', () => {
  assert.equal(canvasForPreset('1:1', { fps: 25 }).fps, 25);
  assert.equal(canvasForPreset('1:1', { fps: 0 }).fps, 30);
  assert.equal(canvasForPreset('1:1', {}).fps, 30);
});

test('an unknown preset is null, not a guess', () => {
  assert.equal(canvasForPreset('source'), null);
  assert.equal(canvasForPreset('3:2'), null);
  assert.equal(canvasForPreset(undefined), null);
});

test('a canvas reads back as the preset it is on', () => {
  assert.equal(presetIdFor({ width: 1280, height: 720 }), '16:9');
  assert.equal(presetIdFor({ width: 720, height: 1280 }), '9:16');
  assert.equal(presetIdFor({ width: 1080, height: 1080 }), '1:1');
  assert.equal(presetIdFor({ width: 1080, height: 1440 }), '3:4');
  assert.equal(presetIdFor({ width: 1080, height: 1350 }), '4:5');
  // a source clip's own odd shape is not forced into a preset
  assert.equal(presetIdFor({ width: 1000, height: 301 }), 'source');
  assert.equal(presetIdFor({ width: 0, height: 0 }), 'source');
  assert.equal(presetIdFor(null), 'source');
});

test('fitRect letterboxes a picture into a frame of another ratio', () => {
  // a 16:9 picture inside a 9:16 frame: full width, centred vertically
  const tall = fitRect({ width: 1280, height: 720 }, { width: 1080, height: 1920 });
  near(tall.x, 0);
  near(tall.width, 1080);
  near(tall.height, 607.5);
  near(tall.y, (1920 - 607.5) / 2);
  // and the same picture in a 16:9 frame is the frame itself
  assert.deepEqual(fitRect({ width: 1280, height: 720 }, { width: 1920, height: 1080 }), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
});

test('fitRect with cover fills the box and lets the overflow hang out', () => {
  const cover = fitRect({ width: 1280, height: 720 }, { width: 1080, height: 1920 }, { mode: 'cover' });
  near(cover.height, 1920);
  near(cover.width, 1280 * (1920 / 720));
  assert.ok(cover.x < 0, 'cropped on both sides rather than letterboxed');
  near(cover.y, 0);
});

test('fitRect never returns a NaN when a shape is missing', () => {
  assert.deepEqual(fitRect({ width: 0, height: 0 }, { width: 640, height: 480 }), {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
  });
  assert.deepEqual(fitRect(null, { width: 640, height: 480 }), { x: 0, y: 0, width: 640, height: 480 });
  assert.deepEqual(fitRect({ width: 16, height: 9 }, null), { x: 0, y: 0, width: 0, height: 0 });
});

test('the presets stay apart — no canvas reads back as the wrong one', () => {
  for (const id of Object.keys(CANVAS_PRESETS)) {
    const canvas = canvasForPreset(id);
    assert.equal(presetIdFor(canvas), id, `${id} → ${canvas.width}×${canvas.height}`);
  }
});
