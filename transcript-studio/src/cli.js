#!/usr/bin/env node
/**
 * cli.js — `transcript-studio <audio>`: one file in, artifacts out.
 *
 * Progress goes to stderr so `--json` on stdout stays machine-parseable, the
 * same split audio-studio's CLI uses. The heavy work is in `core/run.js`, which
 * the local server calls too; this file is argument parsing and a summary.
 */

import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION } from './core/transcript.js';
import { DEFAULT_ARTIFACTS, artifactNames } from './core/emit.js';
import { runTranscription } from './core/run.js';
import { FreeTranscriber } from './provider/aifreeforever.js';
import { startServer } from './server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

const HELP = `transcript-studio ${VERSION} - free hosted transcription for the web_av_editor suite

Usage:
  transcript-studio <audio> [options]
  transcript-studio serve [--port 8757]

The service is the free transcriber at aifreeforever.com: it accepts MP3, WAV or
FLAC up to 25 MB and 5 minutes, and returns line-level text with timings. A real
Chrome window is opened for the site's own security check, and the page's own
form is used - the file is not posted behind the page's back.

Options:
  --out DIR          where the artifacts go (default: out)
  --stem NAME        file-name stem (default: the audio's own)
  --language CODE    a code from the site's list (default: auto)
  --emit LIST        comma list: ${artifactNames().join(', ')}
                     (default: ${DEFAULT_ARTIFACTS.join(', ')})
  --profile DIR      Chrome profile for the site's clearance cookie (default: .browser-profile)
  --chrome PATH      Chrome binary (default: found automatically)
  --timeout SECONDS  how long to wait for the site's reply (default: 600)
  --keep-browser     leave Chrome open when the job finishes
  --json             machine-readable summary on stdout
  --quiet, -q        no progress output
  --version          print the version
  --help             this text

Outputs:
  .transcript.json   everything the service said, cleaned
  .srt / .vtt        subtitles with milliseconds (the site's own export is second-only)
  .txt               the words, one line per chunk
  .speech.json       audio-studio's native artifact (line windows, interpolated words)
  .veed.json         the Veed master caption-studio imports
`;

function fail(message, hint = '') {
  process.stderr.write(`transcript-studio: ${message}${hint ? `\n  ${hint}` : ''}\n`);
  process.exit(1);
}

function humanDuration(seconds) {
  const value = Number(seconds) || 0;
  const minutes = Math.floor(value / 60);
  const rest = (value % 60).toFixed(1);
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', default: 'out' },
        stem: { type: 'string' },
        language: { type: 'string', default: 'auto' },
        emit: { type: 'string' },
        profile: { type: 'string', default: resolve(PROJECT_ROOT, '.browser-profile') },
        chrome: { type: 'string' },
        timeout: { type: 'string', default: '600' },
        port: { type: 'string', default: '8757' },
        'keep-browser': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', short: 'q', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    fail(error.message, 'run with --help for the options');
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (positionals[0] === 'serve') {
    await startServer({
      port: Number(values.port) || 8757,
      outDir: resolve(values.out),
      profileDir: resolve(values.profile),
      chromePath: values.chrome,
    });
    return;
  }

  if (!positionals.length) {
    process.stderr.write(HELP);
    process.exit(2);
  }
  if (positionals.length > 1) {
    fail('one audio file at a time', 'the free service is a one-file tool; run the command again for the next file');
  }

  const audio = resolve(positionals[0]);
  const quiet = values.quiet || values.json;
  const progress = (line) => {
    if (!quiet) process.stderr.write(`${line}\n`);
  };

  const provider = new FreeTranscriber({
    chromePath: values.chrome,
    profileDir: values.profile,
    timeoutMs: Math.max(30, Number(values.timeout) || 600) * 1000,
    onLog: (message) => progress(`  ${message}`),
  });

  try {
    progress(`transcript-studio ${VERSION}`);
    progress(`audio: ${audio}`);

    const result = await runTranscription({
      provider,
      filePath: audio,
      language: values.language,
      artifacts: values.emit,
      stem: values.stem,
      outDir: resolve(values.out),
      onProgress: (update) => progress(`  ${update.phase}${update.detail ? `: ${update.detail}` : ''}`),
    });

    for (const file of result.files) progress(`wrote ${file.path}`);
    progress(
      `${result.doc.stats.chunks} chunks, ${result.doc.stats.words} words, ${humanDuration(result.doc.duration)} of audio`,
    );
    for (const warning of result.doc.warnings) progress(`warning: ${warning}`);

    if (values.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            audio,
            duration: result.doc.duration,
            chunks: result.doc.stats.chunks,
            words: result.doc.stats.words,
            predictionId: result.doc.provider.predictionId,
            warnings: result.doc.warnings,
            files: result.files.map((file) => ({ kind: file.kind, path: file.path })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(`${result.files.map((file) => file.path).join('\n')}\n`);
    }
  } finally {
    if (!values['keep-browser']) await provider.close();
    else progress('Chrome left open (--keep-browser)');
  }
}

main().catch((error) => {
  const hint = error?.hint ? String(error.hint) : '';
  fail(error?.message && error.message !== 'undefined' ? error.message : String(error), hint);
});
