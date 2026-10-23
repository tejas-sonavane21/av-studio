import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContractError,
  LIMITS,
  checkDuration,
  checkFile,
  checkLanguage,
  cleanText,
  parseResponse,
  wordsOf,
} from '../../src/core/contract.js';

test('a normal mp3 passes the file check', () => {
  assert.deepEqual(checkFile({ name: 'song.mp3', size: 4_200_000 }), { extension: '.mp3', size: 4_200_000 });
  assert.equal(checkFile({ name: 'UPPER.WAV', size: 10 }).extension, '.wav');
});

test('the wrong extension is refused, in the service\'s own terms', () => {
  assert.throws(() => checkFile({ name: 'song.ogg', size: 10 }), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, 'extension');
    assert.match(error.message, /MP3, WAV or FLAC/);
    return true;
  });
});

test('the 25 MB ceiling is the service\'s, not a guess', () => {
  assert.equal(LIMITS.maxBytes, 25 * 1024 * 1024);
  assert.throws(() => checkFile({ name: 'song.mp3', size: LIMITS.maxBytes + 1 }), /25 MB/);
  assert.doesNotThrow(() => checkFile({ name: 'song.mp3', size: LIMITS.maxBytes }));
});

test('an empty or unreadable file is refused before the browser opens', () => {
  assert.throws(() => checkFile({ name: 'song.mp3', size: 0 }), /empty/);
  assert.throws(() => checkFile({ name: 'song.mp3' }), /size/);
  assert.throws(() => checkFile({}), /no audio file/);
});

test('duration uses the page\'s 1 s - 5 min window', () => {
  assert.equal(checkDuration(182.5), 182.5);
  assert.throws(() => checkDuration(0.4), /shorter than 1 second/);
  assert.throws(() => checkDuration(301), /at most 5 minutes/);
  assert.throws(() => checkDuration(Number.NaN), /could not read the duration/);
});

test('language is one of the codes the page offers', () => {
  assert.equal(checkLanguage('EN'), 'en');
  assert.equal(checkLanguage(''), 'auto');
  assert.equal(checkLanguage(undefined), 'auto');
  assert.throws(() => checkLanguage('klingon'), /expected one of/);
});

test('the music-note decorations never reach the words', () => {
  assert.equal(cleanText(' 🎵 Just an ordinary boy, lost in the crowd 🎵'), 'Just an ordinary boy, lost in the crowd');
  assert.equal(cleanText('🎵 🎵'), '');
  assert.equal(cleanText('🎵 Head in the books 🎶'), 'Head in the books');
  assert.equal(cleanText('a\u00a0  b'), 'a b');
});

test('parseResponse keeps the words, drops the decorations, and counts what it dropped', () => {
  const parsed = parseResponse({
    success: true,
    predictionId: 'p1',
    chunks: [
      { text: ' 🎵', timestamp: [0, 0.48] },
      { text: ' 🎵 Just an ordinary boy 🎵', timestamp: [0.48, 19.22] },
      { text: '  ', timestamp: [19.22, 22.92] },
    ],
    text: 'ignored',
  });

  assert.equal(parsed.chunks.length, 1);
  assert.deepEqual(parsed.chunks[0], { start: 0.48, end: 19.22, text: 'Just an ordinary boy' });
  assert.equal(parsed.text, 'Just an ordinary boy');
  assert.equal(parsed.predictionId, 'p1');
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /decorations/);
});

test('chunks are sorted, and the sort is reported', () => {
  const parsed = parseResponse({
    chunks: [
      { text: 'second', timestamp: [5, 6] },
      { text: 'first', timestamp: [1, 2] },
    ],
  });
  assert.deepEqual(parsed.chunks.map((chunk) => chunk.text), ['first', 'second']);
  assert.ok(parsed.warnings.some((warning) => /out of order/.test(warning)));
});

test('a chunk with no usable timestamp is dropped and counted', () => {
  const parsed = parseResponse({
    chunks: [
      { text: 'good', timestamp: [1, 2] },
      { text: 'bad', timestamp: ['x', 4] },
      { text: 'also bad', timestamp: [5] },
    ],
  });
  assert.equal(parsed.chunks.length, 1);
  assert.ok(parsed.warnings.some((warning) => /no usable timestamp/.test(warning)));
});

test('a refusal from the service is an error, not an empty transcript', () => {
  assert.throws(() => parseResponse({ success: false, error: 'File too large' }), /File too large/);
  assert.throws(() => parseResponse({ success: true }), /no chunks/);
  assert.throws(() => parseResponse(null), /not JSON/);
  assert.throws(() => parseResponse({ chunks: [] }), /no usable chunks/);
});

test('wordsOf keeps punctuation on the word it belongs to', () => {
  assert.deepEqual(wordsOf("  I'm   the  strongest, "), ["I'm", 'the', 'strongest,']);
  assert.deepEqual(wordsOf(''), []);
});
