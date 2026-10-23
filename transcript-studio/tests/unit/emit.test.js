import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACTS,
  DEFAULT_ARTIFACTS,
  artifactFilename,
  artifactNames,
  formatSRTTime,
  formatVTTTime,
  normalizeArtifacts,
  renderSRT,
  renderTXT,
  renderVTT,
  safeStem,
} from '../../src/core/emit.js';

const DOC = {
  duration: 10,
  chunks: [
    { index: 1, start: 0.48, end: 2, text: 'Just an ordinary boy' },
    { index: 2, start: 2, end: 4.125, text: 'Head in the books' },
  ],
};

test('the site\'s second-only export becomes millisecond timestamps here', () => {
  assert.equal(formatSRTTime(0.48), '00:00:00,480');
  assert.equal(formatSRTTime(59.9995), '00:01:00,000');
  assert.equal(formatSRTTime(3723.5), '01:02:03,500');
  assert.equal(formatVTTTime(0.48), '00:00:00.480');
  assert.equal(formatVTTTime(-1), '00:00:00.000');
});

test('SRT has numbered cues, the right separator, and the blank line at the end', () => {
  const srt = renderSRT(DOC);
  assert.equal(
    srt,
    '1\n00:00:00,480 --> 00:00:02,000\nJust an ordinary boy\n\n' +
      '2\n00:00:02,000 --> 00:00:04,125\nHead in the books\n\n',
  );
});

test('a cue with no window or no text is not written', () => {
  const srt = renderSRT({
    chunks: [
      { start: 1, end: 1, text: 'zero length' },
      { start: 1, end: 2, text: '' },
      { start: 2, end: 3, text: 'real' },
    ],
  });
  assert.equal(srt, '1\n00:00:02,000 --> 00:00:03,000\nreal\n\n');
});

test('VTT starts with its header and uses a dot', () => {
  const vtt = renderVTT(DOC);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.match(vtt, /00:00:00\.480 --> 00:00:02\.000/);
  assert.ok(vtt.endsWith('\n'));
  assert.equal(renderVTT({ chunks: [] }), 'WEBVTT\n');
});

test('the text artifact is one line per chunk, which is what a lyric sheet is', () => {
  assert.equal(renderTXT(DOC), 'Just an ordinary boy\nHead in the books\n');
});

test('the registry names every artifact with the extension the suite expects', () => {
  assert.deepEqual(artifactNames(), ['json', 'srt', 'vtt', 'txt', 'speech', 'veed']);
  assert.equal(ARTIFACTS.speech.extension, '.speech.json');
  assert.equal(ARTIFACTS.veed.extension, '.veed.json');
  assert.deepEqual(DEFAULT_ARTIFACTS, ['json', 'srt', 'vtt', 'speech', 'veed']);
  assert.equal(artifactFilename('srt', 'song'), 'song.srt');
  assert.equal(artifactFilename('speech', 'song'), 'song.speech.json');
});

test('artifact selection accepts a list, a comma string, all, and nothing', () => {
  assert.deepEqual(normalizeArtifacts(undefined), [...DEFAULT_ARTIFACTS]);
  assert.deepEqual(normalizeArtifacts('srt, vtt'), ['srt', 'vtt']);
  assert.deepEqual(normalizeArtifacts(['srt', 'srt']), ['srt']);
  assert.deepEqual(normalizeArtifacts('all'), artifactNames());
  assert.throws(() => normalizeArtifacts('srt,docx'), /unknown artifact "docx"/);
});

test('safeStem cannot escape its folder or break a Windows name', () => {
  assert.equal(safeStem('../../notes/attack'), 'attack');
  assert.equal(safeStem('take 2: final?.mp3'), 'take 2_ final_.mp3');
  assert.equal(safeStem('   '), 'transcript');
  assert.equal(safeStem('x'.repeat(120)).length, 80);
  assert.equal(safeStem('..'), 'transcript');
});
