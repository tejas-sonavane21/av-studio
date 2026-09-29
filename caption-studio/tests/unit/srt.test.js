import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSRT, serializeSRT } from '../../src/io/srt.js';

test('parses basic SRT with BOM and CRLF', () => {
  const s = '\uFEFF1\r\n00:00:12,000 --> 00:00:16,000\r\nJust an ordinary boy,\r\n\r\n2\r\n00:00:16,000 --> 00:00:20,000\r\nHello world.\r\n';
  const { cues, warnings } = parseSRT(s);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 12);
  assert.equal(cues[0].end, 16);
  assert.deepEqual(cues[0].lines, ['Just an ordinary boy,']);
  assert.equal(cues[1].start, 16);
  assert.equal(warnings.length, 0);
});

test('strips inline markup and parses hour-less timestamps', () => {
  const s = '00:12.500 --> 00:16.000\n<i>Hello</i> <b>world</b> {\\an8}\n';
  const { cues } = parseSRT(s);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 12.5);
  assert.equal(cues[0].lines[0], 'Hello world');
});

test('round-trips through serialize', () => {
  const blocks = [{ start: 1.5, end: 3.0, text: 'Hi there' }];
  const { cues } = parseSRT(serializeSRT(blocks));
  assert.equal(cues[0].start, 1.5);
  assert.equal(cues[0].end, 3.0);
  assert.deepEqual(cues[0].lines, ['Hi there']);
});

test('warns on a block with no timing line', () => {
  const { cues, warnings } = parseSRT('1\nnot a timing line\nsome text\n');
  assert.equal(cues.length, 0);
  assert.equal(warnings.length, 1);
});
