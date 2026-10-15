/**
 * preview-proxy.test.js — the two modules that make the preview lighter without touching the export.
 *
 * `io/preview-proxy.js` makes a smaller copy of the picture for the preview, and `io/preview-source.js`
 * decides which picture each side gets. The rules that matter cannot be eyeballed in a browser — "the
 * copy is never exported", "anything bigger than a 720p picture gets a 720p copy", "a copy is never
 * upscaled", "the frame rate is capped but never raised", "a copy is built without being asked for, but
 * not for a picture the user has already sent back to the original by hand" — so they are pinned down
 * here, where they run in milliseconds.
 *
 * The conversion itself needs a decoder and an encoder, so it is exercised through the UI smoke run;
 * everything that can be decided without one is decided here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Quality } from '../../vendor/mediabunny/mediabunny.min.mjs';
import {
  DEFAULT_PROXY_FPS,
  DEFAULT_PROXY_ID,
  PROXY_BITS_PER_PIXEL,
  PROXY_CONTAINER,
  PROXY_KEYFRAME_SECONDS,
  PROXY_LADDER,
  PROXY_LONG_EDGE,
  PROXY_MAX_BITRATE,
  PROXY_MIME_TYPE,
  PROXY_MIN_BITRATE,
  PROXY_RATE_TOLERANCE,
  PROXY_THRESHOLD,
  autoProxyDecision,
  describeDiscards,
  describeDrift,
  describeFrames,
  needsProxy,
  proxyBitrate,
  proxyLongEdge,
  proxyPlan,
  proxyRung,
  proxySize,
  proxySupported,
  proxyVideoOptions,
} from '../../src/io/preview-proxy.js';
import { createPreviewSource } from '../../src/io/preview-source.js';

// --------------------------------------------------------------------------- //
// what is worth copying, and how big the copy is
// --------------------------------------------------------------------------- //

test('a picture is copied when it is bigger than the copy would be', () => {
  assert.equal(PROXY_THRESHOLD, PROXY_LONG_EDGE, 'the bar and the cap are the same picture: 720p');
  assert.equal(needsProxy(1920, 1080), true, '1080p is copied — 720p is what the preview is for');
  assert.equal(needsProxy(3840, 2160), true);
  assert.equal(needsProxy(2160, 3840), true, 'a portrait 4K clip counts the same');
  assert.equal(needsProxy(1280, 720), false, 'a 720p picture is already the size a copy would be');
  assert.equal(needsProxy(1080, 1920), true, 'the long edge decides, not the width');
  assert.equal(needsProxy(720, 1280), false, 'and a portrait picture at the cap is left alone');
  assert.equal(needsProxy(0, 0), false);
  assert.equal(needsProxy(undefined, undefined), false);
});

test('a 1080p picture is copied to 720p, which is the size the preview is for', () => {
  assert.deepEqual(proxySize(1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(proxySize(1080, 1920), { width: 720, height: 1280 }, 'and portrait keeps its shape');
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
  // The number that matters, and the reason the factor moved from 0.1 to 0.06: a 720p30 copy of a 4K
  // master should cost about 1.7 Mbps, so that the preview is cheap to *decode* as well as to look at.
  assert.equal(hd, Math.round(1280 * 720 * 30 * PROXY_BITS_PER_PIXEL));
  assert.ok(hd > 1_500_000 && hd < 1_800_000, `720p30 should stay cheap to decode, got ${hd}`);
  assert.equal(proxyBitrate(7680, 4320, 60), PROXY_MAX_BITRATE, 'and the clamp holds at the top');
  assert.equal(proxyBitrate(2, 2, 1), PROXY_MIN_BITRATE, 'and at the bottom');
});

// --------------------------------------------------------------------------- //
// the size ladder the user picks from
// --------------------------------------------------------------------------- //

test('the ladder is a list of sizes, biggest first, and 720p is the default rung', () => {
  assert.deepEqual(
    PROXY_LADDER.map((rung) => rung.id),
    ['1080p', '720p', '540p', '480p', '360p'],
  );
  for (const rung of PROXY_LADDER) {
    assert.ok(rung.longEdge > 0 && Number.isInteger(rung.longEdge), `${rung.id} has a long edge`);
    assert.equal(rung.label, rung.id, 'the label is the size people say out loud');
  }
  // Biggest first, so the list can be read off a selects and compared by size.
  const edges = PROXY_LADDER.map((rung) => rung.longEdge);
  assert.deepEqual(edges, [...edges].sort((a, b) => b - a));
  // The default rung is the size this project measured everything at — the one the documented 720p
  // means, and the one the old single-size module hard-coded.
  assert.equal(DEFAULT_PROXY_ID, '720p');
  assert.equal(proxyLongEdge(DEFAULT_PROXY_ID), PROXY_LONG_EDGE);
  assert.equal(proxyLongEdge(DEFAULT_PROXY_ID), PROXY_THRESHOLD, 'the default rung *is* the old threshold');
  assert.equal(proxyRung(DEFAULT_PROXY_ID).longEdge, 1280);
});

test('an unknown rung falls back to the default rather than leaving the panel with no size', () => {
  assert.equal(proxyRung('1440p').id, DEFAULT_PROXY_ID, 'a rung that does not exist');
  assert.equal(proxyRung(undefined).id, DEFAULT_PROXY_ID);
  assert.equal(proxyRung('').longEdge, PROXY_LONG_EDGE);
});

test('a rung means a size for this picture: even, never upscaled, and never stretched', () => {
  const fourK = { width: 3840, height: 2160 };
  assert.deepEqual(proxyPlan(fourK, { id: '720p' }).size, { width: 1280, height: 720 });
  assert.deepEqual(proxyPlan(fourK, { id: '480p' }).size, { width: 854, height: 480 });
  assert.deepEqual(proxyPlan(fourK, { id: '360p' }).size, { width: 640, height: 360 });
  assert.deepEqual(proxyPlan(fourK, { id: '1080p' }).size, { width: 1920, height: 1080 });
  // Portrait follows the long edge, which is the number the rung is named for.
  assert.deepEqual(proxyPlan({ width: 2160, height: 3840 }, { id: '720p' }).size, { width: 720, height: 1280 });
});

test('the rung decides whether a copy is worth making at all', () => {
  const hd = { width: 1920, height: 1080 };
  // The old policy in one line: a 1080p master is copied at the default rung, and left alone at 1080p.
  assert.equal(proxyPlan(hd, { id: '720p' }).worth, true);
  assert.equal(proxyPlan(hd, { id: '1080p' }).worth, false, 'a copy that would not shrink the picture');
  assert.equal(proxyPlan(hd, { id: '1080p' }).size, null, 'and no size to build with');
  assert.match(proxyPlan(hd, { id: '1080p' }).reason, /no bigger than a 1080p copy/);
  // Below the rung, a copy is offered that the default would never have offered — which is the whole
  // point of the picker: a machine that cannot play 720p can ask for 480p.
  const hdReady = { width: 1280, height: 720 };
  assert.equal(proxyPlan(hdReady).worth, false, 'at the default rung there is nothing to do');
  assert.equal(proxyPlan(hdReady, { id: '480p' }).worth, true, 'at 480p there is');
  assert.deepEqual(proxyPlan(hdReady, { id: '480p' }).size, { width: 854, height: 480 });
});

test('the bitrate follows the rung, because it follows the pixels', () => {
  const fourK = { width: 3840, height: 2160 };
  const at = (id) => proxyPlan(fourK, { id });
  assert.equal(at('720p').bitsPerSecond, proxyBitrate(1280, 720, DEFAULT_PROXY_FPS));
  assert.equal(at('480p').bitsPerSecond, proxyBitrate(854, 480, DEFAULT_PROXY_FPS));
  assert.ok(at('480p').bitsPerSecond < at('720p').bitsPerSecond, 'a smaller copy costs fewer bits');
  assert.ok(at('1080p').bitsPerSecond > at('720p').bitsPerSecond, 'and a bigger one costs more');
  assert.equal(at('1080p').worth && at('1080p').bitsPerSecond, proxyBitrate(1920, 1080, DEFAULT_PROXY_FPS));
  assert.equal(proxyPlan({ width: 0, height: 0 }, { id: '480p' }).bitsPerSecond, 0, 'and a picture with no size costs nothing');
});

test('a picture with no usable size has no plan, and says so', () => {
  const plan = proxyPlan(null, { id: '480p' });
  assert.equal(plan.worth, false);
  assert.equal(plan.size, null);
  assert.match(plan.reason, /no size/);
  assert.equal(proxyPlan({ width: 'wide', height: 'tall' }).worth, false);
});

// --------------------------------------------------------------------------- //
// building one without being asked
// --------------------------------------------------------------------------- //

test('a copy is built by itself for any picture bigger than the preview it would replace', () => {
  assert.deepEqual(autoProxyDecision({ width: 3840, height: 2160 }), { build: true });
  assert.deepEqual(autoProxyDecision({ width: 1920, height: 1080 }), { build: true });
});

test('and is left alone when there is a reason to leave it alone, with the reason said out loud', () => {
  const why = (extra) => autoProxyDecision({ width: 3840, height: 2160 }, extra)?.reason ?? '';
  assert.match(autoProxyDecision(undefined).reason, /no picture/);
  assert.match(why({ building: true }), /already being built/);
  assert.match(why({ proxied: true }), /already playing a copy/);
  assert.match(why({ declined: true }), /by hand/, 'the user said "preview the original" about this very file');
  assert.match(why({ supported: false }), /WebCodecs/);
  // A picture the copy would not shrink is not a picture to copy: at the default rung, 1080p is the
  // smallest one that is.
  assert.match(autoProxyDecision({ width: 1280, height: 720 }).reason, /no bigger than a 720p copy/);
  assert.match(autoProxyDecision({ width: 640, height: 360 }).reason, /no bigger than a 720p copy/);
});

test('the automatic decision has no way to touch the export', () => {
  // It takes a picture, a rung and four flags and returns a verdict: there is no URL in it, no file,
  // and no "which picture" — so the rule that the export always encodes the original cannot be broken
  // here.
  assert.deepEqual(Object.keys(autoProxyDecision({ width: 3840, height: 2160 })), ['build']);
});

test('a copy is built by itself only at a rung that would shrink the picture', () => {
  // The pick reaches the automatic path, which is where it has to be honoured: a 1080p master picked
  // at 1080p is played as it is, and the same master at 480p is copied down without being asked.
  const hd = { width: 1920, height: 1080 };
  assert.deepEqual(autoProxyDecision(hd, { id: '720p' }), { build: true });
  assert.deepEqual(autoProxyDecision(hd, { id: '480p' }), { build: true });
  assert.match(autoProxyDecision(hd, { id: '1080p' }).reason, /no bigger than a 1080p copy/);
  const already = { width: 1280, height: 720 };
  assert.deepEqual(autoProxyDecision(already, { id: '480p' }), { build: true }, 'a 720p picture at 480p');
  assert.match(autoProxyDecision(already, { id: '720p' }).reason, /no bigger than/);
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
