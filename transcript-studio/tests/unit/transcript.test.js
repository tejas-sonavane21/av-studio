import test from 'node:test';
import assert from 'node:assert/strict';

import { MIN_CUE_SECONDS } from '../../src/core/contract.js';
import {
  apportionWords,
  buildTranscript,
  repairChunks,
  roundTime,
  toAudioStudioTranscript,
  toVeedMaster,
} from '../../src/core/transcript.js';

const CHUNKS = [
  { start: 0.48, end: 3.0, text: 'Just an ordinary boy' },
  { start: 3.0, end: 6.5, text: 'Head in the books' },
];

function doc(overrides = {}) {
  return buildTranscript({
    chunks: CHUNKS,
    duration: 10,
    source: { name: 'song.mp3', bytes: 100, sha256: 'abc' },
    provider: { language: 'auto', predictionId: 'p1' },
    fetchedAt: '2026-10-23T00:00:00.000Z',
    ...overrides,
  });
}

test('chunks are sorted, and the native document records what it got', () => {
  const built = buildTranscript({
    chunks: [
      { start: 5, end: 6, text: 'second' },
      { start: 1, end: 2, text: 'first' },
    ],
    duration: 10,
    fetchedAt: 'fixed',
  });
  assert.deepEqual(built.chunks.map((chunk) => chunk.text), ['first', 'second']);
  assert.equal(built.text, 'first second');
  assert.deepEqual(built.chunks[0], { index: 1, start: 1, end: 2, text: 'first' });
  assert.equal(built.provider.language, 'auto');
});

test('a zero-length chunk is widened to a playable cue and reported', () => {
  const repaired = repairChunks([{ start: 4, end: 4, text: 'Leave it to me' }], { duration: 10 });
  assert.equal(repaired.chunks[0].end, 4 + MIN_CUE_SECONDS);
  assert.match(repaired.warnings[0], /zero-length/);
});

test('a widened chunk never runs into the next one', () => {
  const repaired = repairChunks(
    [
      { start: 4, end: 4, text: 'first' },
      { start: 4.02, end: 6, text: 'second' },
    ],
    { duration: 10 },
  );
  assert.ok(repaired.chunks[0].end <= repaired.chunks[1].start + 1e-9);
});

test('a chunk past the end of the recording is clamped and reported', () => {
  const repaired = repairChunks([{ start: 9, end: 10.8, text: 'tail' }], { duration: 10 });
  assert.equal(repaired.chunks[0].end, 10);
  assert.match(repaired.warnings.join(' '), /past the recording/);
});

test('the document text is rebuilt from chunks, not taken from the reply', () => {
  const built = doc();
  assert.equal(built.text, 'Just an ordinary boy Head in the books');
  assert.equal(built.stats.chunks, 2);
  assert.equal(built.stats.words, 8);
  assert.equal(built.stats.speechDuration, 6.02);
});

test('word windows tile the line: contiguous, monotonic, and inside it', () => {
  const words = apportionWords({ start: 1, end: 4, text: 'one two three' });
  assert.deepEqual(words.map((word) => word.text), ['one', 'two', 'three']);
  assert.equal(words[0].start, 1);
  assert.equal(words.at(-1).end, 4);
  for (let index = 1; index < words.length; index++) {
    assert.equal(words[index].start, words[index - 1].end);
    assert.ok(words[index].end > words[index].start);
  }
});

test('a short line still gives every word a non-empty window', () => {
  const words = apportionWords({ start: 0, end: 0.04, text: 'a b c d e' });
  assert.equal(words.length, 5);
  for (const word of words) assert.ok(word.end > word.start, `${word.text} has no window`);
  assert.ok(words.at(-1).end <= 0.04 + 1e-9);
});

test('the audio-studio adapter says out loud that its word timings are interpolated', () => {
  const transcript = toAudioStudioTranscript(doc());
  assert.equal(transcript.alignment.aligner, 'proportional');
  assert.equal(transcript.alignment.interpolated, true);
  assert.match(transcript.alignment.note, /line-level/);
  assert.equal(transcript.segments.length, 2);
  assert.equal(transcript.segments[0].text, 'Just an ordinary boy');
  assert.equal(transcript.segments[0].text, transcript.segments[0].words.map((word) => word.text).join(' '));
  assert.equal(transcript.segments[0].words[0].start, 0.48);
  assert.equal(transcript.segments[0].words.at(-1).end, 3.0);
  assert.equal(transcript.stats.words, 8);
});

test('the adapter turns auto into a language a reader can use, and keeps provenance', () => {
  const transcript = toAudioStudioTranscript(doc());
  assert.equal(transcript.language, 'en');
  assert.equal(transcript.engine.predictionId, 'p1');
  assert.equal(transcript.meta.provider.name, 'aifreeforever');
  assert.equal(transcript.duration, 10);
});

test('the veed master is the shape caption-studio imports', () => {
  const veed = toVeedMaster(doc());
  assert.equal(veed.version, '3.0');
  assert.deepEqual(veed.canvas, { width: 1280, height: 720 });
  assert.equal(veed.subtitles.length, 2);
  const first = veed.subtitles[0];
  assert.equal(first.start, 0.48);
  assert.equal(first.end, 3.0);
  assert.deepEqual(first.words[0], { text: 'Just', s: 0.48, e: 1.073 });
  assert.ok(Array.isArray(first.styles));
  assert.equal(veed.audioStudio.alignment.interpolated, true);
});

test('a chunk with no text is kept in the native file and dropped from both bridges', () => {
  const built = buildTranscript({
    chunks: [
      { start: 0, end: 1, text: 'hello' },
      { start: 1, end: 2, text: '' },
    ],
    duration: 2,
    fetchedAt: 'fixed',
  });
  assert.equal(built.chunks.length, 2, 'the native file records what the service reported');
  assert.equal(toAudioStudioTranscript(built).segments.length, 1);
  assert.equal(toVeedMaster(built).subtitles.length, 1);
});
