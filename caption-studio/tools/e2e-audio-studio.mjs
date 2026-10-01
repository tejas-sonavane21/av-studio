/**
 * e2e-audio-studio.mjs — the two studios, wired together, on the real song.
 *
 * `ui-smoke.mjs` covers the browser wiring against a *stand-in* server. That is the right way to
 * test the page, and it leaves one gap: nothing there proves the real Python studio emits what
 * caption-studio actually reads. This script closes it by removing the stand-in entirely.
 *
 *   real server  →  real 182 s song  →  real faster-whisper  →  real transcript
 *        ↓                                                        ↓
 *   the real client module (`src/io/audio-studio-client.js`) → the real importer (`importJSON`)
 *        ↓
 *   a document `validateDocument()` accepts, and the real aligner against the real TRUTH file
 *
 * Every module it imports is the one the app runs. Nothing is stubbed, no fixture is replayed, and
 * the numbers it prints were measured on this machine a second ago.
 *
 * Usage: node tools/e2e-audio-studio.mjs [--align wav2vec] [--validate rules] [--preset balanced]
 *                                      [--port 8791] [--keep]
 *
 * It is a tool and not a `npm test` case on purpose: it needs a Python venv with `[asr]`
 * installed, a ~770 MB model cache, and about a minute and a half of CPU. Run it when you want to
 * believe the bridge rather than the tests.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeStudioAudit, health, transcribeFile } from '../src/io/audio-studio-client.js';
import { importJSON } from '../src/io/project-file.js';
import { validateDocument } from '../src/model/document.js';
import { alignCaptions } from '../src/align/aligner.js';
import { parseSRT } from '../src/io/srt.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');
const STUDIO_DIR = join(WORKSPACE_ROOT, 'audio-studio');
const SONG = join(WORKSPACE_ROOT, 'referece_material', 'The_Crimson_Burden.mp3');
const TRUTH = join(WORKSPACE_ROOT, 'referece_material', 'version10', 'spidy.srt');

const args = { align: '', validate: 'rules', preset: 'balanced', port: 0, keep: false, timeout: 900 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--align') args.align = process.argv[++i] ?? '';
  else if (a === '--validate') args.validate = process.argv[++i] ?? '';
  else if (a === '--preset') args.preset = process.argv[++i] ?? 'balanced';
  else if (a === '--port') args.port = Number(process.argv[++i]);
  else if (a === '--timeout') args.timeout = Number(process.argv[++i]);
  else if (a === '--keep') args.keep = true;
}

const failures = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
  return ok;
}

function note(text) {
  console.log(`    ${text}`);
}

/** The venv's interpreter, so the script cannot accidentally use a system Python. */
function findPython() {
  const candidates = [
    join(STUDIO_DIR, '.venv', 'Scripts', 'python.exe'),
    join(STUDIO_DIR, '.venv', 'bin', 'python'),
  ];
  return candidates.find(existsSync) ?? null;
}

async function freePort() {
  if (args.port) return args.port;
  return new Promise((res) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
}

async function waitForHealth(base, { attempts = 120, intervalMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await health(base);
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n■ prerequisites');
  const python = findPython();
  if (!python) {
    console.error('no venv at audio-studio/.venv — create it and `pip install -e ".[asr]"` first');
    process.exit(2);
  }
  if (!existsSync(SONG)) {
    console.error(`the fixture is missing: ${SONG}`);
    process.exit(2);
  }
  check('a venv interpreter belongs to audio-studio', Boolean(python), python ?? 'none found');
  const megabytes = statSync(SONG).size / 1e6;
  check('the real song is present', megabytes > 1, `${megabytes.toFixed(1)} MB`);
  note(`song    ${SONG}`);
  note(`python  ${python}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const jobs = mkdtempSync(join(tmpdir(), 'audio-studio-e2e-'));
  note(`jobs    ${jobs}`);

  // The real server, on the real command line. No test doubles anywhere in this file.
  const server = spawn(python, ['-m', 'audio_studio', 'serve', '--port', String(port), '--out', jobs], {
    cwd: STUDIO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (b) => serverLog.push(String(b)));
  server.stderr.on('data', (b) => serverLog.push(String(b)));
  let stopped = false;
  const stopServer = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (process.platform === 'win32' && server.pid) spawn('taskkill', ['/F', '/PID', String(server.pid)], { stdio: 'ignore' });
      else server.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', () => {
    stopServer();
    if (!args.keep) {
      try {
        rmSync(jobs, { recursive: true, force: true });
      } catch {
        /* windows keeps a handle open sometimes; harmless */
      }
    }
  });

  console.log('\n■ the real server');
  const info = await waitForHealth(base);
  if (!info) {
    console.error(`the server never answered on ${base}\n${serverLog.join('')}`);
    process.exit(2);
  }
  check('it answers /health', info.ok === true);
  const usable = (list) => (list ?? []).filter((e) => e.available).map((e) => e.name);
  check('and names a transcription engine', usable(info.engines).includes('whisper'), JSON.stringify(usable(info.engines)));
  check('and says whether it can align', Array.isArray(info.aligners), JSON.stringify(info.aligners));
  if (args.align) {
    check(
      `the aligner it will be asked for (${args.align}) is available`,
      usable(info.aligners).includes(args.align),
      JSON.stringify(usable(info.aligners)),
    );
  }
  note(`version ${info.version} · preset ${args.preset} · engines ${usable(info.engines).join(', ')}`);
  note(`aligners ${usable(info.aligners).join(', ')} · validators ${usable(info.validators).join(', ')}`);

  console.log('\n■ transcribe it through the real client');
  const bytes = new Uint8Array(readFileSync(SONG));
  const file = new File([bytes], 'The_Crimson_Burden.mp3', { type: 'audio/mpeg' });
  const options = {
    preset: args.preset,
    emit: 'json,veed,srt,vtt',
    align: args.align || undefined,
    validate: args.validate || undefined,
  };
  note(`POST ${base}/transcribe/upload?align=${args.align || 'off'}&validate=${args.validate || 'off'}`);

  const started = Date.now();
  let lastLine = '';
  let lastProgress = -1;
  const { veed, text, job } = await transcribeFile(base, file, options, {
    intervalMs: 1000,
    onProgress: (fraction, message) => {
      const percent = Math.floor((fraction ?? 0) * 100);
      if (percent >= lastProgress + 10 || (message ?? '') !== lastLine) {
        lastProgress = percent;
        lastLine = message ?? '';
        note(`${String(percent).padStart(3)}%  ${message ?? ''}`);
      }
    },
  });
  const seconds = (Date.now() - started) / 1000;

  check('the job finished', job.status === 'done', `${job.status}: ${job.error ?? ''}`);
  check('and carried a Veed artifact', typeof text === 'string' && text.length > 1000, `${text?.length ?? 0} bytes`);
  check('which parses as JSON', Boolean(veed) && typeof veed === 'object');
  note(`${job.summary?.segments ?? '?'} segments · ${job.summary?.words ?? '?'} words · ${seconds.toFixed(1)} s wall`);

  console.log('\n■ what the other studio wrote down');
  for (const line of describeStudioAudit(veed)) note(line);
  check('the Veed shape is the one the importer detects', veed.version === '3.0' && Boolean(veed.canvas), `version ${veed.version}`);
  check('the parity style is present and unmodified', veed.style?.fontSize === 0.036 && veed.style?.posX === 0.772, JSON.stringify(veed.style));
  const audit = veed.audioStudio ?? {};
  check('the engine is named', Boolean(veed.engine?.name), JSON.stringify(veed.engine));
  if (args.align) {
    check('the alignment pass recorded its provenance', Boolean(audit.alignment), 'no alignment block');
    check(
      'and it aligned words rather than leaving the transcript alone',
      (audit.alignment?.wordsAligned ?? 0) > 0,
      JSON.stringify(audit.alignment),
    );
  } else {
    check('alignment was off, and the artifact says so', !audit.alignment, JSON.stringify(audit.alignment));
  }
  if (args.validate) {
    check('the validation pass recorded a ledger entry', Array.isArray(audit.validation?.passes) && audit.validation.passes.length > 0, JSON.stringify(audit.validation));
  }

  console.log('\n■ and through the importer the app actually uses');
  const { document: doc, kind } = importJSON(text);
  check('importJSON reads it as a Veed extract', kind === 'veed', `kind ${kind}`);
  check('the document has captions', doc.blocks.length > 20, `${doc.blocks.length} blocks`);
  check('every block joins its words back into its own text', doc.blocks.every((b) => b.text === b.words.map((w) => w.text).join(' ')));
  check('the words are monotonic within and across blocks', monotonic(doc));
  const report = validateDocument(doc);
  check('validateDocument accepts it', report.errors.length === 0, report.errors.slice(0, 3).join(' | '));
  check(
    'its canvas is the one the server sent',
    doc.canvas?.width === veed.canvas?.width && doc.canvas?.height === veed.canvas?.height,
    JSON.stringify(doc.canvas),
  );

  // The point of the whole bridge: the numbers in the editor are the ones measured from the audio,
  // byte for byte. If these ever diverge, the studio has become a translator instead of a source.
  const sentWords = veed.subtitles.flatMap((s) => s.words);
  const gotWords = doc.blocks.flatMap((b) => b.words);
  check('every word the server measured arrived', sentWords.length === gotWords.length, `${sentWords.length} sent, ${gotWords.length} received`);
  const drift = Math.max(
    ...sentWords.map((w, i) => Math.max(Math.abs(w.s - gotWords[i].start), Math.abs(w.e - gotWords[i].end))),
  );
  check('and not one of its timings moved crossing the wire', drift < 1e-6, `largest difference ${drift}s`);

  note('first captions as the editor sees them:');
  for (const block of doc.blocks.slice(0, 4)) {
    note(`${block.start.toFixed(2)}–${block.end.toFixed(2)}  ${block.text}`);
  }
  note('last caption:');
  const last = doc.blocks[doc.blocks.length - 1];
  note(`${last.start.toFixed(2)}–${last.end.toFixed(2)}  ${last.text}`);

  if (existsSync(TRUTH)) {
    console.log('\n■ and the existing TRUTH correction still works on those timings');
    const { cues } = parseSRT(readFileSync(TRUTH, 'utf8'));
    const { blocks, corrections, report: alignReport } = alignCaptions({
      aiBlocks: doc.blocks.map((b) => ({ start: b.start, end: b.end, words: b.words })),
      truthCues: cues,
    });
    check('the aligner produced a document', blocks.length > 20, `${blocks.length} blocks`);
    check(
      'the TRUTH spelling still wins over the transcription',
      blocks.map((b) => b.text).join(' ').toLowerCase().includes('catch the falling'),
      'expected the corrected line',
    );
    check('the anchors came from the measured word stream', alignReport.anchors > 20, `${alignReport.anchors} anchors`);
    const after = validateDocument({ schemaVersion: 1, canvas: doc.canvas, blocks });
    check('and the corrected document is still valid', after.errors.length === 0, after.errors.slice(0, 3).join(' | '));

    // The reason the two studios exist, as one assertion. The TRUTH file supplies the *spelling*;
    // the measurement supplies the *clock*. These two documents really do disagree about when the
    // opening line starts — the cue boundary is about a second earlier — so a caption can only
    // land on the measured one if the measurement won, which is the opposite of what caption-studio
    // did when it inherited its word timings from Veed.
    const measured = doc.blocks.find((b) => /\bjust\b/i.test(b.text));
    const corrected = blocks.find((b) => /\bjust\b/i.test(b.text));
    const cue = cues.find((c) => /\bjust\b/i.test(c.lines.join(' ')));
    if (!measured || !corrected || !cue) {
      check('the opening line is present on all three sides', false, `measured=${Boolean(measured)} corrected=${Boolean(corrected)} cue=${Boolean(cue)}`);
    } else {
      check(
        'the corrected caption kept the measured onset',
        Math.abs(corrected.start - measured.start) < 0.4,
        `measured ${measured.start.toFixed(2)}, corrected ${corrected.start.toFixed(2)}`,
      );
      check(
        'and did NOT snap back to the TRUTH cue boundary',
        Math.abs(corrected.start - cue.start) > 0.3,
        `cue opens at ${cue.start.toFixed(2)}, corrected at ${corrected.start.toFixed(2)}`,
      );
      note(`“${measured.text}” — measured at ${measured.start.toFixed(2)} s, the TRUTH cue opens at ${cue.start.toFixed(2)} s, the editor uses ${corrected.start.toFixed(2)} s`);
    }
    note(`${blocks.length} blocks · ${alignReport.anchors} anchors · ${corrections.length} corrections`);
    note(`${alignReport.inserted} word(s) only one transcript heard, ${alignReport.deleted} only the other — two real transcripts, so disagreement is expected and reported`);
  } else {
    note(`\n(no TRUTH file at ${TRUTH} — skipping the correction leg)`);
  }

  stopServer();
  await delay(200);
  console.log(`\n${failures.length ? '✖ FAILED' : '✔ PASSED'} — ${failures.length} failing check(s)`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(failures.length ? 1 : 0);
}

/** Words must never go backwards in time, inside a caption or across one. */
function monotonic(doc) {
  let cursor = -Infinity;
  for (const block of doc.blocks) {
    for (const word of block.words) {
      if (word.start < cursor - 1e-6) return false;
      cursor = word.end;
    }
  }
  return true;
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
