import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../src/server.js';

const PAYLOAD = {
  success: true,
  predictionId: 'pred-server',
  chunks: [{ text: ' 🎵 Just an ordinary boy 🎵', timestamp: [0.48, 3] }],
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function studioWithFake() {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-studio-server-'));
  const provider = {
    calls: [],
    async transcribe(request) {
      this.calls.push(request);
      await delay(5);
      return { payload: PAYLOAD, duration: 6.5, request: { hasToken: true } };
    },
    async close() {},
  };
  const studio = createServer({ outDir: dir, provider });
  const { url } = await studio.listen({ port: 0 });
  return { studio, url, provider, dir };
}

async function waitForJob(url, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await fetch(`${url}/jobs/${id}`);
    const job = await response.json();
    if (job.status === 'done' || job.status === 'error') return job;
    await delay(20);
  }
  throw new Error(`job ${id} never finished`);
}

test('health describes the service and what it accepts', async () => {
  const { studio, url } = await studioWithFake();
  try {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.name, 'transcript-studio');
    assert.equal(health.provider, 'aifreeforever');
    assert.equal(health.limits.maxBytes, 25 * 1024 * 1024);
    assert.equal(health.limits.maxSeconds, 300);
    assert.ok(health.languages.some((language) => language.code === 'en'));
    assert.deepEqual(health.artifacts, ['json', 'srt', 'vtt', 'txt', 'speech', 'veed']);
  } finally {
    await studio.close();
  }
});

test('preflight is answered so a different origin can call it', async () => {
  const { studio, url } = await studioWithFake();
  try {
    const response = await fetch(`${url}/transcribe`, { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  } finally {
    await studio.close();
  }
});

test('an upload becomes a job with servable artifacts', async () => {
  const { studio, url, provider, dir } = await studioWithFake();
  try {
    const body = Buffer.from('fake mp3 bytes');
    const response = await fetch(`${url}/transcribe?name=song.mp3&language=en&emit=json,srt`, {
      method: 'POST',
      body,
    });
    assert.equal(response.status, 202);
    const started = await response.json();
    assert.ok(started.jobId);

    const job = await waitForJob(url, started.jobId);
    assert.equal(job.status, 'done', job.error ?? '');
    assert.equal(job.progress, 1);
    assert.equal(job.summary.chunks, 1);
    assert.equal(job.summary.words, 4);
    assert.equal(job.summary.duration, 6.5);
    assert.deepEqual(job.files.map((file) => file.kind), ['json', 'srt']);

    const srt = await fetch(`${url}/jobs/${started.jobId}/files/srt`);
    assert.equal(srt.status, 200);
    assert.equal(srt.headers.get('content-type'), 'application/x-subrip; charset=utf-8');
    const text = await srt.text();
    assert.match(text, /00:00:00,480 --> 00:00:03,000/);
    assert.match(text, /Just an ordinary boy/);
    assert.ok(!text.includes('🎵'));

    const transcript = await fetch(`${url}/jobs/${started.jobId}/files/json`).then((reply) => reply.json());
    assert.equal(transcript.provider.predictionId, 'pred-server');
    assert.equal(transcript.source.name, 'song.mp3');
    assert.equal(transcript.provider.language, 'en');
    assert.match(provider.calls[0].filePath, /song\.mp3$/);
    assert.ok(provider.calls[0].filePath.startsWith(dir));
  } finally {
    await studio.close();
  }
});

test('the file check answers before a job is created', async () => {
  const { studio, url, provider } = await studioWithFake();
  try {
    const response = await fetch(`${url}/transcribe?name=song.ogg`, { method: 'POST', body: 'x' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /MP3, WAV or FLAC/);
    assert.equal(provider.calls.length, 0);
  } finally {
    await studio.close();
  }
});

test('a known route with an unknown job is a 404, not an empty 200', async () => {
  const { studio, url } = await studioWithFake();
  try {
    assert.equal((await fetch(`${url}/jobs/abcdef123456`)).status, 404);
    assert.equal((await fetch(`${url}/jobs/abcdef123456/files/srt`)).status, 404);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  } finally {
    await studio.close();
  }
});

test('the studio page is served from web/', async () => {
  const { studio, url } = await studioWithFake();
  try {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /transcript-studio/);
    assert.match(html, /app\.js/);
    const script = await fetch(`${url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
  } finally {
    await studio.close();
  }
});

test('a provider failure is reported on the job, with its hint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-studio-server-fail-'));
  const provider = {
    async transcribe() {
      const error = new Error('the site security check did not clear');
      error.hint = 'it needs a real, visible Chrome';
      throw error;
    },
    async close() {},
  };
  const studio = createServer({ outDir: dir, provider });
  const { url } = await studio.listen({ port: 0 });
  try {
    const response = await fetch(`${url}/transcribe?name=song.mp3`, { method: 'POST', body: 'x' });
    const { jobId } = await response.json();
    const job = await waitForJob(url, jobId);
    assert.equal(job.status, 'error');
    assert.match(job.error, /security check/);
    assert.match(job.hint, /visible Chrome/);
  } finally {
    await studio.close();
  }
});
