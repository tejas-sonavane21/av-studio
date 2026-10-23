import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileFacts, runTranscription } from '../../src/core/run.js';

const PAYLOAD = {
  success: true,
  predictionId: 'pred-1',
  chunks: [
    { text: ' 🎵 Just an ordinary boy 🎵', timestamp: [0.48, 3] },
    { text: ' Head in the books', timestamp: [3, 6.5] },
  ],
};

function fakeProvider(overrides = {}) {
  const calls = [];
  return {
    calls,
    async transcribe(request) {
      calls.push(request);
      return {
        payload: PAYLOAD,
        duration: 10,
        request: { method: 'POST', url: 'https://aifreeforever.com/api/transcribe-audio', hasToken: true },
        ...overrides,
      };
    },
  };
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-studio-run-'));
  const audio = join(dir, 'song.mp3');
  await writeFile(audio, Buffer.from('not really an mp3, but the provider is a stand-in'));
  return { dir, audio };
}

test('a run writes every requested artifact and records the source honestly', async () => {
  const { dir, audio } = await workspace();
  const provider = fakeProvider();

  const result = await runTranscription({
    provider,
    filePath: audio,
    language: 'en',
    artifacts: 'json,srt',
    outDir: join(dir, 'out'),
    fetchedAt: '2026-10-23T00:00:00.000Z',
  });

  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map((file) => file.kind), ['json', 'srt']);
  const srt = await readFile(join(dir, 'out', 'song.srt'), 'utf8');
  assert.match(srt, /00:00:00,480 --> 00:00:03,000/);
  assert.match(srt, /Just an ordinary boy/);

  const native = JSON.parse(await readFile(join(dir, 'out', 'song.transcript.json'), 'utf8'));
  assert.equal(native.provider.predictionId, 'pred-1');
  assert.equal(native.provider.language, 'en');
  assert.equal(native.source.name, 'song.mp3');
  assert.equal(native.source.sha256, createHash('sha256').update(await readFile(audio)).digest('hex'));
  assert.equal(native.duration, 10);
  assert.equal(native.chunks.length, 2);
  assert.equal(provider.calls[0].language, 'en');
  assert.equal(provider.calls[0].fileName, 'song.mp3');
});

test('the words the service decorated are clean in every artifact', async () => {
  const { dir, audio } = await workspace();
  const result = await runTranscription({
    provider: fakeProvider(),
    filePath: audio,
    artifacts: 'json,srt,speech,veed',
    outDir: join(dir, 'out'),
    fetchedAt: 'fixed',
  });

  assert.equal(result.doc.text, 'Just an ordinary boy Head in the books');
  for (const file of result.files) {
    assert.ok(!file.text.includes('🎵'), `${file.kind} still carries the music note`);
  }
});

test('a provider that reports a 6-minute file is refused with the site\'s limit', async () => {
  const { dir, audio } = await workspace();
  await assert.rejects(
    runTranscription({
      provider: fakeProvider({ duration: 360 }),
      filePath: audio,
      outDir: join(dir, 'out'),
    }),
    /at most 5 minutes/,
  );
});

test('an unknown artifact fails before the browser is asked to do anything', async () => {
  const { dir, audio } = await workspace();
  const provider = fakeProvider();
  await assert.rejects(
    runTranscription({ provider, filePath: audio, artifacts: 'srt,pdf', outDir: join(dir, 'out') }),
    /unknown artifact/,
  );
  assert.equal(provider.calls.length, 0);
});

test('a wrong extension never reaches the provider', async () => {
  const { dir } = await workspace();
  const audio = join(dir, 'song.ogg');
  await writeFile(audio, 'x');
  const provider = fakeProvider();
  await assert.rejects(runTranscription({ provider, filePath: audio }), /MP3, WAV or FLAC/);
  assert.equal(provider.calls.length, 0);
});

test('fileFacts reports a missing file as a missing file', async () => {
  await assert.rejects(fileFacts(join(tmpdir(), 'definitely-not-here.mp3')), /no such file/);
});
