/**
 * export-settings.test.js — the export window's arithmetic.
 *
 * Two things here are worth pinning down without a browser: that a resolution preset really does
 * re-tune the frame rate and quality (the behaviour that was asked for), and that a manual bitrate
 * really does stop following them (the behaviour that stops the surface fighting the user).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FPS,
  DEFAULT_RESOLUTION,
  RESOLUTION_PRESETS,
  applyResolution,
  defaultExportSettings,
  describeExportResult,
  describeSettings,
  effectiveBitrates,
  encoderSettings,
  outputSize,
  recommendFor,
  recommendedFps,
} from '../../src/io/export-settings.js';

test('the offered frame rate is the one closest to what the source runs at', () => {
  assert.equal(recommendedFps(25), 25);
  assert.equal(recommendedFps(24), 24);
  assert.equal(recommendedFps(29.97), 30);
  assert.equal(recommendedFps(48), 50);
  assert.equal(recommendedFps(120), 60);
  assert.equal(recommendedFps(0), DEFAULT_FPS);
  assert.equal(recommendedFps(undefined), DEFAULT_FPS);
  assert.equal(recommendedFps(NaN), DEFAULT_FPS);
});

test('the defaults are a real export, not a placeholder', () => {
  const settings = defaultExportSettings();
  assert.equal(settings.format, 'mp4');
  assert.equal(settings.resolution, DEFAULT_RESOLUTION);
  assert.equal(settings.fps, DEFAULT_FPS);
  assert.equal(settings.quality, 'high');
  assert.equal(settings.videoBitrateMode, 'auto', 'the bitrate follows until it is set by hand');
  assert.equal(settings.audioBitrateMode, 'auto');
});

test('choosing a resolution re-tunes the frame rate and the quality', () => {
  const base = defaultExportSettings();
  const sd = applyResolution(base, '480p', { sourceFps: 30 });
  assert.equal(sd.quality, 'balanced', 'a small frame does not need the best profile');
  assert.equal(sd.fps, 30);

  const uhd = applyResolution(base, '2160p', { sourceFps: 24 });
  assert.equal(uhd.quality, 'best', 'a 4K frame does');
  assert.equal(uhd.fps, 24, 'and it still matches the source rather than assuming 30');

  const source = applyResolution(base, 'source', { sourceFps: 25 });
  assert.equal(source.resolution, 'source');
  assert.equal(source.fps, 25);
});

test('an unknown resolution id falls back rather than producing nothing', () => {
  const settings = applyResolution(defaultExportSettings(), 'nonsense', { sourceFps: 30 });
  assert.equal(settings.resolution, DEFAULT_RESOLUTION);
  assert.ok(RESOLUTION_PRESETS[settings.resolution]);
});

test('the automatic bitrate follows the frame size, and a custom one does not', () => {
  const auto = { ...defaultExportSettings(), fps: 30, quality: 'high' };
  const small = effectiveBitrates(auto, { width: 1280, height: 720 });
  const large = effectiveBitrates(auto, { width: 3840, height: 2160 });
  assert.ok(large.videoBitsPerSecond > small.videoBitsPerSecond * 5, 'bits-per-pixel scales with the frame');
  assert.equal(small.audioBitsPerSecond, 192000, 'audio follows the quality preset');

  const custom = { ...auto, videoBitrateMode: 'custom', videoBitrate: 12000000 };
  assert.equal(effectiveBitrates(custom, { width: 1280, height: 720 }).videoBitsPerSecond, 12000000);
  const customAudio = { ...auto, audioBitrateMode: 'custom', audioBitrate: 96000 };
  assert.equal(effectiveBitrates(customAudio, { width: 1280, height: 720 }).audioBitsPerSecond, 96000);
});

test('a custom bitrate of zero is not a custom bitrate', () => {
  const settings = { ...defaultExportSettings(), videoBitrateMode: 'custom', videoBitrate: 0 };
  const rates = effectiveBitrates(settings, { width: 1920, height: 1080 });
  assert.ok(rates.videoBitsPerSecond > 250000, 'a blank field falls back to the computed rate');
});

test('the output size comes from the preset and the frame shape', () => {
  const landscape = { ...defaultExportSettings(), resolution: '1080p' };
  assert.deepEqual(outputSize(landscape, { aspect: 16 / 9 }), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(landscape, { aspect: 9 / 16 }), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(landscape, { aspect: 1 }), { width: 1080, height: 1080 });

  const source = { ...defaultExportSettings(), resolution: 'source' };
  assert.deepEqual(
    outputSize(source, { aspect: 640 / 360, docSize: { width: 641, height: 361 } }),
    { width: 642, height: 362 },
    'source keeps the project’s own pixels, rounded to an encodable size',
  );
  assert.deepEqual(outputSize(source, { aspect: 16 / 9 }), { width: 1280, height: 720 }, 'with no project, 720p');
});

test('the encoder is configured from one place, so the readout and the encode cannot disagree', () => {
  const settings = { ...defaultExportSettings(), resolution: '720p', fps: 50, format: 'webm' };
  const encoder = encoderSettings(settings, { aspect: 16 / 9 });
  assert.equal(encoder.format, 'webm');
  assert.deepEqual(encoder.size, { width: 1280, height: 720 });
  assert.equal(encoder.fps, 50);
  assert.ok(encoder.videoBitsPerSecond > 0);
  assert.ok(encoder.audioBitsPerSecond > 0);
  assert.match(describeSettings(settings, { aspect: 16 / 9 }), /^WEBM · 1280×720 · 50 fps · high · [\d.]+ Mbps video · \d+ kbps audio$/);
});

test('the finished export is described by name and size, so the window can say it is done', () => {
  const { headline, caveat } = describeExportResult({
    name: 'clip.mp4',
    bytes: 9156693,
    seconds: 2,
    frames: 50,
  });
  assert.equal(headline, 'Saved clip.mp4 — 9.2 MB · 2.0s · 50 frames');
  assert.equal(caveat, '', 'a clean export has no caveat');
});

test('the one compromise the encoder had to make is carried on its own line', () => {
  const note = 'the AAC encoder will not take 256 kbps, so the sound is encoded at 192 kbps';
  assert.equal(describeExportResult({ name: 'a.mp4', bytes: 1000, audioNote: note }).caveat, note);
  // a skipped audio track is the caveat that matters more, so it wins when both are present
  assert.equal(
    describeExportResult({ name: 'a.mp4', bytes: 1000, audioNote: note, audioSkipped: 'no uploaded audio file' })
      .caveat,
    'no uploaded audio file',
  );
});

test('a result with nothing in it still describes something, rather than claiming a file it cannot name', () => {
  assert.equal(describeExportResult({}).headline, 'Saved the video — 0.0 MB');
  assert.equal(describeExportResult().caveat, '');
});

test('a nonsense frame rate or format is clamped rather than passed to the encoder', () => {
  const encoder = encoderSettings(
    { ...defaultExportSettings(), fps: 0, format: 'avi-totally-not-a-container' },
    { aspect: 16 / 9 },
  );
  assert.equal(encoder.format, 'mp4');
  assert.equal(encoder.fps, DEFAULT_FPS);
  assert.ok(encoderSettings({ ...defaultExportSettings(), fps: 999 }, { aspect: 16 / 9 }).fps <= 60);
});
