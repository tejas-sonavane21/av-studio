/**
 * io/audio-studio-client.js — the bridge to the Python studio, without a browser.
 *
 * Everything here runs against a stand-in `fetch`, so the client's contract is pinned without a
 * Python process: the query string the server validates, the polling loop, the error that appears
 * when the server is simply not running (the common case by a wide margin), and the provenance the
 * other studio writes.
 *
 * The last section goes further and imports a **real** artifact the Python emitter produced, when
 * one happens to be on disk. That is the only way to test the actual bridge — two studios, two
 * languages — rather than each studio's idea of the other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  AudioStudioError,
  DEFAULT_BASE_URL,
  HEALTH_TIMEOUT_MS,
  MAX_QUERY_CHARS,
  buildQuery,
  describeStudioAudit,
  fetchArtifact,
  health,
  normalizeBaseUrl,
  optionsFor,
  startUpload,
  transcribeFile,
  waitForJob,
} from '../../src/io/audio-studio-client.js';
import { importJSON } from '../../src/io/project-file.js';
import { validateDocument } from '../../src/model/document.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A `fetch` that answers from a route table and remembers what it was asked. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    for (const [matcher, handler] of routes) {
      const hit = typeof matcher === 'string' ? target.includes(matcher) : matcher.test(target);
      if (!hit) continue;
      const answer = typeof handler === 'function' ? await handler(target, init) : handler;
      if (answer && answer.threw) throw answer.threw;
      return {
        ok: (answer.status ?? 200) < 400,
        status: answer.status ?? 200,
        json: async () => answer.json,
        text: async () => answer.text ?? JSON.stringify(answer.json ?? ''),
      };
    }
    throw new TypeError('Failed to fetch');
  };
  impl.calls = calls;
  return impl;
}

// --------------------------------------------------------------------------- #
// the shape of a request
// --------------------------------------------------------------------------- #

test('normalizeBaseUrl drops trailing slashes and defaults to loopback', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8756/'), 'http://127.0.0.1:8756');
  assert.equal(normalizeBaseUrl('http://localhost:1234///'), 'http://localhost:1234');
  assert.equal(normalizeBaseUrl(''), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(null), DEFAULT_BASE_URL);
});

test('buildQuery keeps the names the server validates and drops the empty ones', () => {
  const query = buildQuery({
    name: 'song.mp3',
    preset: 'balanced',
    language: '',
    align: undefined,
    emit: ['json', 'veed'],
    wordLevel: false,
    model: null,
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get('name'), 'song.mp3');
  assert.equal(params.get('preset'), 'balanced');
  assert.equal(params.get('emit'), 'json,veed');
  assert.equal(params.get('wordLevel'), 'false');
  assert.equal(params.has('language'), false);
  assert.equal(params.has('align'), false);
  assert.equal(params.has('model'), false);
});

test('optionsFor turns "off" into an absent option, not an unknown one', () => {
  const off = optionsFor({ preset: 'fast', align: 'off', validate: 'off', language: '' });
  assert.equal(off.align, undefined);
  assert.equal(off.validate, undefined);
  assert.equal(off.language, undefined);
  assert.equal(off.preset, 'fast');

  const on = optionsFor({ align: 'wav2vec', validate: 'rules', language: 'en' });
  assert.equal(on.align, 'wav2vec');
  assert.equal(on.validate, 'rules');
  assert.equal(on.language, 'en');
});

// --------------------------------------------------------------------------- #
// talking to the server
// --------------------------------------------------------------------------- #

test('health returns what the server can actually do', async () => {
  const fetchImpl = fakeFetch([
    ['/health', { json: { ok: true, version: '0.1.0', aligners: [{ name: 'wav2vec', available: true }] } }],
  ]);
  const info = await health('http://127.0.0.1:8756/', { fetchImpl });
  assert.equal(info.version, '0.1.0');
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:8756/health');
});

test('a server that is not running says exactly that, and how to start it', async () => {
  const fetchImpl = fakeFetch([]); // every route falls through to a TypeError
  await assert.rejects(
    () => health('http://127.0.0.1:8756', { fetchImpl }),
    (error) => {
      assert.ok(error instanceof AudioStudioError);
      assert.match(error.message, /cannot reach audio-studio/);
      assert.match(error.hint, /python -m audio_studio serve/);
      return true;
    },
  );
});

test('a server that is busy is not reported as a server that is missing', async () => {
  /**
   * The first `Check server` click on a perfectly healthy server used to report it as unreachable:
   * the probe was abandoned at 4 s while the payload was still importing torch. "Busy" and "absent"
   * have different fixes, so they must not produce the same message.
   */
  const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  const fetchImpl = fakeFetch([['/health', { threw: aborted }]]);

  await assert.rejects(
    () => health('http://127.0.0.1:8756', { fetchImpl, timeoutMs: 50 }),
    (error) => {
      assert.match(error.message, /did not answer in time/);
      assert.doesNotMatch(error.message, /cannot reach/);
      assert.equal(error.timedOut, true);
      assert.match(error.hint, /busy/);
      return true;
    },
  );
});

test('the health probe allows for a cold import rather than the four seconds it first allowed', () => {
  // Measured on the machine this was built on: a cold `import torch` plus `import transformers`
  // costs 6.3 s, and the original 4000 ms deadline failed the very first click every single run.
  assert.ok(HEALTH_TIMEOUT_MS > 6000, `the probe must outlast a cold import, got ${HEALTH_TIMEOUT_MS}ms`);
});

test('a refusal from the server is surfaced with the server’s own words', async () => {
  const fetchImpl = fakeFetch([['/health', { status: 500, json: { error: 'something broke' } }]]);
  await assert.rejects(
    () => health('http://127.0.0.1:8756', { fetchImpl }),
    (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.message, 'something broke');
      return true;
    },
  );
});

test('startUpload sends the file itself, with its name in the query', async () => {
  const fetchImpl = fakeFetch([['/transcribe/upload', { json: { jobId: 'abc', status: 'queued' } }]]);
  const file = new Blob(['audio bytes'], { type: 'audio/mpeg' });
  file.name = 'song.mp3';

  const job = await startUpload('http://127.0.0.1:8756', file, { preset: 'fast', align: 'fake' }, { fetchImpl });

  assert.equal(job.jobId, 'abc');
  const [call] = fetchImpl.calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.body, file, 'the bytes go as the body — a browser cannot read a path');
  assert.match(call.url, /name=song\.mp3/);
  assert.match(call.url, /preset=fast/);
  assert.match(call.url, /align=fake/);
  assert.equal(call.init.headers['Content-Type'], 'audio/mpeg');
});

test('waitForJob polls until the job is done, reporting progress on the way', async () => {
  const states = [
    { status: 'queued', progress: 0 },
    { status: 'running', progress: 0.4, message: '20 segments' },
    { status: 'done', progress: 1, summary: { words: 250 } },
  ];
  let index = 0;
  const fetchImpl = fakeFetch([[/\/jobs\/abc$/, () => ({ json: states[Math.min(index++, states.length - 1)] })]]);
  const seen = [];

  const job = await waitForJob('http://127.0.0.1:8756', 'abc', {
    fetchImpl,
    intervalMs: 1,
    onProgress: (state) => seen.push(state.status),
  });

  assert.equal(job.status, 'done');
  assert.equal(job.summary.words, 250);
  assert.deepEqual(seen, ['queued', 'running', 'done']);
  assert.equal(fetchImpl.calls.length, 3);
});

test('waitForJob refuses to pretend a failed job succeeded', async () => {
  const fetchImpl = fakeFetch([[/\/jobs\/abc$/, { json: { status: 'error', error: 'torch is not installed' } }]]);
  await assert.rejects(
    () => waitForJob('http://127.0.0.1:8756', 'abc', { fetchImpl, intervalMs: 1 }),
    /torch is not installed/,
  );
});

test('a cancelled job stops polling rather than running forever', async () => {
  const fetchImpl = fakeFetch([[/\/jobs\/abc$/, { json: { status: 'running', progress: 0.1 } }]]);
  let polls = 0;
  await assert.rejects(
    () => waitForJob('http://127.0.0.1:8756', 'abc', { fetchImpl, intervalMs: 1, shouldStop: () => ++polls > 2 }),
    /cancelled/,
  );
  assert.ok(fetchImpl.calls.length <= 3, 'it must stop, not spin');
});

test('fetchArtifact returns the raw text so it can go through the normal importer', async () => {
  const fetchImpl = fakeFetch([[/\/jobs\/abc\/veed$/, { text: '{"version":"3.0"}' }]]);
  assert.equal(await fetchArtifact('http://127.0.0.1:8756', 'abc', 'veed', { fetchImpl }), '{"version":"3.0"}');
});

test('transcribeFile is the upload, the wait and the fetch, in that order', async () => {
  const veed = { version: '3.0', canvas: { width: 1280, height: 720 }, subtitles: [] };
  const fetchImpl = fakeFetch([
    [/\/jobs\/xyz\/veed$/, { text: JSON.stringify(veed) }],
    [/\/jobs\/xyz$/, { json: { status: 'done', progress: 1, summary: { seconds: 78 } } }],
    ['/transcribe/upload', { json: { jobId: 'xyz' } }],
  ]);
  const file = new Blob(['x'], { type: 'audio/wav' });
  file.name = 'clip.wav';

  const result = await transcribeFile('http://127.0.0.1:8756', file, { preset: 'balanced' }, { fetchImpl });

  assert.deepEqual(result.veed, veed);
  assert.equal(result.job.summary.seconds, 78);
  assert.deepEqual(
    fetchImpl.calls.map((call) => new URL(call.url).pathname),
    ['/transcribe/upload', '/jobs/xyz', '/jobs/xyz/veed'],
  );
});

test('transcribeFile without a file fails before it touches the network', async () => {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(() => transcribeFile(DEFAULT_BASE_URL, null, {}, { fetchImpl }), /choose an audio/);
  assert.equal(fetchImpl.calls.length, 0);
});

// --------------------------------------------------------------------------- #
// the provenance the other studio wrote
// --------------------------------------------------------------------------- #

test('the audit names the engine, the aligner and what it changed', () => {
  const lines = describeStudioAudit({
    engine: { name: 'faster-whisper', model: 'small', preset: 'balanced' },
    audioStudio: {
      alignment: {
        aligner: 'wav2vec',
        model: 'facebook/wav2vec2-base-960h',
        segments: 41,
        segmentsAligned: 39,
        meanConfidence: 0.5846,
        meanShift: 0.2345,
        wordsClamped: 2,
      },
      validation: { passes: [{ validator: 'llm', corrections: 3, applied: 2 }] },
      corrections: [{ index: 0 }, { index: 1 }],
      warnings: ['timing gap 3.28s-13.18s'],
    },
  }).join('\n');

  assert.match(lines, /engine faster-whisper\/small \(preset balanced\)/);
  assert.match(lines, /alignment wav2vec\/facebook\/wav2vec2-base-960h: 39\/41 segments/);
  assert.match(lines, /clamped 2 word/);
  assert.match(lines, /validation llm: 3 proposed, 2 applied/);
  assert.match(lines, /corrections 2 ledger entries/);
  assert.match(lines, /timing gap/);
});

test('an unaligned run says so, and a synthetic one says so loudly', () => {
  assert.match(describeStudioAudit({ audioStudio: {} }).join('\n'), /alignment off/);
  assert.match(
    describeStudioAudit({ audioStudio: { alignment: { aligner: 'fake', synthetic: true } } }).join('\n'),
    /SYNTHETIC/,
  );
});

test('a real Veed extract has no audit, and that is not an error', () => {
  assert.deepEqual(describeStudioAudit({ canvas: {}, subtitles: [] }), ['no audio-studio provenance in this file']);
  assert.deepEqual(describeStudioAudit(null), ['no audio-studio provenance in this file']);
});

// --------------------------------------------------------------------------- #
// the contract: what the Python emitter writes is what this importer reads
// --------------------------------------------------------------------------- #

/** Modelled on `audio_studio/emit/veed.py`'s output, down to the key names. */
const EMITTED = {
  version: '3.0',
  generator: 'audio-studio/0.1.0',
  engine: { name: 'faster-whisper', model: 'small', preset: 'balanced', vadFilter: false },
  projectId: 'audio-studio',
  canvas: { width: 1280, height: 720 },
  style: { font: 'Inter', fontSize: 0.036, posX: 0.772, posY: 0.848, align: 'center' },
  subtitles: [
    {
      start: 13.18,
      end: 19.0,
      words: [
        { text: 'Just', s: 13.4, e: 14.14, p: 0.71 },
        { text: 'an', s: 14.38, e: 14.44, p: 0.55 },
        { text: 'ordinary', s: 14.66, e: 16.2, p: 0.62 },
        { text: 'boy', s: 16.52, e: 16.88, p: 0.8 },
      ],
      styles: [],
    },
    {
      start: 19.0,
      end: 23.16,
      words: [
        { text: 'Lost', s: 19.0, e: 19.6, p: 0.7 },
        { text: 'in', s: 19.7, e: 19.76, p: 0.6 },
        { text: 'the', s: 19.8, e: 19.9, p: 0.9 },
        { text: 'crowd', s: 20.1, e: 20.9, p: 0.75 },
      ],
      styles: [],
    },
  ],
  audioStudio: {
    alignment: { aligner: 'wav2vec', model: 'facebook/wav2vec2-base-960h', segments: 2, segmentsAligned: 2, meanConfidence: 0.6, meanShift: 0.23 },
    validation: { passes: [{ validator: 'rules', corrections: 0, applied: 0, outcomes: {} }] },
    warnings: [],
    language: 'en',
    duration: 182.544,
  },
};

test('an artifact from the Python studio imports as a caption document', () => {
  const { document: doc, kind } = importJSON(JSON.stringify(EMITTED));

  assert.equal(kind, 'veed', 'it has a canvas, so it is Veed-shaped');
  assert.equal(doc.blocks.length, 2);
  assert.equal(doc.blocks[0].words[0].text, 'Just');
  assert.equal(doc.blocks[0].words[0].start, 13.4);
  assert.equal(doc.blocks[0].words[0].end, 14.14);
  assert.equal(doc.blocks[0].start, 13.18);
  assert.equal(doc.blocks[1].words[3].start, 20.1);
  // and the word join invariant survives, which is what keeps the text intact
  assert.equal(doc.blocks[0].text, 'Just an ordinary boy');

  for (const block of doc.blocks) {
    assert.equal(block.text, block.words.map((word) => word.text).join(' '));
  }
  assert.deepEqual(validateDocument(doc).errors, []);
});

test('the parity style means the imported document is not silently restyled', () => {
  const { document: doc } = importJSON(JSON.stringify(EMITTED));
  assert.equal(doc.defaults.font.family, 'Inter');
  assert.equal(doc.defaults.font.size, 0.036);
  assert.equal(doc.defaults.anchor.posX, 0.772);
  assert.equal(doc.defaults.anchor.posY, 0.848);
  assert.equal(doc.defaults.align, 'center');
});

// --------------------------------------------------------------------------- #
// the real thing, when it is on disk
// --------------------------------------------------------------------------- #

const generatedVeed = path.resolve(here, '../../../audio-studio/out/aligned/The_Crimson_Burden.veed.json');

test('the artifact the real Python emitter wrote imports cleanly', (t) => {
  if (!existsSync(generatedVeed)) {
    return t.skip('no audio-studio output on disk; run: python -m audio_studio transcribe <audio> --align wav2vec');
  }

  const raw = readFileSync(generatedVeed, 'utf8');
  const { document: doc, kind } = importJSON(raw);

  assert.equal(kind, 'veed');
  assert.ok(doc.blocks.length > 20, `blocks=${doc.blocks.length}`);
  const words = doc.blocks.reduce((total, block) => total + block.words.length, 0);
  assert.ok(words > 200, `words=${words}`);
  assert.deepEqual(validateDocument(doc).errors, []);
  for (const block of doc.blocks) {
    assert.equal(block.text, block.words.map((word) => word.text).join(' '));
    for (const word of block.words) assert.ok(word.end >= word.start, `backwards word in ${block.id}`);
  }

  // The audit that made the round trip has to be readable at the other end, or the bridge is
  // carrying timings nobody can account for.
  const lines = describeStudioAudit(JSON.parse(raw)).join('\n');
  assert.match(lines, /alignment wav2vec/);
  assert.match(lines, /mean confidence/);
});

// --------------------------------------------------------------------------- #
// the original lyrics
// --------------------------------------------------------------------------- #

test('the lyrics ride with the job as text, named, and only when there are any', () => {
  const none = optionsFor({ preset: 'fast' });
  assert.equal(none.referenceText, undefined);
  assert.equal(none.referenceName, undefined);

  const some = optionsFor({ preset: 'fast', referenceText: 'the words\n', referenceName: 'spidy.srt' });
  assert.equal(some.referenceText, 'the words\n');
  assert.equal(some.referenceName, 'spidy.srt');

  // A name with no text would be a lie about what was sent, so it is dropped.
  assert.equal(optionsFor({ referenceName: 'spidy.srt' }).referenceName, undefined);
  assert.equal(optionsFor({ referenceText: 'x' }).referenceName, 'lyrics');
});

test('the lyrics reach the query string, and an absent one does not', () => {
  const query = buildQuery(optionsFor({ preset: 'fast', referenceText: 'hold on', referenceName: 'x.srt' }));
  assert.match(query, /referenceText=hold\+on/);
  assert.match(query, /referenceName=x\.srt/);
  assert.doesNotMatch(buildQuery(optionsFor({ preset: 'fast' })), /reference/);
});

test('a lyric file too large for the request line is refused before anything is sent', async () => {
  const fetchImpl = fakeFetch([]);
  const file = new Blob(['audio'], { type: 'audio/mpeg' });
  file.name = 'song.mp3';

  await assert.rejects(
    () =>
      startUpload(DEFAULT_BASE_URL, file, optionsFor({ referenceText: 'x'.repeat(MAX_QUERY_CHARS) }), { fetchImpl }),
    (error) => {
      assert.ok(error instanceof AudioStudioError);
      assert.match(error.message, /request is \d+ characters long/);
      assert.match(error.hint, /64 KB/, 'the hint has to say what to do about it');
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 0, 'the request must not be attempted');
});

test('the audit reports what the reference pass did', () => {
  const applied = describeStudioAudit({
    engine: { name: 'faster-whisper', model: 'small' },
    audioStudio: {
      reference: {
        name: 'spidy.srt',
        rolling: true,
        outcome: 'applied',
        matchRate: 0.898,
        counts: { kept: 185, rewritten: 61, inserted: 9, deleted: 4 },
      },
    },
  }).join('\n');
  assert.match(applied, /reference spidy\.srt \(rolling\): 90% of the audio matched the file/);
  assert.match(applied, /61 rewritten, 9 inserted, 4 deleted/);
});

test('a refused reference is reported as refused, with the reason', () => {
  const lines = describeStudioAudit({
    audioStudio: {
      reference: { name: 'other.srt', outcome: 'refused', reason: 'the lyrics and the audio agree on only 4.0% of words' },
    },
  }).join('\n');
  assert.match(lines, /reference other\.srt: REFUSED/);
  assert.match(lines, /agree on only 4\.0%/);
});

test('a run with no lyrics says nothing about lyrics', () => {
  const lines = describeStudioAudit({ engine: { name: 'faster-whisper' }, audioStudio: { alignment: { aligner: 'fake' } } }).join('\n');
  assert.doesNotMatch(lines, /reference/);
});

test('the words the Python studio measured survive the import untouched', (t) => {
  if (!existsSync(generatedVeed)) return t.skip('no audio-studio output on disk');

  const raw = JSON.parse(readFileSync(generatedVeed, 'utf8'));
  const { document: doc } = importJSON(JSON.stringify(raw));

  const emitted = raw.subtitles.flatMap((sub) => sub.words);
  const imported = doc.blocks.flatMap((block) => block.words);
  assert.equal(imported.length, emitted.length, 'the import must not drop or invent a word');

  for (let i = 0; i < emitted.length; i += 1) {
    assert.equal(imported[i].text, emitted[i].text, `word ${i} text`);
    assert.equal(imported[i].start, emitted[i].s, `word ${i} start`);
    assert.equal(imported[i].end, emitted[i].e, `word ${i} end`);
  }
});
