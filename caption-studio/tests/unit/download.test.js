/**
 * download.test.js — the pure half of exporting: file names, caption payloads, codec choice.
 *
 * The recorder itself needs a browser (canvas, `MediaRecorder`, a real video), so it is exercised
 * through the UI smoke run; everything that can be decided without one is decided here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captionFiles, exportStem, pickVideoMime } from '../../src/io/download.js';
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

test('pickVideoMime prefers the best supported codec and defers when none is', () => {
  assert.equal(pickVideoMime((t) => t.startsWith('video/webm;codecs=vp9,opus')), 'video/webm;codecs=vp9,opus');
  assert.equal(pickVideoMime((t) => t === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8');
  assert.equal(pickVideoMime(() => false), '', 'no supported type means "let the browser decide"');
  assert.equal(pickVideoMime(undefined), '');
  assert.equal(
    pickVideoMime((t) => {
      if (t.includes('vp9')) throw new Error('boom');
      return t === 'video/webm;codecs=vp8';
    }),
    'video/webm;codecs=vp8',
    'one refused probe must not abandon the rest',
  );
});
