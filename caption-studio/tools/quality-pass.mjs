/**
 * quality-pass.mjs — the complete quality pass, driven through the real UI.
 *
 * `npm run e2e` proves the studios agree at the wire level. This proves the thing a person
 * actually does: open the editor, point it at the real Python studio, upload the real song,
 * transcribe it with alignment, load the reference lyrics as a TRUTH file, run the quality
 * correction, and then *measure what came out* — the caption text against the reference lyrics,
 * and the caption clock against the cue boundaries it was handed.
 *
 * Nothing is stubbed. The audio-studio server is the real one, the aligner is real wav2vec2, the
 * page is the real editor in headless Chrome, and the scoring is done on the text the page is
 * showing.
 *
 * Usage:
 *   node tools/quality-pass.mjs [--preset balanced] [--align wav2vec] [--validate off|rules|llm]
 *                               [--media ../referece_material/The_Crimson_Burden.mp3]
 *                               [--truth ../referece_material/spidy.srt]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');

const args = {
  port: 8131,
  cdpport: 9335,
  studioPort: 8759,
  preset: 'balanced',
  align: 'wav2vec',
  validate: 'off',
  media: resolve(WORKSPACE_ROOT, 'referece_material/The_Crimson_Burden.mp3'),
  truth: resolve(WORKSPACE_ROOT, 'referece_material/spidy.srt'),
  jobTimeout: 900,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--port') args.port = Number(process.argv[++i]);
  else if (a === '--cdpport') args.cdpport = Number(process.argv[++i]);
  else if (a === '--studio-port') args.studioPort = Number(process.argv[++i]);
  else if (a === '--preset') args.preset = process.argv[++i];
  else if (a === '--align') args.align = process.argv[++i];
  else if (a === '--validate') args.validate = process.argv[++i];
  else if (a === '--media') args.media = resolve(process.argv[++i]);
  else if (a === '--truth') args.truth = resolve(process.argv[++i]);
  else if (a === '--job-timeout') args.jobTimeout = Number(process.argv[++i]);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function launch(command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: 'ignore', ...options });
  children.push(child);
  return child;
}

function stopAll() {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/F', '/PID', String(c.pid)], { stdio: 'ignore' });
      else c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', stopAll);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function venvPython() {
  const candidates = [
    join(PROJECT_ROOT, '..', 'audio-studio', '.venv', 'Scripts', 'python.exe'),
    join(PROJECT_ROOT, '..', 'audio-studio', '.venv', 'bin', 'python'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function waitForOk(url, { attempts = 60, intervalMs = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(intervalMs);
  }
  return false;
}

async function waitForJson(url, { attempts = 40, intervalMs = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await delay(intervalMs);
  }
  return null;
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      problems.push(`uncaught: ${d?.exception?.description ?? d?.text ?? 'unknown'}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      problems.push(`console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    }
  });
  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  };
  return { send, problems, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) {
    throw new Error(`page threw: ${res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text}`);
  }
  return res?.result?.result?.value;
}

async function waitFor(cdp, expression, predicate = (v) => Boolean(v), { attempts = 60, intervalMs = 250, describe = expression } = {}) {
  let value;
  for (let i = 0; i < attempts; i++) {
    value = await evaluate(cdp, expression);
    if (predicate(value)) return value;
    await delay(intervalMs);
  }
  throw new Error(`waited ${((attempts * intervalMs) / 1000).toFixed(1)}s for ${describe}, last value ${JSON.stringify(value)}`);
}

// --------------------------------------------------------------------------- //
// scoring — the same rule the Python scratch script uses
// --------------------------------------------------------------------------- //

const normalise = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The lyrics, with the time each line is first *introduced*.
 *
 * A rolling SRT repeats the previous lines and adds a new one, so a line is new when it is not in
 * the previous cue. Taking the last line of every cue instead is wrong at the *first* cue, which
 * introduces two lines at once — and dropping the opening lyric silently inflates every WER this
 * tool reports. Which is how this was found: the clock check compared the second caption against a
 * cue that had introduced it, and the six-second disagreement gave the mistake away.
 */
function parseCues(srtText) {
  const cues = [];
  let start = null;
  let block = [];
  const flush = () => {
    if (block.length && start != null) cues.push({ start, lines: [...block] });
    block = [];
    start = null;
  };
  for (const raw of srtText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^\d+$/.test(line)) continue;
    const arrow = line.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->/);
    if (arrow) {
      start = Number(arrow[1]) * 3600 + Number(arrow[2]) * 60 + Number(arrow[3]) + Number(arrow[4]) / 1000;
      continue;
    }
    block.push(line);
  }
  flush();

  const introductions = [];
  let previous = [];
  for (const cue of cues) {
    for (const line of cue.lines) {
      if (!previous.includes(line)) introductions.push({ start: cue.start, line, words: normalise(line).split(' ').filter(Boolean) });
    }
    previous = cue.lines;
  }
  return introductions;
}

function referenceWords(srtText) {
  return parseCues(srtText).flatMap((c) => c.words);
}

function editOps(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i;
  for (let j = 1; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  let i = n;
  let j = m;
  const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) ops.push(['S', ref[i - 1], hyp[j - 1]]);
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push(['D', ref[i - 1], '']);
      i--;
    } else {
      ops.push(['I', '', hyp[j - 1]]);
      j--;
    }
  }
  return ops.reverse();
}

function report(label, ref, hyp) {
  const ops = editOps(ref, hyp);
  const subs = ops.filter((o) => o[0] === 'S');
  const dels = ops.filter((o) => o[0] === 'D');
  const ins = ops.filter((o) => o[0] === 'I');
  const wer = (subs.length + dels.length + ins.length) / Math.max(1, ref.length);
  console.log(`  ${label}`);
  console.log(`    words ${hyp.length} | WER ${(wer * 100).toFixed(1)}%  (S ${subs.length}  D ${dels.length}  I ${ins.length})`);
  const show = (name, arr, fmt) => {
    if (!arr.length) return;
    console.log(`    ${name} ${arr.slice(0, 12).map(fmt).join(', ')}${arr.length > 12 ? ` … +${arr.length - 12}` : ''}`);
  };
  show('wrong ', subs, (o) => `${o[1]}→${o[2]}`);
  show('missed', dels, (o) => o[1]);
  show('added ', ins, (o) => o[2]);
  return wer;
}

// --------------------------------------------------------------------------- //

async function main() {
  for (const [label, path] of [['media', args.media], ['truth', args.truth]]) {
    if (!existsSync(path)) {
      console.error(`no ${label} file at ${path}`);
      process.exit(2);
    }
  }
  const python = venvPython();
  if (!python) {
    console.error('no audio-studio virtualenv found — see audio-studio/README.md');
    process.exit(2);
  }
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('no Chrome found — set CHROME_PATH');
    process.exit(2);
  }

  console.log(`\n=== quality pass ===`);
  console.log(`  media    ${basename(args.media)}`);
  console.log(`  truth    ${basename(args.truth)}`);
  console.log(`  options  preset=${args.preset} align=${args.align} validate=${args.validate}`);

  // The job store must exist; the server creates it, but the cwd has to be the studio.
  const studioRoot = resolve(PROJECT_ROOT, '..', 'audio-studio');
  mkdirSync(join(studioRoot, 'jobs'), { recursive: true });

  console.log(`\n■ booting the real python studio on :${args.studioPort}`);
  launch(python, ['-m', 'audio_studio', 'serve', '--port', String(args.studioPort)], { cwd: studioRoot });
  const health = await waitForJson(`http://127.0.0.1:${args.studioPort}/health`, { attempts: 80, intervalMs: 500 });
  if (!health) {
    console.error('the audio-studio server never answered /health');
    process.exit(2);
  }
  console.log(`  ✔ audio-studio ${health.version} up (engines: ${(health.engines ?? []).map((e) => e.name).join(', ')})`);
  console.log(`  ✔ aligners: ${(health.aligners ?? []).map((a) => `${a.name}${a.available ? '' : '(unavailable)'}`).join(', ')}`);
  console.log(`  ✔ validators: ${(health.validators ?? []).map((v) => `${v.name}${v.available ? '' : '(unavailable)'}`).join(', ')}`);

  console.log(`\n■ booting the editor and headless Chrome`);
  launch(process.execPath, [resolve(PROJECT_ROOT, 'tools/serve.mjs'), String(args.port), '..'], { cwd: PROJECT_ROOT });
  const pageUrl = `http://localhost:${args.port}/caption-studio/index.html`;
  if (!(await waitForOk(pageUrl, { attempts: 40 }))) {
    console.error(`the dev server never served ${pageUrl}`);
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'caption-studio-quality-'));
  launch(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--disable-features=Translate,BackForwardCache',
    '--window-size=1500,1100',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${args.cdpport}`,
    pageUrl,
  ]);

  const version = await waitForJson(`http://127.0.0.1:${args.cdpport}/json/version`);
  if (!version) {
    console.error('headless Chrome never exposed its debugging port');
    process.exit(2);
  }
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await waitForJson(`http://127.0.0.1:${args.cdpport}/json/list`, { attempts: 1 });
    target = (list ?? []).find((t) => t.type === 'page' && t.url.includes('index.html'));
    if (!target) await delay(250);
  }
  if (!target?.webSocketDebuggerUrl) {
    console.error('could not find the editor page target');
    process.exit(2);
  }
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await delay(1500);
  console.log('  ✔ editor page up');

  // --- point the panel at the real studio ---------------------------------- //
  console.log(`\n■ pointing the panel at the real studio`);
  await evaluate(cdp, `(()=>{const i=document.querySelector('#transcribe-url');i.value='http://127.0.0.1:${args.studioPort}';return i.value})()`);
  await evaluate(cdp, 'document.querySelector("#transcribe-probe").click()');
  const badge = await waitFor(cdp, 'document.querySelector("#transcribe-status").textContent', (v) => String(v).includes('audio-studio'), {
    attempts: 120,
    describe: 'the health probe to answer',
  });
  console.log(`  ✔ badge: ${badge}`);

  // --- upload the real song, through the real page -------------------------- //
  console.log(`\n■ uploading ${basename(args.media)} through the transcribe panel`);
  const select = async (id, value) => {
    const ok = await evaluate(
      cdp,
      `(()=>{const s=document.querySelector('#${id}');const want=${JSON.stringify(value)};const opt=[...s.options].find(o=>o.value===want);if(!opt)return 'no option '+want+' in '+[...s.options].map(o=>o.value).join('/');s.value=want;s.dispatchEvent(new Event('change'));return true})()`,
    );
    if (ok !== true) throw new Error(`could not set #${id}: ${ok}`);
  };
  await select('transcribe-preset', args.preset);
  await select('transcribe-align', args.align);
  await select('transcribe-validate', args.validate);

  const mediaName = basename(args.media);
  const picked = await evaluate(
    cdp,
    `(async()=>{
       const name = ${JSON.stringify(mediaName)};
       const res = await fetch('/referece_material/' + encodeURIComponent(name));
       if (!res.ok) return 'fetch ' + res.status;
       const blob = await res.blob();
       const dt = new DataTransfer();
       dt.items.add(new File([blob], name, { type: blob.type || 'audio/mpeg' }));
       const input = document.querySelector('#transcribe-in');
       input.files = dt.files;
       input.dispatchEvent(new Event('change'));
       return input.files.length + ' file(s), ' + blob.size + ' bytes';
     })()`,
  );
  console.log(`  ✔ recording chosen: ${picked}`);

  await evaluate(cdp, 'document.querySelector("#transcribe-btn").click()');
  console.log(`  … transcribing (preset ${args.preset}, align ${args.align}) — this is the slow part`);
  const started = Date.now();
  // Wait for a verdict, not for success. A pass that has *failed* is news, and waiting the full
  // timeout for a job that already reported an error hides it for fifteen minutes.
  const settled = await waitFor(
    cdp,
    'document.querySelector("#transcribe-status").textContent',
    (v) => v === 'done' || v === 'failed',
    { attempts: args.jobTimeout, intervalMs: 1000, describe: 'the transcribe job' },
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  if (settled === 'failed') {
    const note = await evaluate(cdp, 'document.querySelector("#transcribe-note").textContent');
    console.error(`\n  ✖ the job failed after ${elapsed}s:\n${note}`);
    const jobs = await waitForJson(`http://127.0.0.1:${args.studioPort}/jobs`, { attempts: 3, intervalMs: 200 });
    const err = jobs?.jobs?.[0]?.error;
    if (err) console.error(`\n  server error:\n${err}`);
    console.error('\n  the pipeline itself is fine — re-run with --validate off to skip the hosted pass');
    cdp.close();
    stopAll();
    process.exit(1);
  }
  console.log(`  ✔ job finished in ${elapsed}s`);

  const audit = await evaluate(cdp, 'document.querySelector("#transcribe-note").textContent');
  console.log('\n■ provenance the studio reported');
  for (const line of String(audit).split('\n').filter(Boolean)) console.log(`  ${line}`);

  // The AI source is a *source*, not a displayed document: both this path and importing an AI
  // file from disk only put it in the store, because the editor's model is "correct an AI
  // transcript against a trusted subtitle file". So `#blocks` is legitimately empty here, and the
  // caption text only becomes visible once the correction has run. Reporting it as 0 captions
  // scored against the lyrics would be a harness bug, not a finding.
  const shownAfterTranscribe = await evaluate(cdp, 'document.querySelectorAll("#blocks .row").length');
  console.log(`\n■ the caption list after transcribing: ${shownAfterTranscribe} block(s)`);
  console.log(
    shownAfterTranscribe === 0
      ? '  (by design — the AI source is an input; the editor displays the corrected document,\n' +
        '   so there is nothing to score until the correction below has run)'
      : '  (the editor is showing the transcription directly)',
  );

  const ref = referenceWords(readFileSync(args.truth, 'utf8'));
  console.log(`\n■ reference lyrics from ${basename(args.truth)}: ${ref.length} words`);

  // --- now the quality correction, with the reference lyrics as TRUTH -------- //
  console.log(`\n■ running the quality correction with ${basename(args.truth)} as TRUTH`);
  const truthText = readFileSync(args.truth, 'utf8');
  await evaluate(
    cdp,
    `(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(truthText)}], ${JSON.stringify(basename(args.truth))}, {type:'text/plain'}));const i=document.querySelector('#truth-in');i.files=dt.files;i.dispatchEvent(new Event('change'));return i.files.length})()`,
  );
  const unlocked = await waitFor(cdp, 'document.querySelector("#align-btn").disabled', (v) => v === false, {
    attempts: 40,
    describe: 'the correction button to unlock',
  });
  if (unlocked === false) console.log('  ✔ the transcribed AI source unlocked the correction');
  await evaluate(cdp, 'document.querySelector("#align-btn").click()');
  await waitFor(cdp, 'document.querySelector("#report").textContent.includes("Anchors")', (v) => v === true, {
    attempts: 120,
    describe: 'the quality correction to finish',
  });
  const reportText = await evaluate(cdp, 'document.querySelector("#report").textContent');
  console.log(`  ✔ correction finished: ${String(reportText).replace(/\s+/g, ' ').slice(0, 160)}`);

  const afterAlign = await evaluate(
    cdp,
    '[...document.querySelectorAll("#blocks .row")].map(r=>({t:r.querySelector(".t").textContent,text:r.querySelector(".body").childNodes[0].textContent}))',
  );
  console.log(`\n■ corrected captions: ${afterAlign.length} block(s)`);
  for (const b of afterAlign.slice(0, 5)) console.log(`  ${b.t.replace(/\s/g, '')}  ${b.text.slice(0, 60)}`);

  console.log('');
  const werCorrected = report('corrected (spelling authority: the TRUTH file)', ref, afterAlign.flatMap((b) => normalise(b.text).split(' ').filter(Boolean)));

  // --- what the clock did --------------------------------------------------- //
  // Compare each early caption with the TRUTH cue that carries its own words. Asking "did it follow
  // the measured onset or the cue boundary" only means something for a caption whose text came from
  // a cue: comparing the *first* block to cue 1 would compare the hallucinated lead-in (there is one
  // on this song) with a lyric it has nothing to do with.
  const cues = parseCues(readFileSync(args.truth, 'utf8'));
  console.log(`\n■ the clock: did the caption follow the measurement or the cue?`);
  console.log('  (the cue time is when that line is first *introduced* by the rolling file, and on a')
  console.log('   rolling SRT that is the cue where it first appears, not the cue that repeats it)');
  let compared = 0;
  for (const b of afterAlign) {
    const words = normalise(b.text).split(' ').filter(Boolean);
    if (words.length < 3) continue;
    const cue = cues.find((c) => c.words.slice(0, words.length).join(' ').startsWith(words.slice(0, 6).join(' ')));
    if (!cue) continue;
    const start = Number(String(b.t).split('–')[0]);
    const delta = start - cue.start;
    const verdict = Math.abs(delta) < 0.35 ? 'the cue boundary' : delta > 0 ? 'the measured onset (later than the cue)' : 'earlier than the cue';
    console.log(`  ${b.t.replace(/\s/g, '')}  "${b.text.slice(0, 40)}"  cue at ${cue.start.toFixed(2)}s  Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s → ${verdict}`);
    if (++compared === 4) break;
  }
  if (!compared) console.log('  (no caption matched a cue closely enough to compare)');

  const problems = cdp.problems.filter((p) => !/favicon|ERR_/i.test(p));
  if (problems.length) {
    console.log('\n■ page problems');
    for (const p of problems.slice(0, 10)) console.log(`  ✖ ${p}`);
  } else {
    console.log('\n■ no uncaught exceptions or console errors');
  }

  console.log(`\n=== quality: ${(werCorrected * 100).toFixed(1)}% WER for the document the editor displays ===`);
  cdp.close();
  stopAll();
}

main().catch((err) => {
  console.error(`\nquality pass failed: ${err.message}`);
  stopAll();
  process.exit(1);
});
