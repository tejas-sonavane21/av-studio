/**
 * download.test.js — the pure half of the caption files and the bitrate arithmetic.
 *
 * The encoder itself needs a browser (canvas, WebCodecs, a real video), so it is exercised through
 * the UI smoke run; everything that can be decided without one is decided here — and the codec
 * choices that used to live with the recorder now live in `webcodecs-export.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUALITY,
  MAX_VIDEO_BITRATE,
  MIN_VIDEO_BITRATE,
  QUALITY_PRESETS,
  audioBitrate,
  captionFiles,
  exportStem,
  videoBitrate,
} from '../../src/io/download.js';
import { createBlock, createDocument, createWord } from '../../src/model/schema.js';
import { rebuildBlockText } from '../../src/model/document.js';
import { parseSRT } from '../../src/io/srt.js';
import { parseVTT } from '../../src/io/vtt.js';
import { importJSON } from '../../src/io/project-file.js';

function makeDoc() {
  return createDocument({
    name: 'The Crimson Burden.mp3',
    blocks: [
      rebuildBlockText(createBlock(0, 2, [createWord('Just', 0, 0.5), createWord('words', 0.5, 1.5)])),
      rebuildBlockText(createBlock(2, 4, [createWord('More', 2, 3), createWord('words', 3, 4)])),
    ],
  });
}

test('exportStem strips the extension and anything a file name cannot carry', () => {
  assert.equal(exportStem({ name: 'The Crimson Burden.mp3' }), 'The Crimson Burden');
  assert.equal(exportStem({ name: 'a/b:c*d' }), 'a_b_c_d');
  assert.equal(exportStem({ name: '' }), 'captions');
  assert.equal(exportStem(null), 'captions');
  assert.equal(exportStem({}, 'song'), 'song');
});

test('captionFiles writes the four shapes a document can take', () => {
  const doc = makeDoc();
  const files = captionFiles(doc);
  assert.deepEqual(
    files.map((f) => f.name),
    ['The Crimson Burden.caproj', 'The Crimson Burden.veed.json', 'The Crimson Burden.srt', 'The Crimson Burden.vtt'],
  );
  for (const file of files) assert.ok(file.text.length > 0, `${file.name} must not be empty`);

  // each one is readable by the importer/parser on the other side of the round trip
  const srt = parseSRT(files[2].text);
  assert.equal(srt.cues.length, 2);
  assert.equal(srt.cues[0].lines[0], 'Just words');

  const vtt = parseVTT(files[3].text);
  assert.equal(vtt.cues.length, 2);
  assert.ok(files[3].text.startsWith('WEBVTT'));

  const veed = JSON.parse(files[1].text);
  assert.equal(veed.subtitles.length, 2);
  assert.equal(veed.canvas.width, doc.canvas.width);

  const back = importJSON(files[0].text);
  assert.equal(back.kind, 'caption-studio');
  assert.equal(back.document.blocks.length, 2);
  assert.equal(back.document.blocks[0].text, 'Just words');
});

test('captionFiles takes an explicit stem and can drop word timings', () => {
  const files = captionFiles(makeDoc(), { stem: 'song', withWordTimings: false });
  assert.equal(files[2].name, 'song.srt');
  const vtt = parseVTT(files[3].text);
  assert.equal(vtt.cues[0].lines[0], 'Just words', 'no inline word timings when not asked for');
});

test('the bitrate scales with the frame, not with a flat number', () => {
  const hd = videoBitrate({ width: 1920, height: 1080, fps: 30 });
  const sd = videoBitrate({ width: 1280, height: 720, fps: 30 });
  // 1920×1080×30×0.13 = 8.08 Mbps — several times the browser's own default for VP9 at this size,
  // which is the whole reason the number is set explicitly
  assert.equal(hd, Math.round(1920 * 1080 * 30 * QUALITY_PRESETS.high.bpp));
  assert.ok(hd > 7e6 && hd < 9e6, `a sensible 1080p figure, got ${hd}`);
  assert.ok(sd < hd, 'a smaller frame gets a smaller budget');
  // 2.25× the pixels is 2.25× the bits — that is what "per pixel" means. (Both are well above the
  // floor, so the clamp does not blur the comparison.)
  assert.ok(Math.abs(hd / sd - 2.25) < 0.01, `${hd} / ${sd}`);
});

test('a lower quality preset really does mean fewer bits, and best is the largest', () => {
  const at = (quality) => videoBitrate({ width: 1920, height: 1080, fps: 30, quality });
  assert.ok(at('balanced') < at('high'));
  assert.ok(at('high') < at('best'));
  assert.equal(audioBitrate('balanced'), QUALITY_PRESETS.balanced.audio);
  assert.ok(audioBitrate('balanced') < audioBitrate('best'), 'and the sound follows it');
});

test('the bitrate is clamped, so no setting can produce a 1 kbps or a 1 Gbps export', () => {
  assert.equal(videoBitrate({ width: 16, height: 9, fps: 24 }), MIN_VIDEO_BITRATE);
  assert.equal(videoBitrate({ width: 7680, height: 4320, fps: 60, quality: 'best' }), MAX_VIDEO_BITRATE);
});

test('an unknown or missing quality falls back to the default, not to zero', () => {
  const expected = videoBitrate({ width: 1280, height: 720, fps: 30, quality: DEFAULT_QUALITY });
  assert.equal(videoBitrate({ width: 1280, height: 720, fps: 30, quality: 'nonsense' }), expected);
  assert.equal(videoBitrate({ width: 1280, height: 720, fps: 30 }), expected);
  assert.equal(videoBitrate({}), MIN_VIDEO_BITRATE, 'a frame with no size is not a NaN');
  assert.equal(videoBitrate(), MIN_VIDEO_BITRATE);
  assert.equal(audioBitrate('nonsense'), QUALITY_PRESETS[DEFAULT_QUALITY].audio);
  assert.equal(videoBitrate({ width: 1280, height: 720, fps: 0 }), videoBitrate({ width: 1280, height: 720, fps: 30 }));
});
