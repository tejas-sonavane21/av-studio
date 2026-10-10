/**
 * ui-smoke.mjs — drives the real editor page in headless Chrome and reports what breaks.
 *
 * `main.js` is the one module no unit test can cover: it only exists as browser side effects on
 * `index.html`. So the wiring added in Phase 4 (template picker, block inspector, overlay drag) is
 * exercised here the way a user would: click the demo, pick a template, edit a control, drag the
 * caption, and fail loudly on any uncaught exception or console error.
 *
 * Usage: node tools/ui-smoke.mjs [--port 8123] [--cdpport 9333]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');

const args = { port: 8123, cdpport: 9333, timeout: 60 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--port') args.port = Number(process.argv[++i]);
  else if (a === '--cdpport') args.cdpport = Number(process.argv[++i]);
  else if (a === '--timeout') args.timeout = Number(process.argv[++i]);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let stubState = { polls: 0, uploadBytes: 0, uploads: [] };

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

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) {
    throw new Error(`page threw: ${res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text}`);
  }
  return res?.result?.result?.value;
}

const failures = [];

/**
 * Assert something about the *harness*, not the page.
 *
 * `check()` evaluates its expression inside the page, so it cannot see the stand-in server's own
 * counters — and passing a value instead of an expression to it does not fail loudly, it evaluates
 * the value as JavaScript. (It did: `"recording.wav"` reached the page as an expression and threw
 * `ReferenceError`.) Anything the browser cannot observe belongs here.
 */
function assert(label, ok, detail = '') {
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(label);
  return ok;
}

async function check(cdp, label, expression, predicate, describe) {
  const value = await evaluate(cdp, expression);
  const ok = predicate ? predicate(value) : Boolean(value);
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${ok ? '' : ` — got ${JSON.stringify(value)}${describe ? `, wanted ${describe}` : ''}`}`);
  if (!ok) failures.push(label);
  return value;
}

/**
 * Wait until the page satisfies a condition, then return the value that satisfied it.
 *
 * A `delay()` before a check is a guess about how long the page needs, and a guess that is too
 * short is a *false failure* — the worst kind, because it teaches the reader to distrust the run.
 * Both things this harness waits on longest depend on font loading rather than on the code:
 * laying out the demo document was measured at ~1.3 s while the check allowed 1.2 s, so the whole
 * suite reported "the demo document did not load" on a build where it loaded fine. Every wait
 * below is therefore a condition, so what is reported is whether it *ever* happened.
 */
async function waitFor(
  cdp,
  expression,
  predicate = (v) => Boolean(v),
  { attempts = 60, intervalMs = 100, describe = expression } = {},
) {
  let value;
  for (let i = 0; i < attempts; i++) {
    value = await evaluate(cdp, expression);
    if (predicate(value)) return value;
    await delay(intervalMs);
  }
  throw new Error(`waited ${((attempts * intervalMs) / 1000).toFixed(1)}s for ${describe}, last value ${JSON.stringify(value)}`);
}

/**
 * A stand-in for the Python studio's HTTP surface.
 *
 * The wiring this exercises is browser-side, and the piece most likely to break is the part no unit
 * test can reach: a real `fetch` from a real page, across origins, with a preflight, sending a
 * `File` as the body, then polling. Stubbing the *provider* here is the point — the client, the
 * importer and the editor are all the real ones.
 */
function startStubStudio() {
  const veed = {
    version: '3.0',
    generator: 'audio-studio/stub',
    engine: { name: 'faster-whisper', model: 'small', preset: 'balanced' },
    projectId: 'stub',
    canvas: { width: 1280, height: 720 },
    style: { font: 'Inter', fontSize: 0.036, posX: 0.772, posY: 0.848, align: 'center' },
    subtitles: [
      {
        start: 12.0,
        end: 16.0,
        words: [
          { text: 'Just', s: 12.0, e: 12.6, p: 0.71 },
          { text: 'an', s: 12.7, e: 12.9, p: 0.55 },
          // deliberately wrong, so the TRUTH subtitle below has something to correct
          { text: 'ordnary', s: 13.0, e: 13.8, p: 0.62 },
          { text: 'boy', s: 14.0, e: 14.6, p: 0.8 },
        ],
        styles: [],
      },
      {
        start: 16.0,
        end: 20.0,
        words: [
          { text: 'lost', s: 16.0, e: 16.5, p: 0.7 },
          { text: 'in', s: 16.6, e: 16.75, p: 0.6 },
          { text: 'the', s: 16.8, e: 17.0, p: 0.9 },
          { text: 'crowd', s: 17.2, e: 18.0, p: 0.75 },
        ],
        styles: [],
      },
    ],
    audioStudio: {
      alignment: {
        aligner: 'wav2vec',
        backend: 'wav2vec2',
        model: 'facebook/wav2vec2-base-960h',
        segments: 2,
        segmentsAligned: 2,
        wordsAligned: 8,
        meanConfidence: 0.57,
        meanShift: 0.21,
        wordsClamped: 0,
      },
      validation: {
        passes: [
          { validator: 'llm', corrections: 0, applied: 0, outcomes: {}, highlights: [2, 5], highlightedWords: ['night', 'light'] },
        ],
      },
      corrections: [],
      warnings: ['2 of 2 segments were aligned with a synthetic stand-in'],
      language: 'en',
      duration: 20.0,
    },
  };

  const state = { polls: 0, uploadBytes: 0, uploads: [], requests: [] };
  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'content-type': type,
        'content-length': String(Buffer.byteLength(payload)),
        // the page is on a different origin, exactly as it is in real life
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      });
      res.end(payload);
    };

    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}`);

    if (req.method === 'OPTIONS') return send(204, '');

    if (url.pathname === '/health') {
      return send(200, {
        ok: true,
        version: '9.9.9',
        engines: [{ name: 'whisper', backend: 'faster-whisper', available: true, reason: 'stand-in' }],
        aligners: [{ name: 'wav2vec', backend: 'wav2vec2', available: true, reason: 'stand-in' }],
        validators: [{ name: 'rules', backend: 'rules', available: true, reason: 'stand-in' }],
        presets: ['fast', 'balanced', 'accurate'],
        defaultPreset: 'balanced',
        emitKinds: ['json', 'veed', 'srt', 'vtt'],
      });
    }

    if (url.pathname === '/transcribe/upload') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        state.uploadBytes = Buffer.concat(chunks).length;
        state.uploads.push({ name: url.searchParams.get('name'), query: url.search });
        send(202, { jobId: 'stub-job', status: 'queued', progress: 0, align: url.searchParams.get('align') });
      });
      return undefined;
    }

    if (url.pathname === '/jobs/stub-job') {
      state.polls += 1;
      if (state.polls === 1) {
        return send(200, { jobId: 'stub-job', status: 'running', progress: 0.5, message: 'halfway' });
      }
      return send(200, {
        jobId: 'stub-job',
        status: 'done',
        progress: 1,
        message: 'done',
        seconds: 1.25,
        files: { veed: 'stub.veed.json' },
        urls: { veed: '/jobs/stub-job/veed' },
        summary: { segments: 2, words: 8, seconds: 1.25, warnings: ['a stand-in wrote this'] },
      });
    }

    if (url.pathname === '/jobs/stub-job/veed') return send(200, veed);

    return send(404, { error: `no route for ${url.pathname}` });
  });

  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ port, state, close: () => server.close() });
    });
  });
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('no Chrome found — set CHROME_PATH');
    process.exit(2);
  }

  launch(process.execPath, [resolve(PROJECT_ROOT, 'tools/serve.mjs'), String(args.port), '..'], { cwd: PROJECT_ROOT });
  const pageUrl = `http://localhost:${args.port}/caption-studio/index.html`;
  if (!(await waitForOk(pageUrl, { attempts: 40 }))) {
    console.error(`the dev server never served ${pageUrl}`);
    process.exit(2);
  }

  const profile = mkdtempSync(join(tmpdir(), 'caption-studio-smoke-'));
  launch(
    chromePath,
    [
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
    ],
  );

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
  await delay(1500); // let modules load and fonts settle

  console.log('\n■ boot');
  await check(cdp, 'the app booted and rendered the log', 'document.querySelectorAll("#log").length', (v) => v === 1);
  await check(
    cdp,
    'all ten templates are painted as tiles',
    'document.querySelectorAll("#templates .tile").length',
    (v) => v === 10,
    '10',
  );
  await check(
    cdp,
    'tiles are grouped by origin',
    '[...document.querySelectorAll("#templates .origin-heading")].map(e=>e.textContent).join("|")',
    (v) => v === 'veed (3)|capcut (4)|generic (3)',
  );
  await check(cdp, 'no document loaded yet → inspector is empty', 'document.querySelector("#block-inspector").className', (v) => v === 'empty');
  await check(cdp, 'the preview owns an audio element', 'document.querySelectorAll("#preview-audio").length', (v) => v === 1);
  await check(
    cdp,
    'the audio input accepts audio files',
    'document.querySelector("#audio-in").getAttribute("accept")',
    (v) => v === 'audio/*',
  );
  await check(
    cdp,
    'the lyrics input takes subtitles and plain text',
    'document.querySelector("#lyrics-in").getAttribute("accept")',
    (v) => v === '.srt,.vtt,.txt,text/plain',
  );
  await check(
    cdp,
    'and nothing pretends to be loaded before it is',
    'document.querySelector("#audio-tag").textContent',
    (v) => v === 'no audio',
  );

  await check(
    cdp,
    'the timeline draws a lane for the captions, the picture and the sound',
    '[...document.querySelectorAll("#timeline .timeline-track")].map((t)=>t.className.replace("timeline-track","").trim()).join("|")',
    (v) => v === 'captions|video|audio',
  );
  await check(
    cdp,
    'and says it is empty before a document exists',
    'document.querySelector("#timeline .timeline-empty").hidden',
    (v) => v === false,
  );
  await check(
    cdp,
    'the timeline offers the cut commands',
    '[...document.querySelectorAll("#timeline .timeline-actions button")].map((b)=>b.dataset.command).join("|")',
    (v) => v === 'split|cut-left|cut-right|delete|reset',
  );
  await check(
    cdp,
    'the transport has a switch for each sound source plus a master mute',
    'document.querySelectorAll("#video-audio-toggle, #audio-audio-toggle, #mute-toggle").length',
    (v) => v === 3,
  );
  await check(
    cdp,
    'the sidebar offers the three workflows as tabs',
    '[...document.querySelectorAll(".tabs [role=tab]")].map((b)=>b.dataset.tab).join("|")',
    (v) => v === 'sources|transcribe|export',
  );
  await check(
    cdp,
    'with exactly one of them showing',
    '[...document.querySelectorAll(".tab-panel")].filter((p)=>!p.hidden).length',
    (v) => v === 1,
  );
  await check(
    cdp,
    'and the export window is built, MP4 by default',
    'document.querySelector("#export-dialog-format").value',
    (v) => v === 'mp4',
  );
  await check(
    cdp,
    'the export window offers every resolution preset',
    '[...document.querySelectorAll("#export-dialog-resolution option")].map((o)=>o.value).join("|")',
    (v) => v === 'source|480p|720p|1080p|1440p|2160p',
  );

  console.log('\n■ demo document');
  await evaluate(cdp, 'document.querySelector("#demo-btn").click()');
  await waitFor(cdp, 'document.querySelector("#stage").className', (v) => String(v).includes('has-content'), {
    describe: 'the demo document to be laid out',
  });
  await check(cdp, 'the stage reports content', 'document.querySelector("#stage").className', (v) => String(v).includes('has-content'));
  await check(
    cdp,
    'the block list is populated from the document',
    'document.querySelectorAll("#blocks .row").length',
    (v) => v >= 3,
  );
  await check(cdp, 'a block row is selected by default', 'document.querySelectorAll("#blocks .row.active").length', (v) => v === 1);
  await check(
    cdp,
    'the inspector built its controls',
    'document.querySelectorAll("#block-inspector .inspector-grid .field-inline").length',
    (v) => v >= 12,
    '≥12',
  );
  await check(
    cdp,
    'the inspector offers all nine anchor presets plus inherit/custom',
    'document.querySelectorAll("#block-inspector .inspector-grid select")[1].options.length',
    (v) => v === 11,
    '11',
  );
  await check(cdp, 'the parity template is marked active', 'document.querySelectorAll("#templates .tile.active").length', (v) => v === 1);
  await check(
    cdp,
    'and the status line names it',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('Veed'),
  );

  console.log('\n■ timeline');
  await check(
    cdp,
    'the timeline drew one clip per caption',
    'document.querySelectorAll("#timeline .timeline-clip").length === document.querySelectorAll("#blocks .row").length',
    (v) => v === true,
  );
  await check(
    cdp,
    'the timeline status counts them',
    'document.querySelector("#timeline-status").textContent',
    (v) => /\d+ caption/.test(String(v)),
  );
  await check(
    cdp,
    'a ruler is drawn with time ticks',
    'document.querySelectorAll("#timeline .timeline-tick.major").length',
    (v) => v >= 2,
  );
  await check(
    cdp,
    'the empty hint is hidden now there are captions',
    'document.querySelector("#timeline .timeline-empty").hidden',
    (v) => v === true,
  );
  // Clicking a clip is the two things an editor expects at once: select that caption, and put the
  // playhead on it. Both are checked, because either one alone would be a confusing half-behaviour.
  await evaluate(cdp, 'document.querySelectorAll("#timeline .timeline-clip")[1].click()');
  await delay(250);
  await check(
    cdp,
    'clicking a clip selects its caption',
    'document.querySelectorAll("#timeline .timeline-clip.active").length',
    (v) => v === 1,
  );
  await check(
    cdp,
    'and scrubs the playhead into it',
    'Number(document.querySelector("#seek").value) > 0',
    (v) => v === true,
  );
  await check(
    cdp,
    'the zoom button widens the strip',
    '(()=>{const inner=document.querySelector("#timeline .timeline-inner");const before=parseFloat(inner.style.width)||0;[...document.querySelectorAll("#timeline .timeline-toolbar button")].find(b=>b.textContent==="+").click();return parseFloat(inner.style.width)>before})()',
    (v) => v === true,
  );
  await evaluate(cdp, '[...document.querySelectorAll("#timeline .timeline-toolbar button")].find(b=>b.textContent==="Fit").click()');

  // ---- the cut -------------------------------------------------------------
  // Everything below is driven through the strip's own buttons and handles, so what is tested is the
  // path a user takes rather than a function called directly.
  const lane = (track) =>
    `document.querySelectorAll('#timeline .timeline-track.${track} .timeline-segment').length`;
  const clickCommand = (command) =>
    `document.querySelector('#timeline .timeline-actions button[data-command="${command}"]').click()`;
  const statusText = 'document.querySelector("#timeline-status").textContent';

  await check(cdp, 'the picture lane starts as one uncut clip', lane('video'), (v) => v === 1);
  await check(cdp, 'and so does the sound lane', lane('audio'), (v) => v === 1);
  await check(cdp, 'the status line reports the whole recording while nothing is cut', statusText, (v) =>
    /\d+ captions?$/.test(String(v)),
  );

  await evaluate(cdp, clickCommand('split'));
  await delay(150);
  await check(cdp, 'Split cuts the picture lane at the playhead', lane('video'), (v) => v === 2);
  await check(cdp, 'and puts the same cut in the sound lane', lane('audio'), (v) => v === 2);

  await evaluate(cdp, clickCommand('cut-right'));
  await delay(150);
  await check(cdp, 'Cut right drops everything after the playhead', lane('video'), (v) => v === 1);
  await check(
    cdp,
    'and the status line now reports a file shorter than the recording',
    statusText,
    (v) => /\d+\.\ds of \d+\.\ds after the cuts/.test(String(v)),
  );
  await check(
    cdp,
    'a caption the cut removed is dimmed on the strip rather than deleted from the document',
    'document.querySelectorAll("#timeline .timeline-clip.dropped").length',
    (v) => v >= 1,
  );

  // A trim, through a real drag on the clip's own edge handle.
  const trim = await evaluate(
    cdp,
    `(()=>{
      const seg = document.querySelector('#timeline .timeline-track.video .timeline-segment');
      const before = seg.getBoundingClientRect().width;
      const handle = seg.querySelector('.timeline-handle.right');
      const r = handle.getBoundingClientRect();
      const at = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true });
      const scroll = document.querySelector('#timeline .timeline-scroll');
      scroll.setPointerCapture = () => {};
      handle.dispatchEvent(new PointerEvent('pointerdown', at(r.left + r.width / 2)));
      scroll.dispatchEvent(new PointerEvent('pointermove', at(r.left - 60)));
      scroll.dispatchEvent(new PointerEvent('pointerup', at(r.left - 60)));
      const after = document.querySelector('#timeline .timeline-track.video .timeline-segment').getBoundingClientRect().width;
      return { before, after };
    })()`,
  );
  assert(
    'dragging a clip\u2019s edge trims it shorter',
    trim.after < trim.before - 5,
    `was ${trim.before}px, now ${trim.after}px`,
  );

  await evaluate(cdp, 'document.querySelector("#timeline .timeline-track.video .timeline-segment").click()');
  await delay(150);
  await check(
    cdp,
    'clicking a picture clip selects it',
    'document.querySelectorAll("#timeline .timeline-segment.active").length',
    (v) => v === 1,
  );
  await evaluate(cdp, clickCommand('delete'));
  await delay(150);
  await check(cdp, 'Delete removes the selected clip', lane('video'), (v) => v === 0);

  await evaluate(cdp, clickCommand('reset'));
  await delay(150);
  await check(cdp, 'Reset cuts puts the whole recording back', lane('video'), (v) => v === 1);
  await check(cdp, 'and the sound lane with it', lane('audio'), (v) => v === 1);
  await check(
    cdp,
    'and no caption is left dimmed',
    'document.querySelectorAll("#timeline .timeline-clip.dropped").length',
    (v) => v === 0,
  );

  console.log('\n■ templates');
  await evaluate(cdp, '[...document.querySelectorAll("#templates .tile")].find(t=>t.dataset.id==="veed-karaoke").click()');
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => String(v).includes('Karaoke'), {
    describe: 'the karaoke template to be applied',
  });
  await check(
    cdp,
    'clicking a tile applies it',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('Karaoke'),
  );
  await check(
    cdp,
    'the karaoke template reaches the style controls',
    'document.querySelector("#emphasis-source").value',
    (v) => v === 'active',
  );
  await check(cdp, 'the active tile moved', 'document.querySelector("#templates .tile.active").dataset.id', (v) => v === 'veed-karaoke');
  // A burst of clicks is the re-entrancy case: every `useTemplate` awaits font loading, so without a
  // guard the last one to *finish* would own the UI rather than the last one to be asked for.
  await evaluate(cdp, '(()=>{for(const t of [...document.querySelectorAll("#templates .tile")])t.click();})()');
  await waitFor(cdp, 'document.querySelector("#templates .tile.active").dataset.id', (v) => v === 'shorts-impact', {
    describe: 'the burst of template clicks to settle on the last one asked for',
  });
  await check(cdp, 'a burst of template clicks settles on the last one asked for', 'document.querySelector("#templates .tile.active").dataset.id', (v) => v === 'shorts-impact');
  await check(
    cdp,
    'and the style controls agree with the picker',
    'document.querySelector("#font-family").value',
    (v) => v === 'Anton',
    'Anton (shorts-impact)',
  );
  await check(
    cdp,
    'the document is exactly on that template, not an edited mixture',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('Shorts') && !String(v).includes('edited'),
  );

  console.log('\n■ per-block overrides');
  await evaluate(cdp, '[...document.querySelectorAll("#templates .tile")].find(t=>t.dataset.id==="veed-auto-highlight").click()');
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => String(v).includes('Veed'), {
    describe: 'the parity template to be applied again',
  });
  const fillIndex = await evaluate(
    cdp,
    '[...document.querySelectorAll("#block-inspector .field-inline")].findIndex(f=>f.textContent.trim().startsWith("Fill"))',
  );
  await evaluate(
    cdp,
    `(()=>{const f=[...document.querySelectorAll("#block-inspector .field-inline")][${fillIndex}];const i=f.querySelector("input");i.value="#ff00aa";i.dispatchEvent(new Event("change"));})()`,
  );
  await delay(400);
  await check(
    cdp,
    'the block row reports the override, and only that row',
    '[...document.querySelectorAll("#blocks .row")].map(r=>[...r.querySelectorAll(".tag")].some(t=>/override/.test(t.textContent)))',
    (v) => Array.isArray(v) && v.filter(Boolean).length === 1,
    'exactly one row',
  );
  await check(
    cdp,
    'a per-block override does NOT make the document an edited template',
    'document.querySelector("#template-status").textContent',
    (v) => !String(v).includes('edited'),
  );
  await check(
    cdp,
    '"apply look to all captions" promotes it into the document (now edited)',
    '(()=>{document.querySelector("#apply-to-all").click();return document.querySelector("#template-status").textContent})()',
    (v) => String(v).includes('edited'),
  );
  await check(
    cdp,
    'and it clears the block override',
    '[...document.querySelectorAll("#blocks .row")].every(r=>![...r.querySelectorAll(".tag")].some(t=>/override/.test(t.textContent)))',
    (v) => v === true,
  );

  console.log('\n■ drag placement');
  const box = await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#preview-canvas").getBoundingClientRect();return {left:c.left,top:c.top,width:c.width,height:c.height}})()',
  );
  const cover = await evaluate(
    cdp,
    '(()=>{const o=document.querySelector("#overlay-canvas").getBoundingClientRect();const c=document.querySelector("#preview-canvas").getBoundingClientRect();return {ox:o.left,oy:o.top,ow:o.width,oh:o.height,cx:c.left,cy:c.top,cw:c.width,ch:c.height}})()',
  );
  const covers = cover.ox <= cover.cx + 1 && cover.oy <= cover.cy + 1 && cover.ow >= cover.cw - 1 && cover.oh >= cover.ch - 1;
  console.log(`${covers ? '  ✔' : '  ✖'} the overlay canvas covers the preview canvas (${JSON.stringify(cover)})`);
  if (!covers) failures.push('the overlay canvas does not cover the preview canvas');
  await evaluate(cdp, 'document.querySelector("#blocks .row").click()');
  await delay(300);
  await check(
    cdp,
    'the captions are laid out, so there is something to hit-test',
    '(()=>{const c=document.querySelector("#preview-canvas");return c.width>0&&c.height>0})()',
    (v) => v === true,
  );
  const before = await evaluate(cdp, 'document.querySelector("#block-status").textContent');
  const anchorX = box.left + 0.772 * box.width;
  const anchorY = box.top + 0.848 * box.height;
  const mouse = (type, x, y, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...extra });
  await evaluate(
    cdp,
    'window.__hits=[];document.querySelector("#overlay-canvas").addEventListener("pointerdown",e=>window.__hits.push([e.clientX,e.clientY]))',
  );
  await mouse('mousePressed', anchorX, anchorY);
  await mouse('mouseMoved', anchorX + 40, anchorY + 14);
  await mouse('mouseMoved', anchorX + 90, anchorY + 30);
  await mouse('mouseReleased', anchorX + 90, anchorY + 30);
  await delay(600);
  await check(
    cdp,
    'the overlay receives the pointer events',
    'window.__hits.length',
    (v) => v === 1,
    '1',
  );
  await check(
    cdp,
    'dragging the caption moved its anchor',
    'document.querySelector("#block-status").textContent',
    (v) => v !== before,
    `something other than "${before}"`,
  );
  await check(cdp, 'and the block now carries a position override', 'document.querySelector("#blocks .row.active .tag:last-child").textContent', (v) => Boolean(v));

  console.log('\n■ apply-to-all drag');
  // Put the caption the drag above moved back on the default, so it sits where the pointer lands.
  await evaluate(cdp, 'document.querySelector("#reset-block").click()');
  await delay(300);
  // Record where a caption that will NOT be dragged sits, then drag a different one with the
  // option on and see whether it moved too.
  await evaluate(cdp, 'document.querySelectorAll("#blocks .row")[1].click()');
  await delay(300);
  const neighbourBefore = await evaluate(cdp, 'document.querySelector("#block-status").textContent');
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#drag-all-toggle");c.checked=true;c.dispatchEvent(new Event("change"));})()',
  );
  await evaluate(cdp, 'document.querySelectorAll("#blocks .row")[0].click()');
  await delay(300);
  await mouse('mousePressed', anchorX, anchorY);
  await mouse('mouseMoved', anchorX - 60, anchorY - 40);
  await mouse('mouseReleased', anchorX - 60, anchorY - 40);
  await delay(600);
  await evaluate(cdp, 'document.querySelectorAll("#blocks .row")[1].click()');
  await delay(300);
  await check(
    cdp,
    '"drag all captions" moves a caption that was never grabbed',
    'document.querySelector("#block-status").textContent',
    (v) => v !== neighbourBefore,
    `something other than "${neighbourBefore}"`,
  );
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#drag-all-toggle");c.checked=false;c.dispatchEvent(new Event("change"));})()',
  );

  console.log('\n■ reset paths');
  await check(
    cdp,
    '"reset this block" clears the override',
    '(()=>{document.querySelector("#reset-block").click();return document.querySelector("#block-status").textContent})()',
    (v) => String(v).includes('inherit'),
  );
  await evaluate(cdp, 'document.querySelector("#reset-style").click()');
  // Applying a template awaits font loading, so the status line is read as a
  // condition rather than after a guessed pause.
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => String(v).includes('Veed'), {
    describe: 'the parity reset to be applied',
  });
  await check(cdp, 'the parity reset button restores the verified look', 'document.querySelector("#template-status").textContent', (v) => String(v).includes('Veed'));

  console.log('\n■ control scope (apply a setting to every caption)');
  // `#block-inspector` used to be left unclosed in the markup, silently nesting the transcribe, export
  // and sources panels inside it. Nothing asserted the layout, so nothing caught it. This does — and
  // the count is asked of `main section.panel` rather than of `main > section.panel`, because the
  // panels now live inside `.workspace` and the sidebar deliberately, which is not nesting either.
  await check(
    cdp,
    'every panel lives inside main, and none is nested in another',
    'document.querySelectorAll("main section.panel").length + "/" + document.querySelectorAll("section.panel section.panel").length',
    (v) => v === '9/0',
    '9 panels, 0 nested',
  );
  await check(
    cdp,
    'the preview style bar is grouped into labelled sections',
    '[...document.querySelectorAll(".style-sections .style-section-head")].map(h=>h.textContent).join("|")',
    (v) => v === 'Frame|Type|Emphasis|Animation',
  );
  await check(
    cdp,
    'the look settings that had no global home now have one',
    '["#font-case","#fill-color","#display-mode","#anim-in","#anim-out"].every(s=>document.querySelector(s))',
    (v) => v === true,
  );
  await check(
    cdp,
    'and the animation pickers carry the real preset vocabulary',
    'document.querySelector("#anim-in").options.length',
    (v) => v >= 2,
  );
  await check(
    cdp,
    'the inspector reads as labelled sections',
    '[...document.querySelectorAll("#block-inspector .inspector-section")].map(e=>e.textContent).join("|")',
    (v) => v === 'Content|Placement|Look|Animation',
  );
  await check(cdp, 'the scope toggle starts off — edits are per-block by default', 'document.querySelector("#style-all-toggle").checked', (v) => v === false);

  // The heart of it: with the scope ON, one setting reaches every caption — and *only* that setting.
  // Two overrides are placed on one block first, so the apply has something to leave alone.
  const setCase = (value) =>
    `(()=>{const f=[...document.querySelectorAll("#block-inspector .field-inline")].find(f=>f.textContent.trim().startsWith("Case"));const s=f.querySelector("select");s.value="${value}";s.dispatchEvent(new Event("change"));})()`;
  await evaluate(cdp, 'document.querySelectorAll("#blocks .row")[0].click()');
  await delay(200);
  await evaluate(cdp, 'document.querySelector("#reset-block").click()');
  await delay(200);
  await evaluate(cdp, setCase('lower'));
  await evaluate(
    cdp,
    '(()=>{const f=[...document.querySelectorAll("#block-inspector .field-inline")].find(f=>f.textContent.trim().startsWith("Fill"));const i=f.querySelector("input");i.value="#ff00aa";i.dispatchEvent(new Event("change"));})()',
  );
  await delay(200);
  await check(
    cdp,
    'two per-block edits leave two overrides on that caption alone',
    '[...document.querySelectorAll("#blocks .row.active .tag")].map(t=>t.textContent).find(t=>/override/.test(t))',
    (v) => String(v).startsWith('2 '),
    '2 override(s)',
  );
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#style-all-toggle");c.checked=true;c.dispatchEvent(new Event("change"));})()',
  );
  await evaluate(cdp, setCase('upper'));
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => String(v).includes('edited'), {
    describe: 'the scoped edit to reach the document',
  });
  await check(
    cdp,
    'a scoped edit changes the document, not the block',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('edited'),
  );
  await check(
    cdp,
    'and it clears only the key it touched — the block keeps its other override',
    '[...document.querySelectorAll("#blocks .row.active .tag")].map(t=>t.textContent).find(t=>/override/.test(t))',
    (v) => String(v).startsWith('1 '),
    '1 override(s) — the fill survives',
  );
  await check(
    cdp,
    'no other caption was given a fresh override of its own',
    '[...document.querySelectorAll("#blocks .row")].filter(r=>[...r.querySelectorAll(".tag")].some(t=>/override/.test(t.textContent))).length',
    (v) => v === 1,
    'exactly one row',
  );
  // Back to a clean, unedited document so the sections below start where they expect to.
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#style-all-toggle");c.checked=false;c.dispatchEvent(new Event("change"));})()',
  );
  await evaluate(cdp, 'document.querySelector("#reset-block").click()');
  await evaluate(cdp, 'document.querySelector("#reset-style").click()');
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => !String(v).includes('edited'), {
    describe: 'the scope test to leave a clean document',
  });

  console.log('\n■ document style edits');
  await check(
    cdp,
    'a fresh reset reads as an unedited template',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('Veed') && !String(v).includes('edited'),
  );
  await evaluate(
    cdp,
    '(()=>{const i=document.querySelector("#font-size");i.value="0.05";i.dispatchEvent(new Event("input"));})()',
  );
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => String(v).includes('edited'), {
    describe: 'the style-bar edit to mark the template edited',
  });
  await check(
    cdp,
    'a style-bar edit marks the template edited, without losing its name',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('Veed') && String(v).includes('edited'),
  );
  await evaluate(cdp, 'document.querySelector("#reset-style").click()');
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => !String(v).includes('edited'), {
    describe: 'the reset to clear the edited flag',
  });
  await check(
    cdp,
    'and resetting restores both the look and the unedited flag',
    'document.querySelector("#template-status").textContent',
    (v) => !String(v).includes('edited'),
  );

  console.log('\n■ underline draw (the emphasis flow)');
  // The draw-in is the one thing a *unit* test cannot see: the geometry and the progress curve are
  // covered there, but "does the line actually get painted shorter on screen" is a question about
  // pixels. So this counts them, on the real preview canvas, at the demo's first emphasised word
  // ("Just", revealed at 15.20, draw complete at 15.60 under the parity template).
  await evaluate(
    cdp,
    `(()=>{
      window.__green=()=>{
        const c=document.querySelector('#preview-canvas');
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n=0;
        for(let i=0;i<d.length;i+=4){if(d[i+3]>40&&d[i+1]>140&&d[i]<110&&d[i+2]<130)n++;}
        return n;
      };
    })()`,
  );
  const seekTo = (t) =>
    `(()=>{const s=document.querySelector('#seek');s.value='${t}';s.dispatchEvent(new Event('input'));})()`;
  await evaluate(cdp, seekTo(15.7));
  const greenFull = await evaluate(cdp, 'window.__green()');
  await evaluate(cdp, seekTo(15.35));
  const greenEarly = await evaluate(cdp, 'window.__green()');
  await evaluate(cdp, seekTo(15.2));
  const greenAtStart = await evaluate(cdp, 'window.__green()');
  assert('the emphasised word has a lime underline at the end of its draw', greenFull > 0, `${greenFull} green px`);
  assert(
    'part way through the draw the underline is shorter than its full length',
    greenEarly > 0 && greenEarly < greenFull,
    `${greenEarly} vs ${greenFull} green px`,
  );
  assert(
    'and at the word\u2019s own start instant it has not been drawn at all',
    greenAtStart === 0,
    `${greenAtStart} green px`,
  );
  await check(
    cdp,
    'underline draw defaults on, so a fresh document is not an edited template',
    'document.querySelector("#underline-draw-toggle").checked',
    (v) => v === true,
  );
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#underline-draw-toggle");c.checked=false;c.dispatchEvent(new Event("change"));})()',
  );
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => String(v).includes('edited'), {
    describe: 'turning the flow off to mark the template edited',
  });
  await evaluate(cdp, seekTo(15.2));
  const greenStatic = await evaluate(cdp, 'window.__green()');
  assert(
    'with the flow off the underline is already drawn at the word\u2019s start (the static parity look)',
    greenStatic > 0,
    `${greenStatic} green px`,
  );
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#underline-draw-toggle");c.checked=true;c.dispatchEvent(new Event("change"));})()',
  );
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => !String(v).includes('edited'), {
    describe: 'turning the flow back on to restore the unedited template',
  });

  console.log('\n■ underline colour (and the sweep\u2019s own flow)');
  // Sampling by *hue* is what makes this honest: it proves the renderer painted the chosen colour,
  // not merely that the input kept the string it was handed. The test is a ratio rather than an
  // exact rgb match so that a half-transparent antialiased edge counts too — at the thinned ends of
  // a sweep stroke those edges are most of what there is.
  await evaluate(
    cdp,
    `(()=>{
      window.__magenta=()=>{
        const c=document.querySelector('#preview-canvas');
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n=0;
        for(let i=0;i<d.length;i+=4){
          const r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];
          if(a>80&&r>90&&b>90&&g<0.6*Math.min(r,b))n++;
        }
        return n;
      };
    })()`,
  );
  const setColor = (v) =>
    `(()=>{const i=document.querySelector('#emphasis-color');i.value='${v}';i.dispatchEvent(new Event('input'));i.dispatchEvent(new Event('change'));})()`;
  await evaluate(cdp, setColor('#ff00ff'));
  await waitFor(cdp, 'document.querySelector("#emphasis-color-out").textContent', (v) => v === '#ff00ff', {
    describe: 'the picked colour to reach the readout',
  });
  await evaluate(cdp, seekTo(15.7));
  const magentaFull = await evaluate(cdp, 'window.__magenta()');
  const stillLime = await evaluate(cdp, 'window.__green()');
  assert('the underline is painted in the colour that was picked', magentaFull > 0, `${magentaFull} magenta px`);
  assert('and no longer in the default lime', stillLime === 0, `${stillLime} lime px`);
  await check(
    cdp,
    'the block inspector offers the same picker for one caption',
    'document.querySelectorAll("#block-inspector input[type=color]").length',
    (v) => v >= 1,
  );
  // The sweep is painted in the same colour, so its own flow can be measured on a hue nothing else
  // in the frame uses — white text and a white stroke would be indistinguishable by pixels.
  await evaluate(
    cdp,
    '(()=>{const s=document.querySelector("#emphasis-decoration");s.value="sweep";s.dispatchEvent(new Event("change"));})()',
  );
  await delay(150);
  await evaluate(cdp, seekTo(15.7));
  const sweepFull = await evaluate(cdp, 'window.__magenta()');
  await evaluate(cdp, seekTo(15.35));
  const sweepEarly = await evaluate(cdp, 'window.__magenta()');
  assert('the curved sweep is drawn in the chosen colour too', sweepFull > 0, `${sweepFull} magenta px`);
  assert(
    'and it flows — part way through, the S is shorter than its full length',
    sweepEarly > 0 && sweepEarly < sweepFull,
    `${sweepEarly} vs ${sweepFull} magenta px`,
  );
  // leave the document on the parity look, which is what the sections after this one expect
  await evaluate(cdp, setColor('#22c55e'));
  await evaluate(cdp, 'document.querySelector("#reset-style").click()');
  await waitFor(cdp, 'document.querySelector("#template-status").textContent', (v) => !String(v).includes('edited'), {
    describe: 'the parity style to be restored after the colour checks',
  });
  await check(
    cdp,
    'resetting puts the picker back on the verified lime',
    'document.querySelector("#emphasis-color").value',
    (v) => v === '#22c55e',
  );

  console.log('\n■ frame ratio');
  const setAspect = (id) =>
    `(()=>{const s=document.querySelector('#aspect-select');s.value='${id}';s.dispatchEvent(new Event('change'));})()`;
  await check(
    cdp,
    'the frame-ratio picker is built from the presets, plus a way to follow the picture',
    '[...document.querySelectorAll("#aspect-select option")].map((o)=>o.value).join("|")',
    (v) => v === 'source|16:9|9:16|4:5|1:1|4:3|3:4|21:9',
  );
  await check(
    cdp,
    'and it reads back the ratio the document is already on',
    'document.querySelector("#aspect-select").value',
    (v) => v === '16:9',
    '16:9 — the demo is 1280x720',
  );
  await evaluate(cdp, setAspect('9:16'));
  await waitFor(cdp, 'document.querySelector("#aspect-select").value', (v) => v === '9:16', {
    describe: 'the 9:16 ratio to be applied',
  });
  await check(
    cdp,
    'choosing 9:16 makes the caption canvas portrait',
    '(()=>{const c=document.querySelector("#preview-canvas");return Math.round((c.width/c.height)*1000)/1000})()',
    (v) => Math.abs(v - 0.5625) < 0.02,
    '0.5625',
  );
  await check(
    cdp,
    'and the stage takes the project’s shape, so the video layer stays in register',
    '(()=>{const s=document.querySelector("#stage");return Math.round((s.clientWidth/s.clientHeight)*1000)/1000})()',
    (v) => Math.abs(v - 0.5625) < 0.02,
    '0.5625',
  );
  await check(
    cdp,
    'and the log says what the frame became',
    'document.querySelector("#log").textContent.includes("frame ratio: 9:16")',
    (v) => v === true,
  );

  console.log('\n■ full-screen preview');
  const fsButton = await evaluate(
    cdp,
    // scrolled into view first: the click below is delivered at viewport coordinates, so a button
    // below the fold would receive it somewhere else entirely
    '(()=>{const b=document.querySelector("#fullscreen-btn");b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
  );
  // A real input event, not a scripted `.click()`: `requestFullscreen` needs a user activation.
  await mouse('mousePressed', fsButton.x, fsButton.y);
  await mouse('mouseReleased', fsButton.x, fsButton.y);
  await delay(500);
  const fsElement = await evaluate(cdp, 'document.fullscreenElement ? document.fullscreenElement.id : ""');
  assert(
    'full screen puts the stage (not the whole page) on the screen',
    fsElement === 'stage',
    `fullscreenElement = ${JSON.stringify(fsElement)}`,
  );
  if (fsElement === 'stage') {
    // The browser pins a full-screen element to 100% of the display, so the stage is the black
    // surround; what has to be the project's shape is the *frame* inside it — the caption canvas —
    // and the video has to sit on exactly that box or the captions drift off the picture.
    await check(
      cdp,
      'the full-screen frame keeps the project’s ratio, not the monitor’s',
      '(()=>{const c=document.querySelector("#preview-canvas");return Math.round((c.clientWidth/c.clientHeight)*1000)/1000})()',
      (v) => Math.abs(v - 0.5625) < 0.03,
      '0.5625',
    );
    await check(
      cdp,
      'and the video layer sits on exactly that frame',
      `(()=>{const c=document.querySelector('#preview-canvas').getBoundingClientRect();const v=document.querySelector('#preview-video').getBoundingClientRect();return Math.max(Math.abs(c.left-v.left),Math.abs(c.top-v.top),Math.abs(c.width-v.width),Math.abs(c.height-v.height))})()`,
      (v) => v <= 1,
      'no more than a rounding pixel apart on any edge',
    );
    // The button lives outside the stage, so it is covered while the preview is full-screen — Escape
    // (or the API, as here) is the way out, and the log has to say that it happened.
    await evaluate(cdp, 'document.exitFullscreen()');
    await delay(400);
    await check(cdp, 'the preview does not get stuck on the screen', 'document.fullscreenElement === null', (v) => v === true);
    await check(
      cdp,
      'and the way out is recorded',
      'document.querySelector("#log").textContent.includes("full screen preview off")',
      (v) => v === true,
    );
  } else {
    console.log('  \u2022 skipped the full-screen geometry \u2014 this Chrome did not grant full screen');
  }
  await evaluate(cdp, setAspect('16:9'));
  await waitFor(cdp, 'document.querySelector("#aspect-select").value', (v) => v === '16:9', {
    describe: 'the frame to be put back to 16:9 for the sections after this one',
  });

  console.log('\n■ audio import');
  // A synthetic, self-contained WAV: the smoke test must not depend on the (gitignored) reference
  // workspace, and a real file is the only way to exercise the object-URL → <audio> path end to end.
  const wav = `(() => {
    const rate = 8000, samples = rate * 0.2;
    const bytes = new Uint8Array(44 + samples * 2);
    const dv = new DataView(bytes.buffer);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ascii(36, 'data'); dv.setUint32(40, samples * 2, true);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'tone.wav', { type: 'audio/wav' }));
    const input = document.querySelector('#audio-in');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return input.files.length;
  })()`;
  await check(cdp, 'a file selected on the audio input is picked up', wav, (v) => v === 1);
  await check(
    cdp,
    'the audio tag names the imported track',
    'document.querySelector("#audio-tag").textContent',
    (v) => v === 'tone.wav',
  );
  await check(
    cdp,
    'the log records it',
    'document.querySelector("#log").textContent.includes("audio loaded: tone.wav")',
    (v) => v === true,
  );
  await check(
    cdp,
    'the track is wired to an object URL',
    'document.querySelector("#preview-audio").src.startsWith("blob:")',
    (v) => v === true,
  );
  await delay(600);
  await check(
    cdp,
    'the track actually decodes, so the element is playable',
    '(()=>{const a=document.querySelector("#preview-audio");return a.readyState>=1&&a.duration>0})()',
    (v) => v === true,
  );
  await check(
    cdp,
    'and the transport sized its seek bar to the track, not the document',
    'Math.abs(Number(document.querySelector("#seek").max)-document.querySelector("#preview-audio").duration)<0.05',
    (v) => v === true,
  );
  await check(
    cdp,
    'the mute toggle silences the track',
    '(()=>{const c=document.querySelector("#mute-toggle");c.checked=true;c.dispatchEvent(new Event("change"));return document.querySelector("#preview-audio").muted})()',
    (v) => v === true,
  );
  await check(
    cdp,
    'the volume slider reaches the element',
    '(()=>{const v=document.querySelector("#volume");v.value="0.25";v.dispatchEvent(new Event("input"));return document.querySelector("#preview-audio").volume})()',
    (v) => Math.abs(v - 0.25) < 0.01,
  );
  await check(
    cdp,
    'and importing audio force-mutes the video so two tracks cannot overlap',
    'document.querySelector("#preview-video").muted',
    (v) => v === true,
  );

  console.log('\n■ audio routing');
  // Start from an uncluttered state: the master mute was switched on above.
  await evaluate(cdp, '(()=>{const c=document.querySelector("#mute-toggle");c.checked=false;c.dispatchEvent(new Event("change"));})()');
  await check(
    cdp,
    'a master track takes the sound over, and the two switches say so',
    '(()=>{const v=document.querySelector("#video-audio-toggle");const a=document.querySelector("#audio-audio-toggle");return JSON.stringify({video:v.checked,audio:a.checked})})()',
    (v) => v === JSON.stringify({ video: false, audio: true }),
  );
  await check(
    cdp,
    'turning the picture\u2019s own audio back on un-mutes the video',
    '(()=>{const c=document.querySelector("#video-audio-toggle");c.checked=true;c.dispatchEvent(new Event("change"));return document.querySelector("#preview-video").muted})()',
    (v) => v === false,
  );
  await check(
    cdp,
    'and the uploaded track has its own switch, independent of the picture\u2019s',
    '(()=>{const c=document.querySelector("#audio-audio-toggle");c.checked=false;c.dispatchEvent(new Event("change"));return JSON.stringify({audio:document.querySelector("#preview-audio").muted,video:document.querySelector("#preview-video").muted})})()',
    (v) => v === JSON.stringify({ audio: true, video: false }),
  );
  // Back to both audible, so the sections below hear what they expect.
  await evaluate(cdp, '(()=>{for(const id of ["#audio-audio-toggle","#video-audio-toggle"]){const c=document.querySelector(id);c.checked=true;c.dispatchEvent(new Event("change"));}})()');

  console.log('\n■ auto-wrap');
  await check(
    cdp,
    'the auto-wrap guard is present and on by default',
    '(()=>{const c=document.querySelector("#autowrap-toggle");return c?c.checked:null})()',
    (v) => v === true,
  );
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#autowrap-toggle");c.checked=false;c.dispatchEvent(new Event("change"));})()',
  );
  await delay(250);
  await check(
    cdp,
    'turning it off is a real style edit',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('edited'),
  );
  await evaluate(
    cdp,
    '(()=>{const c=document.querySelector("#autowrap-toggle");c.checked=true;c.dispatchEvent(new Event("change"));})()',
  );
  await delay(250);
  await check(
    cdp,
    'and turning it back restores the unmodified parity style',
    'document.querySelector("#template-status").textContent',
    (v) => !String(v).includes('edited'),
  );

  console.log('\n■ caption text editing');
  await evaluate(cdp, 'document.querySelector("#blocks .row").click()');
  await delay(250);
  await check(
    cdp,
    'the inspector exposes a caption text field',
    'document.querySelectorAll("#block-inspector #block-text-input").length',
    (v) => v === 1,
  );
  await check(
    cdp,
    'the field is pre-filled with the selected caption',
    'document.querySelector("#block-text-input").value.trim().length > 0',
    (v) => v === true,
  );
  const wordCount = await evaluate(cdp, 'document.querySelector("#block-text-input").value.trim().split(/\\s+/).length');
  await check(
    cdp,
    'and the word strip has one timed chip per word',
    'document.querySelectorAll("#word-editor .word-chip input").length',
    (v) => v === wordCount,
    `${wordCount}`,
  );

  const beforeText = await evaluate(cdp, 'document.querySelector("#blocks .row.active .body").childNodes[0].textContent');
  const beforeTime = await evaluate(cdp, 'document.querySelector("#blocks .row.active .t").textContent');
  const reversed = String(beforeText).trim().split(/\s+/).reverse().join(' ');
  await evaluate(
    cdp,
    `(()=>{const f=document.querySelector("#block-text-input");f.value=${JSON.stringify(reversed)};f.dispatchEvent(new Event("change"));})()`,
  );
  await delay(300);
  await check(
    cdp,
    're-typing the line updates the caption everywhere',
    'document.querySelector("#blocks .row.active .body").childNodes[0].textContent',
    (v) => v === reversed,
    JSON.stringify(reversed),
  );
  await check(
    cdp,
    'and a same-length fix leaves the caption’s timing untouched',
    'document.querySelector("#blocks .row.active .t").textContent',
    (v) => v === beforeTime,
    JSON.stringify(beforeTime),
  );
  await evaluate(
    cdp,
    '(()=>{const i=document.querySelectorAll("#word-editor .word-chip input")[0];i.value="ZZZ";i.dispatchEvent(new Event("change"));})()',
  );
  await delay(300);
  await check(
    cdp,
    'a single word can be fixed on its own',
    'document.querySelector("#blocks .row.active .body").childNodes[0].textContent.split(" ")[0]',
    (v) => v === 'ZZZ',
    'ZZZ',
  );

  console.log('\n■ splitting long captions');
  // The demo's deliberately long line is the shape that holds a whole sentence, so under a
  // word-by-word reveal every spoken word stays on screen until the block ends. Pick it out by
  // word count rather than by row position, which earlier sections have already been editing.
  const longRow = await evaluate(
    cdp,
    '(() => { const rows = [...document.querySelectorAll("#blocks .row")]; let best = 0; let bestWords = -1; rows.forEach((r, i) => { const n = r.querySelector(".body").childNodes[0].textContent.trim().split(/\\s+/).length; if (n > bestWords) { bestWords = n; best = i; } }); return best; })()',
  );
  await evaluate(cdp, `[...document.querySelectorAll("#blocks .row")][${longRow}].click()`);
  await delay(250);
  const line = await evaluate(cdp, '[...document.querySelectorAll("#word-editor .word-chip input")].map((i) => i.value)');
  const lineTimes = await evaluate(
    cdp,
    '[...document.querySelectorAll("#word-editor .word-chip .word-time")].map((e) => e.textContent)',
  );
  const rowsBefore = await evaluate(cdp, 'document.querySelectorAll("#blocks .row").length');
  await check(
    cdp,
    'a split handle sits between every pair of words',
    'document.querySelectorAll("#word-editor .word-split").length',
    (v) => v === line.length - 1,
    `${line.length - 1}`,
  );

  await evaluate(cdp, '[...document.querySelectorAll("#word-editor .word-split")][4].click()');
  await delay(350);
  await check(
    cdp,
    'splitting adds exactly one caption',
    'document.querySelectorAll("#blocks .row").length',
    (v) => v === rowsBefore + 1,
    `${rowsBefore + 1}`,
  );
  const halves = `${line.slice(0, 5).join(' ')} | ${line.slice(5).join(' ')}`;
  await check(
    cdp,
    'and it divides the line at the handle that was clicked',
    `[...document.querySelectorAll("#blocks .row")].slice(${longRow}, ${longRow + 2}).map((r) => r.querySelector(".body").childNodes[0].textContent).join(" | ")`,
    (v) => v === halves,
    JSON.stringify(halves),
  );
  await check(
    cdp,
    'the two captions meet exactly at the cut',
    `(() => { const t = [...document.querySelectorAll("#blocks .row")].slice(${longRow}, ${longRow + 2}).map((r) => r.querySelector(".t").textContent.trim().split("–")); return t[0][1].trim() === t[1][0].trim(); })()`,
    (v) => v === true,
    'first.end === second.start',
  );
  await check(
    cdp,
    'the words keep their own timings, so the sync does not move',
    '[...document.querySelectorAll("#word-editor .word-chip .word-time")][0].textContent',
    (v) => v === lineTimes[5],
    JSON.stringify(lineTimes[5]),
  );
  await check(
    cdp,
    'the keyword highlight travelled with its word into the new caption',
    `[...document.querySelectorAll("#blocks .row")].slice(${longRow}, ${longRow + 2}).map((r) => r.querySelectorAll(".tag").length).join("|")`,
    (v) => v === '0|1',
    '0|1',
  );
  await check(
    cdp,
    'the remainder is selected, ready for the next split',
    `document.querySelector("#blocks .row.active").dataset.blockId === [...document.querySelectorAll("#blocks .row")][${longRow + 1}].dataset.blockId`,
    (v) => v === true,
  );

  const rowsAfterSplit = await evaluate(cdp, 'document.querySelectorAll("#blocks .row").length');
  // The audio-import section above left a 0.2 s track loaded, and while *any* media drives the
  // clock a seek is clamped into it — so the playhead could never reach this caption, which starts
  // at 17.68 s. Dropping the source returns the preview to its wall clock, i.e. the state the
  // editor is really in before a track is imported.
  await evaluate(
    cdp,
    '(()=>{const a=document.querySelector("#preview-audio");a.removeAttribute("src");a.load();return a.readyState})()',
  );
  // Re-click the selected row: that scrubs the playhead into the caption, which is the gesture
  // "split at playhead" is written for.
  await evaluate(cdp, 'document.querySelector("#blocks .row.active").click()');
  await delay(250);
  await evaluate(cdp, 'document.querySelector("#split-at-playhead").click()');
  await delay(350);
  await check(
    cdp,
    'splitting at the playhead carves the remainder again',
    'document.querySelectorAll("#blocks .row").length',
    (v) => v === rowsAfterSplit + 1,
    `${rowsAfterSplit + 1}`,
  );
  const splitTexts = await evaluate(
    cdp,
    '[...document.querySelectorAll("#blocks .row")].map((r) => r.querySelector(".body").childNodes[0].textContent)',
  );
  await evaluate(cdp, 'document.querySelector("#join-previous").click()');
  await delay(350);
  await check(
    cdp,
    'joining merges it back into the caption before it',
    'document.querySelectorAll("#blocks .row").length',
    (v) => v === rowsAfterSplit,
    `${rowsAfterSplit}`,
  );
  const rejoined = `${splitTexts[longRow + 1]} ${splitTexts[longRow + 2]}`;
  await check(
    cdp,
    'and the merged caption carries both halves in order',
    'document.querySelector("#blocks .row.active .body").childNodes[0].textContent',
    (v) => v === rejoined,
    JSON.stringify(rejoined),
  );
  await evaluate(cdp, 'document.querySelector("#blocks .row").click()');
  await delay(250);
  await check(
    cdp,
    'the first caption has nothing before it to join with',
    'document.querySelector("#join-previous").disabled',
    (v) => v === true,
  );

  console.log('\n■ transcribe from the audio-studio server');
  // The one thing no unit test can reach: a real page, a real fetch, a cross-origin preflight, a
  // File as the request body, and the polling that follows. The server is a stand-in; everything
  // on this side of the wire is the real client, importer and editor.
  const stub = await startStubStudio();
  stubState = stub.state;
  const stubPort = stub.port;

  await evaluate(cdp, `(()=>{const i=document.querySelector('#transcribe-url');i.value='http://127.0.0.1:${stubPort}';return i.value})()`);
  await check(
    cdp,
    '“check server” reaches the server and reports its version',
    '(()=>{document.querySelector("#transcribe-probe").click();return true})()',
  );
  await delay(700);
  await check(
    cdp,
    'the badge names the version the server reported',
    'document.querySelector("#transcribe-status").textContent',
    (v) => v === 'audio-studio 9.9.9',
  );
  await check(
    cdp,
    'and the log carries what the server can actually do',
    'document.querySelector("#log").textContent.includes("audio-studio 9.9.9")',
    (v) => v === true,
  );

  // A synthetic WAV again: the smoke test must not depend on the (gitignored) reference workspace.
  const pickRecording = `(() => {
    const rate = 8000, samples = rate * 0.2;
    const bytes = new Uint8Array(44 + samples * 2);
    const dv = new DataView(bytes.buffer);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ascii(36, 'data'); dv.setUint32(40, samples * 2, true);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'recording.wav', { type: 'audio/wav' }));
    const input = document.querySelector('#transcribe-in');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return input.files.length;
  })()`;
  await check(cdp, 'a recording can be chosen', pickRecording, (v) => v === 1);
  await check(
    cdp,
    'and that alone enables the button',
    'document.querySelector("#transcribe-btn").disabled',
    (v) => v === false,
  );

  // The original lyrics are read *in the page* and posted with the job, because a browser cannot
  // read a path off the user's disk. This is the only place that whole path is real: a File, a
  // `.text()` call, and a query string.
  const lyrics = 'And they say that a hero can save us\n';
  const pickLyrics = `(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(lyrics)}], 'spidy.srt', { type: 'text/plain' }));
    const input = document.querySelector('#lyrics-in');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return input.files.length;
  })()`;
  await check(cdp, 'the original lyrics can be chosen', pickLyrics, (v) => v === 1);
  await check(
    cdp,
    'and the panel says the text will come from that file',
    'document.querySelector("#transcribe-note").textContent',
    (v) => String(v).includes('spidy.srt'),
  );

  await evaluate(
    cdp,
    '(()=>{const s=document.querySelector("#transcribe-emphasis");s.value="auto";s.dispatchEvent(new Event("change"));})()',
  );
  await evaluate(cdp, 'document.querySelector("#transcribe-btn").click()');
  await check(
    cdp,
    'the button reports progress while it waits',
    '(()=>{const b=document.querySelector("#transcribe-bar");return b.classList.contains("busy")||b.style.width!==""})()',
    (v) => v === true,
  );
  // The stand-in answers the first poll with "running" and the second with "done", so waiting on
  // the page's own status exercises the real polling loop rather than a fixed sleep.
  await waitFor(cdp, 'document.querySelector("#transcribe-status").textContent', (v) => v === 'done', {
    attempts: 80,
    describe: 'the transcribe job to finish polling',
  });

  assert(
    'the recording really was uploaded as the request body',
    stubState.uploadBytes > 40,
    `only ${stubState.uploadBytes} byte(s) arrived`,
  );
  assert(
    'with its name in the query string',
    stubState.uploads[0]?.name === 'recording.wav',
    `got ${JSON.stringify(stubState.uploads[0]?.name)}`,
  );
  assert(
    'and the options the user chose rode along',
    String(stubState.uploads[0]?.query ?? '').includes('align=wav2vec'),
    `query was ${JSON.stringify(stubState.uploads[0]?.query)}`,
  );
  assert(
    'including the AI auto-highlight request',
    String(stubState.uploads[0]?.query ?? '').includes('emphasis=auto'),
    `query was ${JSON.stringify(stubState.uploads[0]?.query)}`,
  );
  const uploadQuery = new URLSearchParams(stubState.uploads[0]?.query ?? '');
  assert(
    'the original lyrics rode along as text',
    (uploadQuery.get('referenceText') ?? '').includes('hero can save us'),
    `referenceText was ${JSON.stringify(uploadQuery.get('referenceText'))}`,
  );
  assert(
    'and the file they came from was named',
    uploadQuery.get('referenceName') === 'spidy.srt',
    `referenceName was ${JSON.stringify(uploadQuery.get('referenceName'))}`,
  );
  assert('the job was polled to completion', stubState.polls >= 2, `polled ${stubState.polls} time(s)`);
  assert('the file crossed the wire exactly once', stubState.uploads.length === 1, `${stubState.uploads.length} uploads`);
  await check(
    cdp,
    'the app says it is done',
    'document.querySelector("#transcribe-status").textContent',
    (v) => v === 'done',
  );
  await check(
    cdp,
    'the progress bar filled',
    'document.querySelector("#transcribe-bar").style.width',
    (v) => v === '100%',
  );

  console.log('\n■ the provenance the other studio wrote');
  // Nothing here is needed to *render* a caption — it is what a person needs to trust one, so it is
  // shown rather than swallowed.
  await check(
    cdp,
    'the audit lines are shown beside the progress bar',
    'document.querySelector("#transcribe-note").textContent',
    (v) => String(v).includes('alignment wav2vec'),
  );
  await check(
    cdp,
    'and they name the engine, the segments and the shift',
    'document.querySelector("#transcribe-note").textContent',
    (v) => String(v).includes('faster-whisper/small') && String(v).includes('2/2 segments') && String(v).includes('mean shift 0.21s'),
  );
  await check(
    cdp,
    'the warnings the other studio attached are carried through',
    'document.querySelector("#log").textContent',
    (v) => String(v).includes('a synthetic stand-in'),
  );
  await check(
    cdp,
    'the AI auto-highlight picks are shown in the audit',
    'document.querySelector("#transcribe-note").textContent',
    (v) => String(v).includes('2 word(s) picked to emphasise'),
  );
  await check(
    cdp,
    'the track is loaded into the preview, so the captions can be checked against what was sung',
    'document.querySelector("#audio-tag").textContent',
    (v) => v === 'recording.wav',
  );

  console.log('\n■ and the timings survive the rest of the pipeline');
  // The AI source is a *source*: it reaches the editor through the quality correction, exactly as a
  // file from disk does. `#align-btn` enabling is itself the proof that the transcribe really left
  // an AI document in the store, because that is the only thing that unlocks it.
  const truth = `1\n00:00:12,000 --> 00:00:16,000\nJust an ordinary boy,\n\n2\n00:00:16,000 --> 00:00:20,000\nLost in the crowd.\n`;
  await evaluate(
    cdp,
    `(()=>{const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(truth)}], 'truth.srt', {type:'text/plain'}));const i=document.querySelector('#truth-in');i.files=dt.files;i.dispatchEvent(new Event('change'));return i.files.length})()`,
  );
  await delay(400);
  await check(
    cdp,
    'the transcribed AI source unlocks the correction',
    'document.querySelector("#align-btn").disabled',
    (v) => v === false,
  );
  await evaluate(cdp, 'document.querySelector("#align-btn").click()');
  await waitFor(cdp, 'document.querySelector("#report").textContent.includes("Anchors")', (v) => v === true, {
    describe: 'the quality correction to finish',
  });
  await check(
    cdp,
    'the correction ran against the measured timings',
    'document.querySelectorAll("#blocks .row").length',
    (v) => v > 0,
  );

  // The payoff, and the whole reason the two studios exist. The captions below are these four
  // facts at once: the words are the server's, the spelling is the TRUTH file's, and the numbers
  // are the onsets the *aligner measured* — 12.00-12.60, 12.70-12.90, 13.00-13.80, 14.00-14.60 —
  // which is a different clock from the demo's invented timings and from the TRUTH cue
  // boundaries, so nothing else could have produced them.
  await check(
    cdp,
    'the captions are the server\'s words with the TRUTH file\'s spelling',
    '[...document.querySelectorAll("#blocks .row")].map(r=>r.querySelector(".body").childNodes[0].textContent).join(" | ")',
    (v) => v === 'Just an ordinary boy, | Lost in the crowd.',
  );
  await check(
    cdp,
    'the block windows are the measured onsets, not the demo\'s and not the cue boundaries',
    '[...document.querySelectorAll("#blocks .row")].map(r=>r.querySelector(".t").textContent.replace(/\\s/g,"")).join(" | ")',
    (v) => v === '12.00–14.60 | 16.00–18.00',
  );
  await check(
    cdp,
    'and every word kept the onset the aligner measured',
    '[...document.querySelectorAll("#word-editor .word-chip .word-time")].map(e=>e.textContent.replace(/\\s/g,"")).join(" | ")',
    (v) => v === '12.00–12.60 | 12.70–12.90 | 13.00–13.80 | 14.00–14.60',
  );
  await check(
    cdp,
    'the correction relabelled the words without inserting or deleting a single one',
    'document.querySelector("#report").textContent.replace(/\\s/g,"")',
    (v) => /Matched8/.test(v) && /Inserted0/.test(v) && /Deleted0/.test(v),
    'Matched8 … Inserted0 … Deleted0',
  );
  await check(
    cdp,
    'the TRUTH spelling wins, exactly as it did before the timing authority changed',
    '[...document.querySelectorAll("#blocks .row")].map(r=>r.querySelector(".body").childNodes[0].textContent).join(" ")',
    (v) => String(v).includes('ordinary') && !String(v).includes('ordnary'),
  );
  await check(
    cdp,
    'the corrections panel lists the change',
    'Number(document.querySelector("#cor-count").textContent)',
    (v) => Number(v) > 0,
  );
  stub.close();

  console.log('\n■ export');
  // The three workflow panels are tabs now, so this section starts by choosing the one it is about —
  // the same click a user makes, which also proves the strip really does switch panels.
  await evaluate(cdp, 'document.querySelector("#tab-export-btn").click()');
  await delay(150);
  await check(
    cdp,
    'choosing the Export tab shows that panel and hides the others',
    'document.querySelector("#tab-export").hidden + "/" + document.querySelector("#tab-sources").hidden + "/" + document.querySelectorAll(".tab-panel:not([hidden])").length',
    (v) => v === 'false/true/1',
  );
  // Watch the two calls every download goes through, so the buttons are checked by what they
  // actually save rather than by a log line.
  await evaluate(
    cdp,
    `(()=>{
      window.__downloads=[];
      window.__blobSizes=[];
      const realCreate=URL.createObjectURL.bind(URL);
      URL.createObjectURL=(blob)=>{window.__downloads.push(blob&&blob.type?blob.type:'');window.__blobSizes.push(blob&&blob.size?blob.size:0);return realCreate(blob);};
      const realClick=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){if(this.download){window.__downloads.push(this.download);}return realClick.call(this);};
    })()`,
  );
  await check(
    cdp,
    'the caption files can be saved once a document exists',
    'document.querySelector("#download-project").disabled',
    (v) => v === false,
  );
  await check(
    cdp,
    'the video export stays off until a video is loaded',
    'document.querySelector("#download-video").disabled',
    (v) => v === true,
  );
  await check(
    cdp,
    'the export window offers a quality setting, high by default',
    'document.querySelector("#export-dialog-quality").value',
    (v) => v === 'high',
  );
  await check(
    cdp,
    'and it is the same set of presets the encoder reads',
    '[...document.querySelectorAll("#export-dialog-quality option")].map((o)=>o.value).join("|")',
    (v) => v === 'balanced|high|best',
  );
  await check(
    cdp,
    'the container choice is MP4 or WebM, MP4 by default',
    '[...document.querySelectorAll("#export-dialog-format option")].map((o)=>o.value+":"+(o.selected?"on":"off")).join("|")',
    (v) => v === 'mp4:on|webm:off',
  );

  for (const [id, ext] of [
    ['#download-project', '.caproj'],
    ['#download-veed', '.veed.json'],
    ['#download-srt', '.srt'],
    ['#download-vtt', '.vtt'],
  ]) {
    await evaluate(cdp, `document.querySelector("${id}").click()`);
    await delay(150);
    await check(
      cdp,
      `the ${ext} button saves a ${ext} file`,
      `window.__downloads.filter((x)=>String(x).endsWith(${JSON.stringify(ext)})).length`,
      (v) => v >= 1,
    );
  }

  console.log('\n■ video burn-in');
  // Build a two-second 640×360 MP4 in the page — WebCodecs plus the vendored MP4 muxer — and hand
  // it to #video-in, so the smoke test needs no (gitignored) fixture.
  //
  // An **indexed MP4** rather than the old recorded WebM, on purpose. The exporter seeks every frame,
  // and a MediaRecorder WebM carries no seek index: pointing this section at one measures the worst
  // case and takes minutes, not the file a user actually loads (a phone/camera MP4).
  //
  // The content is *noise* on purpose too — a tidy moving square gives the encoder almost nothing to
  // spend its bitrate on, so two quality settings would produce the same file and the measurement
  // below would prove nothing.
  const madeVideo = await evaluate(
    cdp,
    `(async () => {
      if (typeof VideoEncoder === 'undefined') return 0;
      // resolved against the page URL (…/caption-studio/index.html), not the workspace root
      const { Muxer, ArrayBufferTarget } = await import('./vendor/muxers/mp4-muxer.mjs');
      const W = 640, H = 360, FPS = 30, SECONDS = 5;
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const g = canvas.getContext('2d');
      const config = { codec: 'avc1.42001f', width: W, height: H, bitrate: 2000000, framerate: FPS };
      const support = await VideoEncoder.isConfigSupported(config);
      if (!support || !support.supported) return 0;
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory' });
      const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: () => {} });
      encoder.configure({ ...config, avc: { format: 'avc' } });
      const noise = new Uint8Array(W * H);
      const total = FPS * SECONDS;
      const img = g.createImageData(W, H);
      for (let i = 0; i < total; i++) {
        // crypto.getRandomValues refuses more than 64 KiB in one call, so fill in chunks
        for (let o = 0; o < noise.length; o += 65536) {
          crypto.getRandomValues(noise.subarray(o, Math.min(o + 65536, noise.length)));
        }
        const d = img.data;
        for (let k = 0, o = 0; k < noise.length; k++, o += 4) {
          d[o] = noise[k]; d[o + 1] = noise[(k + 37) % noise.length]; d[o + 2] = noise[(k + 101) % noise.length]; d[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
        encoder.encode(frame, { keyFrame: i % 60 === 0 });
        frame.close();
        if (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      }
      await encoder.flush();
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'smoke.mp4', { type: 'video/mp4' }));
      const input = document.querySelector('#video-in');
      // Kept on the page so it can be handed to the input a second time, which is how "a picture
      // arrives *after* the frame ratio was chosen" gets tested without a second recording.
      window.__smokeVideo = dt.files[0];
      input.files = dt.files; input.dispatchEvent(new Event('change'));
      return blob.size;
    })()`,
  );
  if (!madeVideo) {
    console.log('  \u2022 skipped \u2014 this browser cannot encode H.264, so the burn-in cannot be checked here');
  } else {
    await waitFor(
      cdp,
      '(()=>{const v=document.querySelector("#preview-video");return v.readyState>=1&&v.videoWidth>0})()',
      (v) => v === true,
      { describe: 'the synthetic video to decode' },
    );
    await check(
      cdp,
      'a loaded video unlocks the burn-in',
      'document.querySelector("#download-video").disabled',
      (v) => v === false,
    );

    const rects = await evaluate(
      cdp,
      `(()=>{const c=document.querySelector('#preview-canvas').getBoundingClientRect();const v=document.querySelector('#preview-video').getBoundingClientRect();return {canvas:[c.left,c.top,c.width,c.height],video:[v.left,v.top,v.width,v.height]}})()`,
    );
    const drift = Math.max(...rects.canvas.map((x, i) => Math.abs(x - rects.video[i])));
    assert(
      'a real picture lands on the caption frame, so captions cannot drift off it',
      drift <= 1,
      `worst edge ${drift}px out — ${JSON.stringify(rects)}`,
    );

    // The frame-ratio lock. A picture normally sets the frame — but not over a ratio somebody has
    // chosen, or the whole point of picking 9:16 would be undone by the clip loaded next.
    await evaluate(cdp, setAspect('9:16'));
    await check(
      cdp,
      'an explicitly chosen ratio turns the frame portrait even over a landscape picture',
      '(()=>{const c=document.querySelector("#preview-canvas");return c.height>c.width})()',
      (v) => v === true,
    );
    await evaluate(
      cdp,
      `(()=>{const dt=new DataTransfer();dt.items.add(window.__smokeVideo);const i=document.querySelector('#video-in');i.files=dt.files;i.dispatchEvent(new Event('change'));})()`,
    );
    await delay(500);
    await check(
      cdp,
      'and a picture loaded afterwards does not undo it',
      '(()=>{const c=document.querySelector("#preview-canvas");return c.height>c.width})()',
      (v) => v === true,
    );
    await evaluate(cdp, setAspect('source'));
    await check(
      cdp,
      '“source” hands the frame back to the picture’s own shape',
      '(()=>{const c=document.querySelector("#preview-canvas");return c.width>c.height})()',
      (v) => v === true,
    );
    await check(
      cdp,
      'and says so in the log',
      'document.querySelector("#log").textContent.includes("frame ratio: the picture")',
      (v) => v === true,
    );

    // One export at each end of the quality range, into a portrait frame at first so the letterbox
    // path is exercised too (a 16:9 picture inside a 9:16 frame must be centred, never stretched).
    //
    // The source is re-selected before each take, which is what a person does and also what makes the
    // comparison repeatable: the fixture is a webm *written by MediaRecorder*, so it carries no seek
    // index and its reported duration drifts as it buffers — fine to export from once, not a fair
    // yardstick to re-wind for a second run of the same measurement.
    const reSelectVideo = async () => {
      await evaluate(
        cdp,
        `(()=>{const dt=new DataTransfer();dt.items.add(window.__smokeVideo);const i=document.querySelector('#video-in');i.files=dt.files;i.dispatchEvent(new Event('change'));})()`,
      );
      await waitFor(
        cdp,
        '(()=>{const v=document.querySelector("#preview-video");return v.readyState>=1&&v.videoWidth>0})()',
        (v) => v === true,
        { describe: 'the fixture picture to be re-selected' },
      );
      await delay(150);
    };
    // Open the export window and set it the way a user would: the resolution stays `source`, so the
    // export is at the project's own frame and the older assertions about the portrait letterbox keep
    // meaning what they meant.
    await evaluate(
      cdp,
      `(()=>{
        window.__openExport = ({ format, quality, resolution }) => {
          document.querySelector('#download-video').click();
          const set = (sel, value) => {
            const node = document.querySelector(sel);
            node.value = value;
            node.dispatchEvent(new Event('change', { bubbles: true }));
          };
          set('#export-dialog-resolution', resolution || 'source');
          set('#export-dialog-format', format || 'mp4');
          set('#export-dialog-quality', quality || 'high');
          return document.querySelector('#export-dialog').open;
        };
      })()`,
    );
    const exportWith = async (quality, aspect, format = 'mp4') => {
      await reSelectVideo();
      await evaluate(cdp, setAspect(aspect));
      await evaluate(cdp, `window.__openExport({ format: '${format}', quality: '${quality}', resolution: 'source' })`);
      await check(cdp, 'the export window opens over the app', 'document.querySelector("#export-dialog").open', (v) => v === true);
      await check(
        cdp,
        'and it says what the file will be before anything is encoded',
        'document.querySelector("#export-readout").textContent',
        (v) => /^(MP4|WEBM) /.test(String(v)) && String(v).includes(" fps ") && String(v).includes(" Mbps video ") && String(v).includes(" kbps audio")
      );
      const before = await evaluate(cdp, 'window.__blobSizes.length');
      const started = Date.now();
      await evaluate(cdp, 'document.querySelector("#export-dialog-go").click()');
      try {
        await waitFor(
          cdp,
          `window.__blobSizes.length > ${before} && document.querySelector("#export-status").textContent !== "encoding\u2026"`,
          (v) => v === true,
          { attempts: 900, intervalMs: 100, describe: `the ${quality} export to finish` },
        );
      } catch (err) {
        // Say what the page said, rather than only that the wait ran out
        const where = await evaluate(
          cdp,
          '(()=>{const v=document.querySelector("#preview-video");return JSON.stringify({video:{t:v.currentTime,d:String(v.duration),ended:v.ended,paused:v.paused,seeking:v.seeking,ready:v.readyState},status:document.querySelector("#export-status").textContent,note:document.querySelector("#export-note").textContent})})()',
        );
        throw new Error(`${quality} export did not finish: ${where} (${err.message})`);
      }
      await evaluate(cdp, 'document.querySelector("#export-dialog").close()');
      const bytes = await evaluate(cdp, 'window.__blobSizes[window.__blobSizes.length - 1]');
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const note = await evaluate(
        cdp,
        'document.querySelector("#log").textContent.split("\\n").filter((l)=>l.includes("export: ")).pop()',
      );
      console.log(`  \u2022 ${format}/${quality} on a 5s clip: ${bytes} bytes in ${elapsed}s \u2014 ${note}`);
      return bytes;
    };
    const portraitBytes = await exportWith('best', '9:16', 'mp4');
    await check(
      cdp,
      'the export saved an .mp4',
      'window.__downloads.filter((x)=>String(x).endsWith(".mp4")).length',
      (v) => v >= 1,
    );
    await check(
      cdp,
      'and it reported success rather than failure',
      'document.querySelector("#export-status").textContent',
      (v) => v === 'done',
    );
    assert('the portrait export is a real file, not an empty blob', portraitBytes > 2000, `${portraitBytes} bytes`);
    await check(
      cdp,
      'the export names the quality it encoded at rather than leaving it to the browser',
      'document.querySelector("#log").textContent.includes("best quality")',
      (v) => v === true,
    );
    await check(
      cdp,
      'and the log names the container it wrote',
      'document.querySelector("#log").textContent.includes("into a .mp4")',
      (v) => v === true,
    );
    await check(
      cdp,
      'and reports the frames and the bitrate it actually used',
      '/\\d+ frames, avc1\\.\\d+, \\d+\\.\\d Mbps/.test(document.querySelector("#log").textContent)',
      (v) => v === true,
    );
    // The measurement that answers "the download looks worse than the source": record the same clip
    // at both ends of the range and compare what the encoder actually produced. Noise content makes
    // the target bitrate the binding constraint, so the two really do differ.
    const webmBytes = await exportWith('balanced', '16:9', 'webm');
    await check(
      cdp,
      'switching the container writes a .webm instead of an .mp4',
      'window.__downloads.filter((x)=>String(x).endsWith(".webm")).length',
      (v) => v >= 1,
    );
    assert('and the .webm is a real file too', webmBytes > 2000, `${webmBytes} bytes`);
    const webmBestBytes = await exportWith('best', '16:9', 'webm');
    const balancedBytes = await exportWith('balanced', '16:9');
    const bestBytes = await exportWith('best', '16:9');
    console.log(
      `  \u2022 on the same 5s noise clip: mp4 balanced ${balancedBytes}, best ${bestBytes} ` +
        `(${(bestBytes / Math.max(1, balancedBytes)).toFixed(2)}x); webm balanced ${webmBytes}, ` +
        `best ${webmBestBytes} (${(webmBestBytes / Math.max(1, webmBytes)).toFixed(2)}x); ` +
        `portrait ${portraitBytes} bytes`,
    );
    // The claim is measured on the VP9/WebM path, because that is where this browser's encoder
    // actually honours the bitrate: its H.264 encoder treats `bitrate` as a hint and encodes a hard
    // clip at roughly the same size whatever the setting (the printed mp4 figures show that
    // honestly rather than hiding it). VP9 spends 1.4× the bits going from balanced to best, which is
    // the property the quality picker promises.
    assert(
      'a better quality setting genuinely spends more bits on the same clip',
      webmBestBytes > webmBytes * 1.2 && webmBytes > 0,
      `webm balanced ${webmBytes} bytes vs best ${webmBestBytes} bytes`,
    );
    assert('and the letterboxed portrait export was a real recording too', portraitBytes > 0, `${portraitBytes} bytes`);
    // The sound no longer comes from *playing* the track, so it can no longer "play out": the encoder
    // decodes the uploaded file and re-encodes it in the same pass as the picture. What must be true
    // is that the export says which of the two happened — it carried the audio, or it said why it
    // could not — rather than handing back a silent file with no explanation.
    await check(
      cdp,
      'the export reports what happened to the sound rather than going quietly silent',
      '/with mp4a\\.40\\.2 audio|will not encode AAC|no uploaded audio file/.test(document.querySelector("#log").textContent)',
      (v) => v === true,
    );
  }

  console.log('\n■ console health');
  await check(cdp, 'the font-size readout resolved to pixels', '/\\d+px/.test(document.querySelector("#size-out").textContent)');
  const clean = cdp.problems.length === 0;
  console.log(`${clean ? '  ✔' : '  ✖'} no uncaught exceptions or console errors`);
  if (!clean) failures.push('console errors');
  for (const p of cdp.problems) console.log(`    ${p}`);

  cdp.close();
  console.log(`\n${failures.length ? '✖ FAILED' : '✔ PASSED'} — ${failures.length} failing check(s)`);
  if (failures.length) for (const f of failures) console.log(`  · ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('ui-smoke crashed:', err);
  process.exit(1);
});
