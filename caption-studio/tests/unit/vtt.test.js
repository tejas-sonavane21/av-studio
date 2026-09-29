import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVTT, serializeVTT } from '../../src/io/vtt.js';

test('parses header, NOTE, cue ids, settings and voice tags', () => {
  const s = `WEBVTT

NOTE this is a note

intro
00:00:01.000 --> 00:00:03.000 align:start position:10%
Hello <v Bob>world</v>

00:00:03.000 --> 00:00:05.000
Second line`;
  const { cues, warnings } = parseVTT(s);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].id, 'intro');
  assert.equal(cues[0].settings, 'align:start position:10%');
  assert.equal(cues[0].lines[0], 'Hello world');
  assert.equal(cues[1].id, null);
  assert.equal(warnings.length, 0);
});

test('serializes with and without word timings', () => {
  const blocks = [{ start: 0, end: 1, text: 'Hi', words: [{ text: 'Hi', start: 0, end: 1 }] }];
  assert.match(serializeVTT(blocks), /^WEBVTT/);
  assert.match(serializeVTT(blocks, { withWordTimings: true }), /<00:00:00\.000>Hi/);
});
