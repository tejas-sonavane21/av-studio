/**
 * preview-proxy.test.js — the two modules that make the preview lighter without touching the export.
 *
 * `io/preview-proxy.js` makes a smaller copy of the picture for the preview, and `io/preview-source.js`
 * decides which picture each side gets. The rules that matter cannot be eyeballed in a browser — "the
 * copy is never exported", "a 1080p file is left alone", "a copy is never upscaled", "the frame rate is
 * capped but never raised" — so they are pinned down here, where they run in milliseconds.
 *
 * The conversion itself needs a decoder and an encoder, so it is exercised through the UI smoke run;
 * everything that can be decided without one is decided here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Quality } from '../../vendor/mediabunny/mediabunny.min.mjs';
import {
  DEFAULT_PROXY_FPS,
  PROXY_CONTAINER,
  PROXY_KEYFRAME_SECONDS,
  PROXY_LONG_EDGE,
  PROXY_MIME_TYPE,
  PROXY_RATE_TOLERANCE,
  describeDiscards,
  describeDrift,
  describeFrames,
  needsProxy,
  proxyBitrate,
  proxySize,
  proxySupported,
  proxyVideoOptions,
} from '../../src/io/preview-proxy.js';
import { createPreviewSource } from '../../src/io/preview-source.js';

// --------------------------------------------------------------------------- //
// what is worth copying, and how big the copy is
// --------------------------------------------------------------------------- //

test('a picture is copied only when it is big enough to be worth it', () => {
  assert.equal(needsProxy(1920, 1080), false, '1080p decodes fine — copying it would be busywork');
  assert.equal(needsProxy(3840, 2160), true);
  assert.equal(needsProxy(1080, 1920), false, 'the long edge decides, not the width');
  assert.equal(needsProxy(2160, 3840), true, 'a portrait 4K clip counts the same');
  assert.equal(needsProxy(0, 0), false);
  assert.equal(needsProxy(undefined, undefined), false);
});

test('a copy is scaled to the long-edge cap, portrait or landscape', () => {
  assert.deepEqual(proxySize(3840, 2160), { width: PROXY_LONG_EDGE, height: 720 });
  assert.deepEqual(proxySize(2160, 3840), { width: 720, height: PROXY_LONG_EDGE });
  assert.deepEqual(proxySize(7680, 4320), { width: PROXY_LONG_EDGE, height: 720 });
});

test('a picture that is already small is not copied up to the cap', () => {
  // Upscaling would make it slower to decode and no clearer — the opposite of the point.
  assert.deepEqual(proxySize(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(proxySize(960, 540), { width: 960, height: 540 });
});

test('a copy is always an even size, because a codec config with an odd edge is refused', () => {
  const size = proxySize(3841, 2161);
  assert.equal(size.width % 2, 0);
  assert.equal(size.height % 2, 0);
  assert.equal(proxySize(1919, 1079).width % 2, 0, 'and so is a source that is odd itself');
});

test('a picture with no usable size has no copy size', () => {
  assert.equal(proxySize(0, 0), null);
  assert.equal(proxySize('wide', 'tall'), null);
});

test('the copy is given a modest bitrate, however big the tool gets', () => {
  const small = proxyBitrate(640, 360, 30);
  const hd = proxyBitrate(1280, 720, 30);
  assert.ok(hd > small, 'a bigger frame gets more bits');
  assert.ok(hd < 4_000_000, `720p30 should stay cheap to decode, got ${hd}`);
  assert.equal(proxyBitrate(7680, 4320, 60), 6_000_000, 'and the clamp holds at the top');
  assert.ok(proxyBitrate(2, 2, 1) >= 600_000, 'and at the bottom');
});

// --------------------------------------------------------------------------- //
// how the copy is encoded
// --------------------------------------------------------------------------- //

test('the copy is written as WebM, which every Chrome can encode and contain', () => {
  assert.equal(PROXY_CONTAINER, 'webm');
  assert.equal(PROXY_MIME_TYPE, 'video/webm');
});

test('the converter is asked for the copy at an even size, with an explicit bitrate', () => {
  const options = proxyVideoOptions({ width: 1281, height: 721 });
  assert.equal(options.width % 2, 0);
  assert.equal(options.height % 2, 0);
  assert.equal(options.fit, 'contain', 'rounding an edge must not stretch the picture');
  assert.equal(options.keyFrameInterval, PROXY_KEYFRAME_SECONDS);
  assert.ok(options.quality instanceof Quality);
  // The private field, read on purpose: a `Quality` exposes nothing else to ask, and this number
  // *is* the point — a copy whose bitrate is not the one this module measured is a copy that is
  // bigger or blurrier than the thing it was meant to lighten. `proxyBitrate` is where it comes from.
  assert.equal(options.quality._bitrate, proxyBitrate(options.width, options.height, DEFAULT_PROXY_FPS));
});

test('an asked-for bitrate is used rather than the computed one', () => {
  assert.equal(proxyVideoOptions({ width: 320, height: 180, bitsPerSecond: 400_000 }).quality._bitrate, 400_000);
  assert.equal(proxyVideoOptions({ width: 320, height: 180, fps: 24 }).quality._bitrate, proxyBitrate(320, 180, 24));
});

test('the frame rate is a ceiling the caller applies, never something this module imposes', () => {
  // Asking a conversion for a rate on a source that is *slower* is asking it to invent frames that
  // were never in the file, so `proxyVideoOptions` does not set the field at all: the caller sets it
  // from a measured source rate, and only when the source is genuinely faster than the cap.
  assert.equal('frameRate' in proxyVideoOptions({ width: 1280, height: 720, fps: 30 }), false);
  assert.ok(PROXY_RATE_TOLERANCE > 0 && PROXY_RATE_TOLERANCE < 1, '29.97 frames a second is not 30');
});

test('a track the converter could not carry is named, with the reason it gave', () => {
  // Mediabunny drops what it cannot carry instead of failing the conversion, which is right and
  // would be a terrible thing to hide: "the copy has no sound" is a bug report, and "no encodable
  // target codec" is one somebody can act on.
  assert.equal(describeDiscards([]), '');
  assert.equal(describeDiscards(null), '');
  const text = describeDiscards([{ track: { type: 'audio' }, reason: 'no_encodable_target_codec' }]);
  assert.match(text, /audio/);
  assert.match(text, /no_encodable_target_codec/);
  assert.match(describeDiscards([{ track: { type: 'video' }, reason: 'undecodable_source_codec' }]), /video/);
});

test('what the copy holds is reported as the copy holds it, not as it was asked for', () => {
  const text = describeFrames({ frames: 214, seconds: 9 });
  assert.match(text, /214 frame\(s\)/);
  assert.match(text, /23\.8 a second/);
  assert.match(text, /nothing here waits for a clock/);
  // Nothing is claimed about a copy with no frames in it — the caller reports that as a failure.
  assert.equal(describeFrames({ frames: 0, seconds: 9 }), '');
  assert.equal(describeFrames(), '');
});

// --------------------------------------------------------------------------- //
// drift
// --------------------------------------------------------------------------- //

test('a copy within a frame of the original says nothing about it', () => {
  assert.equal(describeDrift(182.5, 182.5), '');
  assert.equal(describeDrift(182.5, 182.53), '');
  assert.equal(describeDrift(0, 0), '');
});

test('a copy that came out measurably long or short says so, and says the export is safe', () => {
  const long = describeDrift(100, 100.4);
  assert.match(long, /longer/);
  assert.match(long, /0\.40s/);
  assert.match(long, /export is unaffected/);

  const short = describeDrift(100, 99.6);
  assert.match(short, /shorter/);
});

test('a browser without WebCodecs cannot make a copy, and says so by refusing the feature', () => {
  assert.equal(proxySupported({}), false);
  assert.equal(proxySupported({ VideoEncoder: function () {}, requestAnimationFrame: () => {} }), false, 'a frame needs VideoFrame');
  assert.equal(
    proxySupported({
      VideoEncoder: function () {},
      VideoFrame: function () {},
      requestAnimationFrame: () => {},
      HTMLCanvasElement: { prototype: { getContext() {} } },
    }),
    true,
  );
});

// --------------------------------------------------------------------------- //
// preview copy vs. export: the split that must never blur
// --------------------------------------------------------------------------- //

test('a copy is what the preview plays and never what the export encodes', () => {
  const source = createPreviewSource();
  source.setOriginal({ name: 'master.mp4', url: 'blob:original', width: 3840, height: 2160, duration: 182.5 });
  assert.equal(source.url, 'blob:original');
  assert.equal(source.exportUrl, 'blob:original');
  assert.equal(source.proxied, false);

  source.setProxy({ url: 'blob:copy', width: 1280, height: 720, seconds: 182.5, bytes: 12_345_678 });
  assert.equal(source.url, 'blob:copy', 'the element on screen plays the lighter copy');
  assert.equal(source.exportUrl, 'blob:original', 'and the encoder still gets the file that was loaded');
  assert.deepEqual(source.exportSize, { width: 3840, height: 2160 }, 'at the resolution it was loaded at');
  assert.equal(source.proxied, true);
});

test('going back to the original drops the copy from the preview too', () => {
  const source = createPreviewSource();
  source.setOriginal({ name: 'a.mp4', url: 'blob:a', width: 3840, height: 2160, duration: 10 });
  source.setProxy({ url: 'blob:copy', width: 1280, height: 720 });
  assert.equal(source.clearProxy(), true);
  assert.equal(source.url, 'blob:a');
  assert.equal(source.proxied, false);
  assert.equal(source.clearProxy(), false, 'clearing a copy that is not there is not an error');
});

test('loading a different picture throws the old copy away with it', () => {
  const source = createPreviewSource();
  source.setOriginal({ name: 'a.mp4', url: 'blob:a', width: 3840, height: 2160, duration: 10 });
  source.setProxy({ url: 'blob:copy-of-a', width: 1280, height: 720 });
  source.setOriginal({ name: 'b.mp4', url: 'blob:b' });

  assert.equal(source.url, 'blob:b');
  assert.equal(source.proxied, false, 'a copy of another file must not be shown under this one');
  assert.equal(source.exportUrl, 'blob:b');
  assert.equal(createPreviewSource().setProxy({ url: 'blob:copy' }), null, 'there is nothing to attach a copy to');
});

test('metadata that has not arrived does not overwrite metadata that has', () => {
  const source = createPreviewSource();
  source.setOriginal({ name: 'a.mp4', url: 'blob:a', width: 3840, height: 2160, duration: 10 });
  // An element that has not read its metadata reports 0, and losing a good size would lose the
  // export's resolution — which is the one number here that must not be guessed at.
  source.setOriginalSize({ width: 0, height: 0, duration: 0 });
  assert.deepEqual(source.exportSize, { width: 3840, height: 2160 });
  assert.equal(source.original.duration, 10);
  source.setOriginalSize({ width: 1920, height: 1080, duration: 9.5 });
  assert.deepEqual(source.exportSize, { width: 1920, height: 1080 });
});

test('the description of a copied picture names the copy and the export separately', () => {
  const source = createPreviewSource();
  assert.match(source.describe(), /no picture loaded/);
  source.setOriginal({ name: 'song.mp4', url: 'blob:a', width: 3840, height: 2160, duration: 182.5 });
  assert.match(source.describe(), /Previewing the original/);

  source.setProxy({ url: 'blob:copy', width: 1280, height: 720, seconds: 182.5, bytes: 4_000_000, frames: 4380, averageFps: 24 });
  const text = source.describe();
  assert.match(text, /1280×720/);
  assert.match(text, /4380 frames at 24\/s/);
  assert.match(text, /Export still encodes the original 3840×2160/);
});
