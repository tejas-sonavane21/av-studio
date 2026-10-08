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
  DEFAULT_FORMAT,
  EXPORT_FORMATS,
  frameCount,
  lastCaptionEnd,
  muxerAudioCodec,
  muxerVideoCodec,
  pickAudioCodec,
  pickCodec,
  pickVideoCodec,
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
