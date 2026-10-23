/**
 * tools/live-smoke.mjs — the one check that needs Chrome and the internet.
 *
 * `npm test` is pure and fast on purpose. This is the opposite: it opens Chrome,
 * uploads to the real service, waits out the site's own queue, and spends the
 * two-minute cooldown. Run it when the contract itself may have changed, not on
 * every edit.
 *
 * Usage:
 *   node tools/live-smoke.mjs <audio> [--out DIR] [--language en]
 *
 * Exit code 0 means a transcript came back and every requested artifact has the
 * shape this studio promises - not that the text is correct (see the README's
 * WER table for that).
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

import { runTranscription } from '../src/core/run.js';
import { FreeTranscriber } from '../src/provider/aifreeforever.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'out/live-smoke' },
    language: { type: 'string', default: 'auto' },
    profile: { type: 'string' },
    chrome: { type: 'string' },
  },
});

if (!positionals.length) {
  console.error('usage: node tools/live-smoke.mjs <audio> [--out DIR] [--language en]');
  process.exit(2);
}

const provider = new FreeTranscriber({
  chromePath: values.chrome,
  profileDir: values.profile,
  onLog: (message) => console.log(`  ${message}`),
});

try {
  const result = await runTranscription({
    provider,
    filePath: resolve(positionals[0]),
    language: values.language,
    outDir: resolve(values.out),
    onProgress: (update) => console.log(`  ${update.phase}: ${update.detail}`),
  });

  const problems = [];
  if (!result.files.length) problems.push('no artifacts were written');
  if (result.doc.chunks.length === 0) problems.push('no chunks in the transcript');
  const srt = result.files.find((file) => file.kind === 'srt');
  if (!srt || !/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(srt.text)) {
    problems.push('the SRT does not carry millisecond timestamps');
  }
  if (result.doc.warnings.some((warning) => /no usable chunks/.test(warning))) {
    problems.push('the service returned no usable chunks');
  }

  console.log('');
  console.log(`chunks ${result.doc.stats.chunks} · words ${result.doc.stats.words} · ${result.doc.duration.toFixed(2)} s`);
  console.log(`prediction ${result.doc.provider.predictionId}`);
  for (const file of result.files) console.log(`wrote ${file.path}`);

  if (problems.length) {
    console.error(`LIVE SMOKE FAILED: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log('LIVE SMOKE OK');
} catch (error) {
  console.error(`LIVE SMOKE FAILED: ${error.message}${error.hint ? ` - ${error.hint}` : ''}`);
  process.exit(1);
} finally {
  await provider.close();
}
