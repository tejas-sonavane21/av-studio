/**
 * webcodecs-export.test.js — the pure half of the real export: the container/codec choices and the
 * frame arithmetic.
 *
 * The encoder itself needs a browser (WebCodecs, a canvas, a decodable video), so it is exercised
 * through the UI smoke run. Everything that decides *what* to ask the browser for is decided here,
 * without one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_BITRATE_LADDER,
  DEFAULT_FORMAT,
  EXPORT_FORMATS,
  evenSize,
  frameCount,
  lastCaptionEnd,
  mapAudioToRanges,
  muxerAudioCodec,
  muxerVideoCodec,
  pickAudioCodec,
  pickCodec,
  pickVideoCodec,
  rangeWindows,
  resolutionFor,
  resolveAudioBitrate,
} from '../../src/io/webcodecs-export.js';

test('pickCodec takes the first candidate the browser accepts', () => {
  assert.equal(pickCodec(['a', 'b', 'c'], () => true), 'a');
  assert.equal(pickCodec(['a', 'b', 'c'], (x) => x === 'b'), 'b');
  assert.equal(pickCodec(['a', 'b'], () => false), '');
  assert.equal(pickCodec([], () => true), '');
  assert.equal(pickCodec(undefined, () => true), '');
  assert.equal(pickCodec(['a'], undefined), '', 'no probe means no candidate is known to work');
  // A probe that throws for one candidate must not abandon the rest.
  assert.equal(
    pickCodec(['bad', 'good'], (x) => {
      if (x === 'bad') throw new Error('boom');
      return true;
    }),
    'good',
  );
});

test('the video codec follows the container, and falls back within it', () => {
  assert.equal(pickVideoCodec('mp4', () => true), 'avc1.640028', 'H.264 High is the first choice');
  assert.equal(pickVideoCodec('webm', () => true), 'vp09.00.10.08', 'VP9 for WebM');
  assert.equal(pickVideoCodec('mp4', (c) => c === 'avc1.42001f'), 'avc1.42001f', 'Baseline as a last resort');
  assert.equal(pickVideoCodec('webm', (c) => c === 'vp8'), 'vp8', 'VP8 is the floor');
  assert.equal(pickVideoCodec('mp4', () => false), '', 'no encoder means no export, not a wrong one');
  assert.equal(pickVideoCodec('anything-else', () => true), 'avc1.640028', 'an unknown format is MP4');
});

test('the audio codec follows the container', () => {
  assert.equal(pickAudioCodec('mp4', () => true), 'mp4a.40.2', 'AAC is what an MP4 needs');
  assert.equal(pickAudioCodec('webm', () => true), 'opus');
  assert.equal(pickAudioCodec('webm', () => false), '');
});

test('the muxer names a codec by its container id', () => {
  assert.equal(muxerVideoCodec('mp4', 'avc1.640028'), 'avc');
  assert.equal(muxerVideoCodec('webm', 'vp09.00.10.08'), 'V_VP9');
  assert.equal(muxerVideoCodec('webm', 'vp8'), 'V_VP8');
  assert.equal(muxerAudioCodec('mp4', 'mp4a.40.2'), 'aac');
  assert.equal(muxerAudioCodec('webm', 'opus'), 'A_OPUS');
});

test('frameCount is the document length at the chosen rate, and never zero', () => {
  assert.equal(frameCount(1.2, 30), 36);
  assert.equal(frameCount(60, 30), 1800);
  assert.equal(frameCount(3, 0), 90, 'a nonsense rate falls back to 30');
  assert.equal(frameCount(0, 30), 1, 'an empty document still gets one frame, not an empty file');
  assert.equal(frameCount(NaN, 30), 1);
  assert.equal(frameCount(5, 30.4), 150);
});

// ---------------------------------------------------------------------------
// how the frames are walked: the reason a 4K export stopped costing 1448 ms a frame
// ---------------------------------------------------------------------------
//
// The picture is decoded **in order**, one pass per kept range, instead of being seeked once per
// output frame. That means the export's frame list has to be divided among the ranges, and the one
// thing that must never happen is a frame that no range claims (a hole in the file) or that two
// ranges claim (a frame written twice). These are the arithmetic of that division.

test('the frames are divided among the kept ranges in order, with none lost or repeated', () => {
  const ranges = [
    { id: 'a', srcIn: 0, srcOut: 1 },
    { id: 'b', srcIn: 2, srcOut: 3 },
  ];
  const windows = rangeWindows(ranges, 30, 60);
  assert.deepEqual(
    windows.map((w) => [w.range.id, w.startIndex, w.count]),
    [
      ['a', 0, 30],
      ['b', 30, 30],
    ],
  );
  assert.equal(
    windows.reduce((sum, w) => sum + w.count, 0),
    60,
    'every output frame belongs to exactly one range',
  );
});

test('rounding goes to the last range, so the file is exactly as long as it was asked to be', () => {
  // 1.5 s + 1.5 s at 30 fps is 45 + 45 = 90 frames, but 0.98 s rounds down — the total still has to
  // come out at `frameCount(seconds, rate)`, or the export's own frame counter disagrees with itself.
  const ranges = [
    { id: 'a', srcIn: 0, srcOut: 0.98 },
    { id: 'b', srcIn: 5, srcOut: 6.5 },
  ];
  const windows = rangeWindows(ranges, 30, 74);
  assert.equal(windows[0].count, 29, '0.98 s is 29 frames, not 30');
  assert.equal(
    windows.reduce((sum, w) => sum + w.count, 0),
    74,
    'the leftover frames go to the last range rather than disappearing',
  );
  assert.equal(windows[1].startIndex, 29, 'and the second run starts where the first stopped');
});

test('a range too short for a single frame is skipped, and the frames it would have had are not', () => {
  const ranges = [
    { id: 'tiny', srcIn: 0, srcOut: 0.01 },
    { id: 'real', srcIn: 1, srcOut: 2 },
  ];
  const windows = rangeWindows(ranges, 30, 30);
  assert.deepEqual(windows.map((w) => w.range.id), ['real']);
  assert.equal(windows[0].count, 30);
});

test('a total of zero frames, or no ranges at all, is an empty walk rather than a crash', () => {
  assert.deepEqual(rangeWindows([{ id: 'a', srcIn: 0, srcOut: 1 }], 30, 0), []);
  assert.deepEqual(rangeWindows([], 30, 90), []);
  assert.deepEqual(rangeWindows(null, 30, 90), []);
  assert.deepEqual(rangeWindows([{ id: 'a', srcIn: 5, srcOut: 5 }], 30, 30), []);
});

test('lastCaptionEnd is the document clock when the container will not report one', () => {
  assert.equal(lastCaptionEnd({ blocks: [{ end: 1 }, { end: 3.5 }, { end: null }, { end: 2 }] }), 3.5);
  assert.equal(lastCaptionEnd({ blocks: [] }), 0);
  assert.equal(lastCaptionEnd(null), 0);
});

test('the two containers are described in one place, with MP4 the default', () => {
  assert.equal(DEFAULT_FORMAT, 'mp4');
  assert.deepEqual(Object.keys(EXPORT_FORMATS), ['mp4', 'webm']);
  assert.equal(EXPORT_FORMATS.mp4.ext, 'mp4');
  assert.equal(EXPORT_FORMATS.mp4.mime, 'video/mp4');
  assert.equal(EXPORT_FORMATS.webm.mime, 'video/webm');
});

// ---------------------------------------------------------------------------
// the audio bitrate search — the bug where "best" came out silent
// ---------------------------------------------------------------------------

/** The window this Chrome actually offers for AAC: 96 kbps up to 192 kbps, and nothing else. */
const aacWindow = (rate) => rate >= 96000 && rate <= 192000;

test('a refused audio bitrate is retried rather than turned into a silent track', async () => {
  // 256 kbps ("best") is refused here; 192 ("high") is accepted. The old code took the refusal as
  // "this browser cannot encode AAC" and dropped the sound entirely.
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 256000), 192000);
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 320000), 192000);
});

test('the search never upgrades a lower preference into a bigger file', async () => {
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 128000), 128000);
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 160000), 160000);
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 192000), 192000);
  // A preference below the window is lifted to the floor, which is the smallest thing that works.
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 64000), 96000);
  assert.equal(await resolveAudioBitrate(async (r) => aacWindow(r), 16000), 96000);
});

test('with nothing acceptable it reports failure rather than guessing', async () => {
  assert.equal(await resolveAudioBitrate(async () => false, 192000), 0);
  assert.equal(await resolveAudioBitrate(async () => { throw new Error('boom'); }, 192000), 0);
});

test('a probe that throws for one rate still tries the rest', async () => {
  const choosy = async (rate) => {
    if (rate === 192000) throw new Error('nope');
    return rate === 128000;
  };
  assert.equal(await resolveAudioBitrate(choosy, 192000), 128000);
});

test('every rate the ladder tries is a real one, and a preference it lacks is still tried', async () => {
  const asked = [];
  await resolveAudioBitrate(async (r) => {
    asked.push(r);
    return false;
  }, 111000);
  assert.equal(asked[0], 111000, 'the caller\u2019s own rate is offered first');
  assert.ok(asked.some((r) => AUDIO_BITRATE_LADDER.includes(r)), 'and the standard rates follow');
  assert.equal(new Set(asked).size, asked.length, 'no rate is asked about twice');
});

// ---------------------------------------------------------------------------
// the output size
// ---------------------------------------------------------------------------

test('evenSize rounds up so a codec never sees an odd width', () => {
  assert.deepEqual(evenSize(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(evenSize(1921, 1081), { width: 1922, height: 1082 });
  assert.deepEqual(evenSize(0, -4), { width: 2, height: 2 }, 'a nonsense size still encodes');
});

test('a resolution preset names the short edge, whatever the frame shape', () => {
  assert.deepEqual(resolutionFor(1080, 16 / 9), { width: 1920, height: 1080 });
  assert.deepEqual(resolutionFor(720, 16 / 9), { width: 1280, height: 720 });
  assert.deepEqual(resolutionFor(2160, 16 / 9), { width: 3840, height: 2160 }, '4K landscape');
  assert.deepEqual(resolutionFor(1080, 9 / 16), { width: 1080, height: 1920 }, 'the same preset, portrait');
  assert.deepEqual(resolutionFor(1080, 1), { width: 1080, height: 1080 }, 'square');
  assert.deepEqual(resolutionFor(1080, 21 / 9), { width: 2520, height: 1080 }, 'cinemascope');
  assert.deepEqual(resolutionFor(1080, 4 / 5), { width: 1080, height: 1350 }, 'and Instagram\u2019s own 4:5 delivery size');
});

test('resolutionFor will not mint a frame bigger than any camera makes', () => {
  const huge = resolutionFor(999999, 21 / 9);
  assert.ok(huge.width <= 7680 && huge.height <= 4320);
});

// ---------------------------------------------------------------------------
// the sound, laid out along the cuts
// ---------------------------------------------------------------------------

/** A four-samples-a-second mono source, so the mapping arithmetic is readable. */
const tone = () => ({
  numberOfChannels: 1,
  getChannelData: () => new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
});

test('audio from a cut source is laid out along the kept ranges and stays in step', () => {
  // keeps [0s, 1s) and [1.5s, 2s) — half a second cut out of the middle
  const ranges = [
    { id: 'a', srcIn: 0, srcOut: 1 },
    { id: 'b', srcIn: 1.5, srcOut: 2 },
  ];
  const [left, right] = mapAudioToRanges(tone(), ranges, 4, 6, 2);
  assert.deepEqual([...left], [0, 1, 2, 3, 6, 7], 'the removed half-second is not copied');
  assert.deepEqual([...right], [...left], 'a mono source is heard on both sides');
});

test('a track shorter than the picture leaves silence rather than garbage', () => {
  const ranges = [{ id: 'a', srcIn: 0, srcOut: 1 }];
  const [left] = mapAudioToRanges(tone(), ranges, 4, 8, 2);
  assert.deepEqual([...left], [0, 1, 2, 3, 0, 0, 0, 0]);
});

test('an empty cut list produces silence of the requested length', () => {
  const [left] = mapAudioToRanges(tone(), [], 4, 5, 2);
  assert.equal(left.length, 5);
  assert.ok(left.every((v) => v === 0));
});
