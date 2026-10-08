/**
 * preview.test.js — the preview controller, without a browser.
 *
 * `editor/preview.js` is the least self-contained module in Phase 2, so it gets a fake video and a
 * stubbed `requestAnimationFrame`. The stub deliberately does *not* run the loop, which makes the
 * tests deterministic: the clock and the drawing are driven explicitly instead of via rAF timing.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createDemoDocument } from '../../src/model/demo.js';
import { createPreview } from '../../src/editor/preview.js';
import { createFakeCanvas } from '../helpers/fake-canvas.js';

// --- global stubs (no browser here) ---------------------------------------
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
let rafCalls = 0;
globalThis.requestAnimationFrame = () => {
  rafCalls++;
  return rafCalls; // never invokes the callback → the loop stays parked
};
globalThis.cancelAnimationFrame = () => {};

after(() => {
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  else delete globalThis.requestAnimationFrame;
  if (realCaf) globalThis.cancelAnimationFrame = realCaf;
  else delete globalThis.cancelAnimationFrame;
});

/** A stand-in `<video>` with just the surface `preview.js` touches. */
function fakeVideo({ duration = 0, readyState = 1, currentTime = 0 } = {}) {
  return {
    duration,
    readyState,
    currentTime,
    paused: true,
    style: {},
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls++;
      this.paused = true;
    },
  };
}

/** The surface `preview.js` reads is identical for `<audio>`, so the fake is shared. */
const fakeAudio = (opts) => fakeVideo(opts);

function mount({ video = null, audio = null } = {}) {
  const canvas = createFakeCanvas();
  const container = { clientWidth: 1280, clientHeight: 720 };
  const frames = [];
  const preview = createPreview({
    canvas,
    container,
    video,
    audio,
    onFrame: (t, doc) => frames.push({ t, blocks: doc?.blocks.length ?? 0 }),
  });
  return { preview, canvas, ctx: canvas.getContext('2d'), frames, video, audio };
}

test('a canvas is required', () => {
  assert.throws(() => createPreview({}), /a canvas element is required/);
});

test('a document can be shown and is fitted to its container', async () => {
  const { preview, canvas } = mount();
  const doc = createDemoDocument();
  const fonts = await preview.setDocument(doc);

  assert.equal(preview.document, doc);
  assert.equal(fonts.ok, false, 'no Font Loading API in Node — reported, not thrown');
  assert.equal(fonts.results.length, 2);
  // 1280×720 document inside a 1280×720 box → exactly 1:1
  assert.equal(canvas.style.width, '1280px');
  assert.equal(canvas.style.height, '720px');
  assert.equal(preview.renderer.fontsReady, true);
});

test('the clock starts at the first block when there is no video', async () => {
  const { preview } = mount();
  const doc = createDemoDocument();
  await preview.setDocument(doc);
  assert.equal(preview.currentTime(), doc.blocks[0].start);

  preview.seek(19.25);
  assert.equal(preview.currentTime(), 19.25);
  preview.seek(-5);
  assert.equal(preview.currentTime(), 0, 'seeking before zero clamps');
});

test('duration prefers the media, falling back to the document', async () => {
  const noVideo = mount();
  await noVideo.preview.setDocument(createDemoDocument());
  assert.equal(noVideo.preview.duration(), createDemoDocument().blocks.at(-1).end);

  const video = fakeVideo({ duration: 42 });
  const withVideo = mount({ video });
  await withVideo.preview.setDocument(createDemoDocument());
  assert.equal(withVideo.preview.duration(), 42);

  // a video that has not loaded its metadata yet must not win with NaN/0
  const unloaded = fakeVideo({ duration: 0, readyState: 0 });
  const third = mount({ video: unloaded });
  await third.preview.setDocument(createDemoDocument());
  assert.equal(third.preview.duration(), createDemoDocument().blocks.at(-1).end);
});

test('with a ready video the clock follows the element', async () => {
  const video = fakeVideo({ duration: 42, currentTime: 7.5 });
  const { preview } = mount({ video });
  await preview.setDocument(createDemoDocument());
  assert.equal(preview.currentTime(), 7.5);
  preview.seek(12);
  assert.equal(video.currentTime, 12, 'seeking moves the media, not just the clock');
});

test('a video that has not loaded is not seeked', async () => {
  const video = fakeVideo({ duration: 42, readyState: 0, currentTime: 0 });
  const { preview } = mount({ video });
  await preview.setDocument(createDemoDocument());
  preview.seek(12);
  assert.equal(video.currentTime, 0, 'currentTime must not be touched before metadata');
});

test('play/pause drive both the clock and the media', async () => {
  const video = fakeVideo({ duration: 42 });
  const { preview } = mount({ video });
  await preview.setDocument(createDemoDocument());

  assert.equal(preview.playing, false);
  preview.toggle();
  assert.equal(preview.playing, true);
  assert.equal(video.playCalls, 1);
  assert.ok(rafCalls > 0, 'the render loop was started');

  preview.toggle();
  assert.equal(preview.playing, false);
  assert.equal(video.pauseCalls, 1);

  preview.start();
  preview.start(); // idempotent
  assert.equal(video.playCalls, 2);
  preview.pause();
  preview.pause(); // idempotent
  assert.equal(video.pauseCalls, 2);
});

test('renderFrame draws the active block and parks nothing else', async () => {
  const { preview, ctx } = mount();
  const doc = createDemoDocument();
  await preview.setDocument(doc);
  ctx.reset();
  const result = preview.renderFrame(16.5);
  assert.equal(result.blocks, 1);
  assert.deepEqual(ctx.drawnText.map((t) => t.text), ['Just', 'an', 'ordinary', 'boy']);
});

test('onFrame reports the time and the block count each frame', async () => {
  const { preview, frames } = mount();
  await preview.setDocument(createDemoDocument());
  preview.renderFrame(17.9);
  assert.equal(frames.at(-1).blocks, 3);
  assert.equal(frames.at(-1).t, 17.9);
});

test('setDefaults deep-merges so a font change keeps the other font fields', async () => {
  const { preview } = mount();
  await preview.setDocument(createDemoDocument());
  const before = preview.document.defaults;

  await preview.setDefaults({ font: { family: 'Anton' } });
  const after = preview.document.defaults;
  assert.equal(after.font.family, 'Anton');
  assert.equal(after.font.weight, before.font.weight, 'weight survives a family-only patch');
  assert.equal(after.font.size, before.font.size);
  assert.equal(after.wrapWidth, before.wrapWidth, 'untouched fields are untouched');

  await preview.setDefaults({ wrapWidth: 0.4 });
  assert.equal(preview.document.defaults.wrapWidth, 0.4);
  assert.equal(preview.document.defaults.font.family, 'Anton');
});

test('options toggle guides and the video layer', async () => {
  const video = fakeVideo({ duration: 42 });
  const { preview, ctx } = mount({ video });
  await preview.setDocument(createDemoDocument());

  assert.deepEqual(preview.options, { guides: false, safeAreas: false });
  preview.setOptions({ guides: true });
  assert.equal(preview.options.guides, true);

  ctx.reset();
  preview.renderFrame(16.5);
  assert.ok(ctx.ops('stroke').length > 0, 'guides are drawn when enabled');

  preview.setVideoVisible(false);
  assert.equal(video.style.visibility, 'hidden');
  preview.setVideoVisible(true);
  assert.equal(video.style.visibility, 'visible');
});

test('setVideo swaps the media element and applies the current visibility', async () => {
  const { preview } = mount();
  const video = fakeVideo({ duration: 10 });
  preview.setVideo(video);
  assert.equal(video.style.visibility, 'visible', 'video is visible by default');
  preview.setVideoVisible(false);
  const other = fakeVideo({ duration: 10 });
  preview.setVideo(other);
  assert.equal(other.style.visibility, 'hidden', 'visibility carries over');
});

test('audio drives the clock and the duration when there is no ready video', async () => {
  const audio = fakeAudio({ duration: 30, currentTime: 4.5 });
  const { preview } = mount({ audio });
  await preview.setDocument(createDemoDocument());

  assert.equal(preview.currentTime(), 4.5);
  assert.equal(preview.duration(), 30);
  preview.seek(11);
  assert.equal(audio.currentTime, 11, 'seeking moves the audio track');
});

test('an unloaded video yields the clock to the audio', async () => {
  const video = fakeVideo({ duration: 0, readyState: 0 });
  const audio = fakeAudio({ duration: 30, currentTime: 9 });
  const { preview } = mount({ video, audio });
  await preview.setDocument(createDemoDocument());

  assert.equal(preview.currentTime(), 9, 'readyState 0 must not win with a meaningless time');
  assert.equal(preview.duration(), 30);
});

test('duration prefers the video, then the audio, then the document', async () => {
  const both = mount({ video: fakeVideo({ duration: 42 }), audio: fakeAudio({ duration: 30 }) });
  await both.preview.setDocument(createDemoDocument());
  assert.equal(both.preview.duration(), 42);

  const noMedia = mount();
  await noMedia.preview.setDocument(createDemoDocument());
  assert.equal(noMedia.preview.duration(), createDemoDocument().blocks.at(-1).end);
});

test('play, pause and seek drive the audio as well as the video', async () => {
  const video = fakeVideo({ duration: 42 });
  const audio = fakeAudio({ duration: 42 });
  const { preview } = mount({ video, audio });
  await preview.setDocument(createDemoDocument());

  preview.start();
  assert.equal(video.playCalls, 1);
  assert.equal(audio.playCalls, 1, 'the track starts with the picture');

  preview.pause();
  assert.equal(video.pauseCalls, 1);
  assert.equal(audio.pauseCalls, 1);
});

test('each sound source is switched on its own, with a master mute above both', async () => {
  const video = fakeVideo({ duration: 42 });
  const { preview } = mount({ video });
  assert.equal(video.muted, false, 'a video on its own is audible');
  assert.equal(preview.videoAudioEnabled, true);
  assert.equal(preview.playbackAudioEnabled, true);

  const audio = fakeAudio({ duration: 42 });
  preview.setAudio(audio);
  assert.equal(audio.muted, false, 'the master track is audible as soon as it is loaded');
  assert.equal(video.muted, false, 'adding a track no longer takes the choice away');
  assert.equal(preview.audio, audio);

  // What main.js does when a master track arrives: turn the picture's own sound off, so two tracks do
  // not play over each other — but as a switch the user can flip back, not a rule.
  preview.setVideoAudioEnabled(false);
  assert.equal(video.muted, true, "the video's own audio is muted");
  assert.equal(audio.muted, false, 'while the uploaded track still plays');
  assert.equal(preview.videoAudioEnabled, false);

  preview.setPlaybackAudioEnabled(false);
  assert.equal(audio.muted, true);
  assert.equal(preview.playbackAudioEnabled, false);

  // The master mute sits above both and must not rewrite either per-source switch.
  preview.setVideoAudioEnabled(true);
  preview.setPlaybackAudioEnabled(true);
  preview.setMuted(true);
  assert.equal(video.muted, true);
  assert.equal(audio.muted, true);
  assert.equal(preview.muted, true);
  assert.equal(preview.videoAudioEnabled, true, 'master mute is not a per-source switch');
  preview.setMuted(false);
  assert.equal(video.muted, false);
  assert.equal(audio.muted, false);

  preview.setVolume(0.4);
  assert.equal(audio.volume, 0.4);
  assert.equal(video.volume, 0.4);
  assert.equal(preview.volume, 0.4);
  preview.setVolume(5);
  assert.equal(preview.volume, 1, 'volume clamps to [0, 1]');
});

test('mute silences a video-only preview without hiding it', async () => {
  const video = fakeVideo({ duration: 42 });
  const { preview } = mount({ video });
  await preview.setDocument(createDemoDocument());

  preview.setMuted(true);
  assert.equal(video.muted, true);
  assert.notEqual(video.style.visibility, 'hidden', 'mute is not a visibility switch');
});

test('nothing is drawn before a document exists', () => {
  const { preview, ctx } = mount();
  assert.equal(preview.renderFrame(5), null);
  assert.equal(preview.currentTime(), 0);
  assert.equal(preview.duration(), 0);
  assert.equal(ctx.drawnText.length, 0);
});

test('dispose pauses the media and is safe to call twice', async () => {
  const video = fakeVideo({ duration: 42 });
  const { preview } = mount({ video });
  await preview.setDocument(createDemoDocument());
  preview.start();
  preview.dispose();
  assert.equal(video.pauseCalls, 1);
  preview.dispose();
  assert.equal(preview.playing, false);
});

test('an empty document does not throw', async () => {
  const { preview, ctx } = mount();
  await preview.setDocument({ canvas: { width: 1280, height: 720 }, blocks: [], defaults: {} });
  ctx.reset();
  const result = preview.renderFrame(0);
  assert.equal(result.blocks, 0);
  assert.equal(ctx.drawnText.length, 0);
});
