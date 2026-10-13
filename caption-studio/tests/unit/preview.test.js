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
import { ensureTimeline, setTrackRanges } from '../../src/model/timeline.js';
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
function fakeVideo({ duration = 0, readyState = 1, currentTime = 0, ended = false } = {}) {
  return {
    duration,
    readyState,
    currentTime,
    ended,
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

/**
 * Run the render loop for a bounded number of frames.
 *
 * The module-level stub deliberately parks the loop, which is what makes the other tests
 * deterministic. This one needs the loop to actually *run*, so it takes the frames off `start()` and
 * runs them itself — and it queues for a reason: `start()` schedules the first pass *before* it hands
 * the media its `play()`, so a frame that ran inside that call would see a paused element and
 * correctly do nothing. Running the queued frames after `start()` has returned makes every pass one
 * where the transport is genuinely playing, which is the state under test.
 */
function runLoop(preview, frames = 1) {
  const parked = globalThis.requestAnimationFrame;
  const queued = [];
  globalThis.requestAnimationFrame = (callback) => queued.push(callback);
  try {
    preview.start();
    for (let i = 0; i < frames && queued.length; i++) queued.shift()();
  } finally {
    globalThis.requestAnimationFrame = parked;
  }
}

/** A document that keeps only `ranges` of a `duration`-second picture. */
async function mountWithCut(video, duration, ranges) {
  const mounted = mount({ video });
  const doc = createDemoDocument();
  await mounted.preview.setDocument(doc);
  ensureTimeline(doc, { video: duration, audio: 0 });
  setTrackRanges(doc, 'video', ranges);
  return { ...mounted, doc };
}

// The bug this exists for: a media element plays its own whole file and knows nothing about the cut,
// so "Cut right" at 2 s of a 5 s clip left the preview running happily through the 3 s that had just
// been dropped. The element cannot notice that; only the preview can.
test('playback stops at the last frame the cut kept instead of running into material it dropped', async () => {
  const video = fakeVideo({ duration: 5, currentTime: 2.5 });
  const { preview } = await mountWithCut(video, 5, [{ id: 'keep', srcIn: 0, srcOut: 2 }]);

  runLoop(preview);

  assert.equal(preview.playing, false, 'the transport stopped rather than sailing past the cut');
  assert.equal(video.paused, true);
  // Parked past the end of its kept material, the element is never started at all: `play()` on a
  // picture with nothing left to show is what used to run the preview through the dropped seconds.
  assert.equal(video.playCalls, 0);
});

// The same cut, reached *while playing*, which is the case a person actually sees. Here the element is
// mid-file and has to be stopped on the spot — it knows nothing about the cut and would otherwise carry
// on into the removed seconds until the next pass around the loop.
test('a picture that reaches the end of its kept material is paused where it stands', async () => {
  const video = fakeVideo({ duration: 5, currentTime: 2.5 });
  video.paused = false; // already decoding when the frame is drawn
  const { preview } = await mountWithCut(video, 5, [{ id: 'keep', srcIn: 0, srcOut: 2 }]);

  runLoop(preview);

  assert.ok(video.pauseCalls >= 1, 'the decoder was stopped, not left decoding frames the cut removed');
  assert.equal(preview.playing, false, 'and the transport stopped with it — no other lane has material');
});

test('playback jumps a region the cut removed rather than playing it', async () => {
  const video = fakeVideo({ duration: 5, currentTime: 1.4 });
  const { preview } = await mountWithCut(video, 5, [
    { id: 'a', srcIn: 0, srcOut: 1 },
    { id: 'b', srcIn: 3, srcOut: 5 },
  ]);

  runLoop(preview);

  assert.equal(video.currentTime, 3, 'the removed second was skipped, not shown');
  assert.equal(preview.playing, true, 'and the programme carries on');
});

test('a frame that is still kept is left alone — the decoder is not seeked every frame', async () => {
  const video = fakeVideo({ duration: 5, currentTime: 1.5 });
  const { preview } = await mountWithCut(video, 5, [
    { id: 'a', srcIn: 0, srcOut: 2 },
    { id: 'b', srcIn: 3, srcOut: 5 },
  ]);

  runLoop(preview);

  assert.equal(video.currentTime, 1.5);
  assert.equal(preview.playing, true);
});

// Seeking is the other half: parking the playhead on a frame the file does not contain would show a
// caption over a picture that is not there. Forward to the next kept frame — or back onto the last one
// when the picture has run out, rather than resuming inside the seconds that were cut.
test('a seek into removed material lands on a frame that still exists', async () => {
  const video = fakeVideo({ duration: 5, currentTime: 0 });
  const { preview } = await mountWithCut(video, 5, [
    { id: 'a', srcIn: 0, srcOut: 1 },
    { id: 'b', srcIn: 3, srcOut: 5 },
  ]);

  preview.seek(1.5);
  assert.equal(video.currentTime, 3, 'forward, into the gap');

  const tail = fakeVideo({ duration: 5, currentTime: 0 });
  const trimmed = await mountWithCut(tail, 5, [{ id: 'keep', srcIn: 0, srcOut: 2 }]);
  trimmed.preview.seek(4);
  assert.ok(
    tail.currentTime < 2 && tail.currentTime > 1.9,
    `a seek past the cut parks on the last kept frame, got ${tail.currentTime}`,
  );
});

// --------------------------------------------------------------------------- //
// a picture shorter than the track
// --------------------------------------------------------------------------- //

/** A picture that has run out, and a track that has not. */
function exhaustedPicture({ picture = 5, track = 30, trackTime = 12.5 } = {}) {
  const video = fakeVideo({ duration: picture, currentTime: picture, ended: true });
  const audio = fakeAudio({ duration: track, currentTime: trackTime });
  return { video, audio, mounted: mount({ video, audio }) };
}

// The bug this exists for: a 161 s music video under a 182 s master. The picture reached its end,
// froze its `currentTime` at its own duration, and the preview followed *it* — so the transport
// stopped and the track was dragged back to the picture's last frame on every single frame, which is
// heard as the audio collapsing. The programme is its longest part; the track takes the clock over.
test('the track carries the clock once the picture has run out', async () => {
  const { video, audio, mounted } = exhaustedPicture();
  await mounted.preview.setDocument(createDemoDocument());

  assert.equal(mounted.preview.currentTime(), 12.5, 'the clock is the track');
  assert.equal(mounted.preview.duration(), 30, 'and the programme is as long as the track');

  runLoop(mounted.preview);
  assert.equal(audio.currentTime, 12.5, 'the track was not seeked back to the frozen picture');
  assert.notEqual(video.currentTime, 5 + 0.5, 'nothing moved the picture either');
  assert.equal(audio.pauseCalls, 0);
  assert.equal(mounted.preview.playing, true, 'and the programme is still running');
});

// "Continue with a blank screen" — the alternative is a still frame, which reads as a stuck video
// rather than a finished one.
test('the picture layer goes blank rather than freezing on its last frame', async () => {
  const { video, mounted } = exhaustedPicture();
  await mounted.preview.setDocument(createDemoDocument());
  // Unset is "visible" for an element nothing has styled; only the blanking writes the property.
  assert.notEqual(video.style.visibility, 'hidden', 'shown before the transport runs');

  runLoop(mounted.preview);
  assert.equal(video.style.visibility, 'hidden', 'the picture has nothing left to show');
});

// ...and seeking back inside the picture brings it straight back, because "there is nothing to show
// here" is a statement about where the playhead is.
test('seeking back inside the picture brings it back', async () => {
  const { video, audio, mounted } = exhaustedPicture();
  await mounted.preview.setDocument(createDemoDocument());
  runLoop(mounted.preview);
  assert.equal(video.style.visibility, 'hidden');

  video.ended = false;
  video.currentTime = 3;
  audio.currentTime = 3;
  mounted.preview.seek(3);
  await mounted.preview.setDocument(mounted.preview.document);
  assert.equal(video.style.visibility, 'visible');
});

// A picture that is still the longest thing has nothing to blank: it is the programme.
test('a picture at least as long as the track is never blanked', async () => {
  const video = fakeVideo({ duration: 30, currentTime: 30, ended: true });
  const audio = fakeAudio({ duration: 30, currentTime: 30, ended: true });
  const mounted = mount({ video, audio });
  await mounted.preview.setDocument(createDemoDocument());

  runLoop(mounted.preview);

  assert.equal(mounted.preview.duration(), 30);
  assert.notEqual(video.style.visibility, 'hidden', 'the picture is still the programme, so it stays');
});

// The cut is measured against each track's *own* recording, so the lengths have to be readable.
test('each track reports its own length', async () => {
  const { mounted } = exhaustedPicture({ picture: 5, track: 30 });
  assert.equal(mounted.preview.trackDuration('video'), 5);
  assert.equal(mounted.preview.trackDuration('audio'), 30);
  assert.equal(mount().preview.trackDuration('audio'), 0, 'nothing loaded is 0, not NaN');
});

test('an empty document does not throw', async () => {
  const { preview, ctx } = mount();
  await preview.setDocument({ canvas: { width: 1280, height: 720 }, blocks: [], defaults: {} });
  ctx.reset();
  const result = preview.renderFrame(0);
  assert.equal(result.blocks, 0);
  assert.equal(ctx.drawnText.length, 0);
});
