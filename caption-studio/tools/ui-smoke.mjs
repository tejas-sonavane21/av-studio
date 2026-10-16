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

/** The badge text a finished panel carries — the mark is part of the message, so it is asserted. */
const DONE_TAG = '\u2713 done';
/** The export panel's own word for the same thing: a file was written. */
const SAVED_TAG = '\u2713 saved';
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
        presets: ['fast', 'balanced', 'accurate', 'best'],
        defaultPreset: 'balanced',
        // What each preset actually loads, and whether this machine has it. The panel builds its menu
        // from these, so a preset in the UI is a model with a repository and a size rather than a
        // category — and `medium` is deliberately *not* downloaded here, so the "will download" half
        // (the difference that has already made two machines disagree about the same commit) is
        // exercised rather than assumed.
        presetDetails: [
          { id: 'fast', model: 'base', modelName: 'Whisper base', repo: 'Systran/faster-whisper-base', params: '74 M', languages: 'multilingual', downloaded: true, beamSize: 1, note: 'the quickest', known: true },
          { id: 'balanced', model: 'small', modelName: 'Whisper small', repo: 'Systran/faster-whisper-small', params: '244 M', languages: 'multilingual', downloaded: true, beamSize: 5, note: 'the default', known: true },
          { id: 'accurate', model: 'medium', modelName: 'Whisper medium', repo: 'Systran/faster-whisper-medium', params: '769 M', languages: 'multilingual', downloaded: false, beamSize: 5, note: 'slower on hard audio', known: true },
          { id: 'best', model: 'distil-large-v3', modelName: 'distil-whisper large-v3', repo: 'Systran/faster-distil-whisper-large-v3', params: '756 M', languages: 'English only', downloaded: false, beamSize: 5, note: 'best accuracy', known: true },
        ],
        emitKinds: ['json', 'veed', 'srt', 'vtt'],
        // Deliberately drifted, so the page's own warning is exercised: a server whose
        // dependencies are not the pinned ones is the failure this project has actually
        // had, and it is reported before a job is queued rather than after it dies.
        pins: {
          path: 'requirements.txt',
          checked: 8,
          ok: false,
          differs: [{ name: 'av', pinned: '18.1.0', installed: '19.0.1' }],
        },
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

    if (url.pathname === '/jobs') {
      // The register of finished runs. `source` is a *path* on the Python side, exactly as the real
      // server sends it, so the panel has to reduce it to a name rather than showing a path.
      return send(200, {
        jobs: [
          {
            jobId: 'stub-job',
            status: 'done',
            source: 'C:/music/songs/Just an Ordinary Boy.mp3',
            files: { veed: 'stub.veed.json' },
            urls: { veed: '/jobs/stub-job/veed' },
            created: 1700000000.0,
            summary: { segments: 2, words: 8, seconds: 1.25 },
          },
          { jobId: 'stub-running', status: 'running', source: 'halfway.mp3', files: {}, urls: {} },
        ],
      });
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

    // The other artifact the Sources panel fills itself from, served as text exactly as the real
    // server serves it, so the panel's SRT path is the real one.
    if (url.pathname === '/jobs/stub-job/srt') {
      return send(
        200,
        '1\n00:00:12,000 --> 00:00:16,000\nJust an ordinary boy,\n\n2\n00:00:16,000 --> 00:00:20,000\nLost in the crowd.\n',
        'text/plain; charset=utf-8',
      );
    }

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
    'the timeline draws a lane for the captions, the picture, the sound and the imported clips',
    '[...document.querySelectorAll("#timeline .timeline-track")].map((t)=>t.className.replace("timeline-track","").trim()).join("|")',
    (v) => v === 'captions|media|video|audio',
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
  await check(
    cdp,
    'and says what zoom level it is at, rather than leaving it to be guessed',
    'document.querySelector("#timeline .timeline-zoom").textContent',
    (v) => /^\d+%$/.test(String(v)) && String(v) !== '100%',
  );
  // The strip has to be *scrollable* when it is zoomed — that is the whole point of zooming — and the
  // scroll position has to be the user's. Both were broken by a relayout that reset it.
  const scrolled = await evaluate(
    cdp,
    `(()=>{
      const scroll = document.querySelector('#timeline .timeline-scroll');
      const inner = document.querySelector('#timeline .timeline-inner');
      const overflow = parseFloat(inner.style.width) - scroll.clientWidth;
      scroll.scrollLeft = 40;
      const afterScroll = scroll.scrollLeft;
      document.querySelector('#timeline .timeline-scroll').dispatchEvent(
        new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }),
      );
      return { overflow, afterScroll, afterWheel: scroll.scrollLeft };
    })()`,
  );
  assert(
    'a zoomed strip is wider than its window, so there is something to scroll',
    scrolled.overflow > 20,
    `the inner strip overflows by ${scrolled.overflow}px`,
  );
  assert(
    'setting the scroll position sticks',
    scrolled.afterScroll === 40,
    `scrollLeft came back as ${scrolled.afterScroll}`,
  );
  assert(
    'and a wheel notch scrolls the strip along it',
    scrolled.afterWheel > scrolled.afterScroll,
    `a 60px wheel notch moved the strip from ${scrolled.afterScroll} to ${scrolled.afterWheel}`,
  );
  await check(
    cdp,
    'the end of the recording is drawn on the strip',
    '(()=>{const m=document.querySelector("#timeline .timeline-end");return Boolean(m)&&!m.hidden&&parseFloat(m.style.left)>0})()',
    (v) => v === true,
  );
  // A caption cannot outlive the recording it was timed against. If one does, the strip clips it at
  // the end and flags it rather than drawing it past the material — and the count is asserted so the
  // check cannot pass by the situation never arising.
  const beyond = await evaluate(
    cdp,
    `(()=>{
      const inner = document.querySelector('#timeline .timeline-inner');
      const limit = parseFloat(inner.style.width);
      const clips = [...document.querySelectorAll('#timeline .timeline-clip')];
      const worst = Math.max(...clips.map((c) => parseFloat(c.style.left) + parseFloat(c.style.width)));
      return { worst, limit, clipped: document.querySelectorAll('#timeline .timeline-clip.beyond').length };
    })()`,
  );
  assert(
    'no caption clip is drawn past the end of the recording',
    beyond.worst <= beyond.limit + 1,
    `the furthest clip reaches ${beyond.worst}px of a ${beyond.limit}px strip`,
  );
  console.log(
    `  • ${beyond.clipped} caption(s) flagged as outliving the recording`,
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

  console.log('\n■ overlay clips');
  // An image clip is made here rather than loaded from a fixture, for the same reason the video section
  // encodes its own: the repo carries no media, and a clip's file is a file the page can invent.
  const clipLane = 'document.querySelectorAll("#timeline .timeline-track.media .timeline-media-clip").length';
  const addImageClip = async (name, colour = '#ff00ff') => {
    await evaluate(
      cdp,
      `(async () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const g = c.getContext('2d');
        g.fillStyle = '${colour}'; g.fillRect(0, 0, 64, 64);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], '${name}', { type: 'image/png' }));
        const input = document.querySelector('#media-in');
        input.files = dt.files; input.dispatchEvent(new Event('change'));
      })()`,
    );
    await waitFor(cdp, clipLane, (v) => v >= 1, { describe: 'the clip to be added' });
  };

  await addImageClip('logo.png');
  await delay(250);
  await check(cdp, 'adding a clip puts it on the timeline\u2019s Clips lane', clipLane, (v) => v === 1);
  await check(
    cdp,
    'and it appears in the sources panel, with its window',
    'document.querySelector("#media-list .clip-row .clip-where").textContent',
    (v) => /^\d+\.\d\d\u2013\d+\.\d\ds$/.test(String(v)),
  );
  await check(
    cdp,
    'and the panel says a clip is loaded rather than that none is',
    'document.querySelector("#media-note").textContent',
    (v) => /^1 clip over the picture/.test(String(v)),
  );
  // The drawing half. `getImageData` is the only way to see what was actually painted, and it is the
  // check that a clip is drawn at all — the lane proves the *model*, not the pixels.
  const clipPixels = () =>
    `(() => {
      const c = document.querySelector('#media-canvas');
      if (!c || c.hidden || getComputedStyle(c).display === 'none') return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) opaque += 1;
      return opaque;
    })()`;
  const painted = await evaluate(cdp, clipPixels());
  assert(
    'the clip is drawn over the picture, on a layer of its own',
    painted > 1000,
    `the clip layer had ${painted} opaque pixels${painted < 0 ? ' (it was hidden)' : ''}`,
  );
  const stack = await evaluate(
    cdp,
    `(() => {
      const m = document.querySelector('#media-canvas');
      const c = document.querySelector('#preview-canvas');
      const a = m.getBoundingClientRect();
      const b = c.getBoundingClientRect();
      const drift = Math.max(
        Math.abs(a.left - b.left), Math.abs(a.top - b.top),
        Math.abs(a.width - b.width), Math.abs(a.height - b.height),
      );
      // ...and it is *before* the caption canvas in the document, so it paints under it
      const under = Boolean(m.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { drift, under };
    })()`,
  );
  assert(
    'the clip layer lands exactly on the caption frame',
    stack.drift <= 1,
    `worst edge ${stack.drift}px out`,
  );
  assert(
    'and sits under the captions, so a caption is never hidden by a clip',
    stack.under === true,
    'the clip layer came after the caption canvas in the document',
  );

  // ---- dragging one --------------------------------------------------------
  // Everything through the strip's own pointer path, so what is tested is the gesture a user makes.
  const dragClip = (part, dx) =>
    `(() => {
      const find = () => document.querySelector('#timeline .timeline-track.media .timeline-media-clip');
      const window_ = () => document.querySelector('#media-list .clip-row .clip-where').textContent;
      const clip = find();
      const start = parseFloat(clip.style.left);
      const width = clip.getBoundingClientRect().width;
      const textBefore = window_();
      const target = ${part === 'handle' ? "clip.querySelector('.timeline-media-handle.right')" : 'clip'};
      const r = target.getBoundingClientRect();
      const at = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true });
      const scroll = document.querySelector('#timeline .timeline-scroll');
      scroll.setPointerCapture = () => {};
      target.dispatchEvent(new PointerEvent('pointerdown', at(r.left + r.width / 2)));
      scroll.dispatchEvent(new PointerEvent('pointermove', at(r.left + r.width / 2 + ${dx})));
      scroll.dispatchEvent(new PointerEvent('pointerup', at(r.left + r.width / 2 + ${dx})));
      const after = find();
      return {
        start, width, textBefore,
        left: parseFloat(after.style.left),
        widthAfter: after.getBoundingClientRect().width,
        textAfter: window_(),
      };
    })()`;

  const moved = await evaluate(cdp, dragClip('body', 60));
  await delay(150);
  assert(
    'dragging a clip\u2019s body moves it along the clock, keeping its length',
    moved.left > moved.start + 20 && Math.abs(moved.widthAfter - moved.width) < 2,
    `left ${moved.start} \u2192 ${moved.left}, width ${moved.width} \u2192 ${moved.widthAfter}`,
  );
  assert(
    'and the panel reports the new window rather than the one it had',
    moved.textAfter !== moved.textBefore,
    `the row still read ${JSON.stringify(moved.textAfter)}`,
  );
  const trimmed = await evaluate(cdp, dragClip('handle', -60));
  await delay(150);
  assert(
    'dragging an edge trims the clip rather than moving it',
    trimmed.widthAfter < trimmed.width - 5 && Math.abs(trimmed.left - trimmed.start) < 2,
    `width ${trimmed.width} \u2192 ${trimmed.widthAfter}, left ${trimmed.start} \u2192 ${trimmed.left}`,
  );
  await check(
    cdp,
    'a trimmed clip is still one clip, not two',
    clipLane,
    (v) => v === 1,
  );

  // The transport's own clock, so a seek here is the seek a person makes with the slider.
  const seek = (t) =>
    `(() => { const s = document.querySelector('#seek'); s.value = String(${t}); s.dispatchEvent(new Event('input', { bubbles: true })); return s.value; })()`;

  // ---- taking it away ------------------------------------------------------
  // Re-added before the removal, so the clip that the export section later measures is a whole one. A
  // different colour this time: the second clip is the one the stacking checks below need to tell apart.
  // Added from the *middle of the first clip's own window* — read off its row rather than guessed, because
  // the drag above pushed it along the clock — so the two overlap in time. Two clips that never overlap
  // in time cannot be stacked, and a stacking check that quietly has one clip on screen proves nothing.
  const firstWindow = await evaluate(cdp, 'document.querySelector("#media-list .clip-row .clip-where").textContent');
  const [wStart, wEnd] = String(firstWindow)
    .replace('s', '')
    .split('\u2013')
    .map(Number);
  const bothOn = (wStart + wEnd) / 2;
  assert('the clip the stacking checks need is on the clock', wEnd > wStart, `its row read ${firstWindow}`);
  await evaluate(cdp, seek(bothOn));
  await delay(150);
  await addImageClip('badge.png', '#00ffff');
  await delay(250);
  await check(cdp, 'a second clip joins the first on the lane', clipLane, (v) => v === 2);

  // ---- which clip is on top ------------------------------------------------
  // Both clips are added at the playhead and centred on the frame, so they sit on the same box and the
  // pixel in the middle of the frame is whichever one was painted last. Colour is the honest way to ask
  // "which one wins": the layer number can be read out of the model, but the frame is what a person sees.
  const centreColour = () =>
    `(() => {
      const c = document.querySelector('#media-canvas');
      const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return [d[0], d[1], d[2], d[3]].join(',');
    })()`;
  const CYAN = '0,255,255,255';
  const MAGENTA = '255,0,255,255';
  const panelWhere = 'document.querySelector("#clip-inspector-where").textContent';

  // Selecting a clip is clicking its name, so the row that is clicked is the one the panel then describes.
  // By *name*, not by index: the list is in time order and the first clip has been dragged along the
  // clock by now, so "the second row" is not the second clip that was added.
  const selectByName = (name) =>
    `[...document.querySelectorAll("#media-list .clip-row")].find(r=>/${name}/.test(r.querySelector(".clip-name").textContent)).querySelector(".clip-name").click()`;
  // Inside both windows, so both are really painted and the pixel in the middle is a decision rather than
  // a coincidence. Selecting a clip parks the playhead at its own start, which is not necessarily where
  // the other one is.
  await evaluate(cdp, seek(bothOn));
  await delay(150);
  await evaluate(cdp, selectByName('badge\\.png'));
  await delay(200);
  const top = await evaluate(cdp, centreColour());
  assert('the clip added last is painted on top where the two overlap', top === CYAN, `the frame's middle was ${top}`);
  await check(cdp, 'and the panel says which layer it is on', panelWhere, (v) => /layer 2\/2/.test(String(v)));

  await evaluate(cdp, 'document.querySelector("#clip-back").click()');
  await delay(200);
  const behind = await evaluate(cdp, centreColour());
  assert(
    'sending it back puts the other clip on top',
    behind === MAGENTA,
    `the frame's middle was ${behind}`,
  );
  await check(cdp, 'and the panel counts it from the bottom', panelWhere, (v) => /layer 1\/2/.test(String(v)));

  await evaluate(cdp, 'document.querySelector("#clip-forward").click()');
  await delay(200);
  const again = await evaluate(cdp, centreColour());
  assert('and one step forward puts it back on top', again === CYAN, `the frame's middle was ${again}`);

  // One clip can be used twice. The copy is a clip of its own (its own layer, its own slot in the list)
  // drawn from the *same* file, which is the point of duplicating rather than re-importing.
  await evaluate(cdp, 'document.querySelector("#clip-duplicate").click()');
  await delay(250);
  await check(cdp, 'Duplicate adds the clip again, above the original', clipLane, (v) => v === 3);
  await check(
    cdp,
    'and the copy is the one now selected',
    panelWhere,
    (v) => /layer 3\/3/.test(String(v)),
  );
  await check(
    cdp,
    'and its row is a clip of its own in the list',
    'document.querySelectorAll("#media-list .clip-row").length',
    (v) => v === 3,
  );
  // The copy is the *selected* clip, which is the reliable way to name it: it carries the same file name
  // as the clip it came from, and rows are in time order rather than in the order they were added.
  await evaluate(cdp, 'document.querySelector("#media-list .clip-row.active .clip-remove").click()');
  await delay(250);
  await check(
    cdp,
    'and removing the copy leaves the original, with its own row',
    clipLane,
    (v) => v === 2,
  );

  await evaluate(
    cdp,
    'document.querySelectorAll("#media-list .clip-row")[1].querySelector(".clip-remove").click()',
  );
  await delay(250);
  await check(cdp, 'the \u00d7 on a row takes that clip off the programme', clipLane, (v) => v === 1);
  await check(
    cdp,
    'and the panel goes back to one clip',
    'document.querySelector("#media-note").textContent',
    (v) => /^1 clip over the picture/.test(String(v)),
  );

  console.log('\n■ the clip\u2019s box is edited on the preview itself');
  // The section above left one clip on the programme. Selecting it from the panel is how a person starts
  // (and it parks the playhead inside the clip, so the clip is really on screen to be grabbed).
  await evaluate(cdp, 'document.querySelector("#media-list .clip-row .clip-name").click()');
  await waitFor(cdp, clipPixels(), (v) => v > 1000, { describe: 'the clip to be on the preview' });

  const gestures = await evaluate(
    cdp,
    `(async () => {
      const overlay = document.querySelector('#overlay-canvas');
      const media = document.querySelector('#media-canvas');
      const canvas = document.querySelector('#preview-canvas');
      // A synthetic pointer event has no pointer behind it, and the browser refuses to capture a pointer
      // id it never issued — that refusal is an exception *inside* the handler, so capture is stubbed the
      // way this harness already stubs it for the timeline.
      overlay.setPointerCapture = () => {};
      overlay.releasePointerCapture = () => {};

      const frameRect = () => canvas.getBoundingClientRect();
      // Backing-store pixels per CSS pixel: the clip layer is drawn at logical x dpr.
      const perCss = () => (frameRect().width > 0 ? media.width / frameRect().width : 1);
      const painted = () => {
        if (!media || media.hidden || getComputedStyle(media).display === 'none') return null;
        const d = media.getContext('2d').getImageData(0, 0, media.width, media.height).data;
        let x0 = media.width;
        let y0 = media.height;
        let x1 = -1;
        let y1 = -1;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] <= 10) continue;
          const p = (i - 3) / 4;
          const x = p % media.width;
          const y = Math.floor(p / media.width);
          n += 1;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        return n ? { x0: x0, y0: y0, x1: x1, y1: y1, n: n, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null;
      };
      const client = (bx, by) => {
        const r = frameRect();
        const k = perCss();
        return { x: r.left + bx / k, y: r.top + by / k };
      };
      const gesture = (from, to, modifiers = {}) => {
        const event = (type, at) =>
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: at.x,
            clientY: at.y,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: type === 'pointerup' ? 0 : 1,
            shiftKey: Boolean(modifiers.shift),
            altKey: Boolean(modifiers.alt),
          });
        overlay.dispatchEvent(event('pointerdown', from));
        overlay.dispatchEvent(event('pointermove', to));
        overlay.dispatchEvent(event('pointerup', to));
      };
      const text = (id) => document.querySelector('#' + id).textContent;
      const panel = () => ({
        name: text('clip-inspector-name'),
        where: text('clip-inspector-where'),
        x: text('clip-x-out'),
        y: text('clip-y-out'),
        w: text('clip-w-out'),
        h: text('clip-h-out'),
        rotation: text('clip-rot-out'),
      });
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const centre = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
      // A distance in *logical* pixels as a distance in CSS pixels, which is what a pointer event carries.
      // The two are the same on this page (the harness runs at DPR 1) but a drag written in the wrong unit
      // is a drag that would silently be wrong anywhere else.
      const px = (logical) => logical / perCss();

      const opened = {
        visible: !document.querySelector('#clip-inspector').hidden,
        panel: panel(),
        row: document.querySelector('#media-list .clip-row .clip-name').textContent,
        clip: painted(),
      };
      if (!opened.clip) return { error: 'nothing was painted on the clip layer to grab' };

      // ---- move: take hold of the middle of what is painted and pull it 60 left, 40 up ----------
      // Alt is held because guides are the default and they are *meant* to pull: a drag that ends a few
      // pixels off the canvas centre lands on it, which is right for a person and wrong for a measurement
      // of "does the picture follow the pointer". With Alt held no guide can move it, so the drag is the
      // only thing that can account for where the picture ends up.
      const grab = client(centre(opened.clip).x, centre(opened.clip).y);
      gesture(grab, { x: grab.x - 60, y: grab.y - 40 }, { alt: true });
      await tick();
      const moved = painted();
      const movedPanel = panel();

      // ---- a drag with the guides on: a near miss lands on the line ---------------------------
      // Aimed a hair inside the top-left corner of the frame, which is a target no caption can be near, so
      // the corner is the only thing that can account for where the box ends up. (The move above is the
      // other half of this: held Alt, the same drag lands wherever it was put.)
      // Taken by the middle of the clip, not by its corner: a corner is a *resize* handle, and the point of
      // this drag is that a move is pulled onto a guide.
      const grab2 = client(centre(moved).x, centre(moved).y);
      const aim = client(4 + moved.width / 2, 4 + moved.height / 2);
      gesture(grab2, aim);
      await tick();
      const snapped = painted();
      const snappedPanel = panel();
      // ---- resize: the corner that has frame to grow into -------------------------------------
      // The model keeps a box inside the frame and the frame's edge wins over a handle, so the corner
      // diagonally opposite the one dragged only stays put when the drag has somewhere to go. Take the
      // corner with room in *both* axes and grow by a step that fits: a clip parked against an edge would
      // otherwise be measuring the clamp rather than the pin.
      const room = {
        se: { x: media.width - 1 - snapped.x1, y: media.height - 1 - snapped.y1 },
        nw: { x: snapped.x0, y: snapped.y0 },
      };
      const grow = 80;
      const fits = (r) => r.x >= grow + 16 && r.y >= grow + 16;
      const corner = fits(room.se) ? 'se' : fits(room.nw) ? 'nw' : null;
      if (!corner) return { error: 'no corner had ' + grow + 'px of room to grow into: ' + JSON.stringify(room) };
      const sign = corner === 'se' ? 1 : -1;
      const grip = corner === 'se' ? client(snapped.x1 - 1, snapped.y1 - 1) : client(snapped.x0 + 1, snapped.y0 + 1);
      // Dragged mostly along one axis: the shape lock makes the other edge follow the bigger of the two
      // pushes, so the box grows by the same step on both edges and stays inside the room measured above.
      gesture(grip, { x: grip.x + sign * px(grow), y: grip.y + sign * px(grow * 0.7) });
      await tick();
      const resized = painted();
      const resizedPanel = panel();

      // ---- rotate: the round handle sits 26 logical px above the top edge ---------------------
      // A third of a turn, then a little more, so the angle is nowhere near a step and a *turned square*
      // is a visibly wider box than an upright one.
      const stem = client(centre(resized).x, resized.y0 - 26 * perCss());
      const spin = client(centre(resized).x + px(120), centre(resized).y + px(60));
      gesture(stem, spin);
      await tick();
      const rotated = painted();
      const rotatedPanel = panel();

      // ---- nudge: four steps right, which is 2% of the frame -------------------------------
      for (let i = 0; i < 4; i += 1) {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      }
      await tick();
      const nudged = painted();
      const nudgedPanel = panel();

      return {
        opened: opened,
        moved: { box: moved, panel: movedPanel },
        snapped: { box: snapped, panel: snappedPanel },
        resized: { box: resized, panel: resizedPanel },
        rotated: { box: rotated, panel: rotatedPanel },
        nudged: { box: nudged, panel: nudgedPanel },
        corner: corner,
        perCss: perCss(),
        frame: { width: media.width, height: media.height },
      };
    })()`,
    { timeout: 120 },
  );

  if (gestures?.error) {
    assert('the clip can be grabbed on the preview', false, gestures.error);
  } else {
    const { opened, moved, snapped, resized, rotated, nudged } = gestures;
    // The panel names the clip the row names: one selection, shown in both places, and compared against
    // the row itself rather than against a file name this harness would have to keep in step.
    const rowName = String(opened.row).replace(/^[^\w]*\s*/, '');
    assert(
      'clicking the clip\u2019s row opens its transform panel, named for that clip',
      opened.visible === true && String(opened.panel.name).includes(rowName) && rowName.length > 0,
      `the row read ${JSON.stringify(opened.row)} and the panel ${JSON.stringify(opened.panel.name)}`,
    );
    assert(
      'the panel reports the box in pixels as well as as a fraction of the frame',
      /% at .*% \u00b7 \d+\u00d7\d+ px/.test(String(opened.panel.where)),
      `the panel said ${JSON.stringify(opened.panel.where)}`,
    );

    // Dragging the body: the picture moves by the drag, and the panel follows it.
    const dx = (moved.box.x0 + moved.box.x1) / 2 - (opened.clip.x0 + opened.clip.x1) / 2;
    const dy = (moved.box.y0 + moved.box.y1) / 2 - (opened.clip.y0 + opened.clip.y1) / 2;
    assert(
      'dragging the clip\u2019s body moves the picture by the drag, under the cursor',
      Math.abs(dx / gestures.perCss + 60) <= 3 && Math.abs(dy / gestures.perCss + 40) <= 3,
      `the picture moved ${(dx / gestures.perCss).toFixed(1)}\u00d7${(dy / gestures.perCss).toFixed(1)} CSS px`,
    );
    assert(
      'and the size is untouched by a move',
      Math.abs(moved.box.width - opened.clip.width) <= 2 && Math.abs(moved.box.height - opened.clip.height) <= 2,
      `the box was ${opened.clip.width}\u00d7${opened.clip.height} and is ${moved.box.width}\u00d7${moved.box.height}`,
    );
    assert(
      'and the panel\u2019s numbers moved with it',
      moved.panel.x !== opened.panel.x || moved.panel.y !== opened.panel.y,
      `the panel still read ${moved.panel.x} / ${moved.panel.y}`,
    );

    // Guides on: 4 logical px inside the frame's top-left corner, which is inside the snap tolerance, so
    // the box is pulled the rest of the way onto the corner. The Alt drag above is the other half of this
    // pair: same gesture, no guides, wherever the pointer left it.
    assert(
      'a drag that ends near the frame\u2019s corner snaps onto it, rather than 4 px short',
      snapped.box.x0 <= 1 && snapped.box.y0 <= 1,
      `the box\u2019s top-left landed at (${snapped.box.x0},${snapped.box.y0}) of the ${gestures.frame.width}\u00d7${gestures.frame.height} frame`,
    );
    assert(
      'and the panel\u2019s numbers moved with the snap',
      snapped.panel.x !== moved.panel.x || snapped.panel.y !== moved.panel.y,
      `the panel still read ${snapped.panel.x} / ${snapped.panel.y}`,
    );

    // A corner handle: the box grows in both directions, and the corner *opposite* the one dragged
    // stays exactly where it was. Which corner that is depends on which one had room, so the pinned
    // corner is read off the gesture rather than assumed.
    const dragged = gestures.corner === 'se' ? 'bottom-right' : 'top-left';
    const pinned = gestures.corner === 'se' ? 'top-left' : 'bottom-right';
    const before = gestures.corner === 'se' ? [snapped.box.x0, snapped.box.y0] : [snapped.box.x1, snapped.box.y1];
    const after = gestures.corner === 'se' ? [resized.box.x0, resized.box.y0] : [resized.box.x1, resized.box.y1];
    assert(
      `dragging the ${dragged} handle grows the clip in both directions`,
      resized.box.width > snapped.box.width + 20 && resized.box.height > snapped.box.height + 20,
      `the box was ${snapped.box.width}\u00d7${snapped.box.height} and is ${resized.box.width}\u00d7${resized.box.height}`,
    );
    assert(
      `and the ${pinned} corner, opposite the handle, did not move`,
      Math.abs(after[0] - before[0]) <= 2 && Math.abs(after[1] - before[1]) <= 2,
      `the ${pinned} corner went from (${before[0]},${before[1]}) to (${after[0]},${after[1]})`,
    );
    assert(
      'and the panel\u2019s width and height readouts followed the handle',
      resized.panel.w !== snapped.panel.w || resized.panel.h !== snapped.panel.h,
      `the panel still read ${resized.panel.w}\u00d7${resized.panel.h}`,
    );

    // The round handle: a turn that is nowhere near a step, so the angle is the drag's own and the clip
    // really is at an angle — a turned square is a wider box on screen than an upright one.
    const angle = Number(String(rotated.panel.rotation).replace(/[^0-9.-]/g, ''));
    assert(
      'dragging the round handle above the clip turns it, and the panel reports the angle',
      Number.isFinite(angle) && Math.abs(angle) > 20 && Math.abs(angle) < 180 && Math.abs(angle - 90) > 5,
      `the panel read ${JSON.stringify(rotated.panel.rotation)}`,
    );
    assert(
      'and the turn is on the frame: a turned square is a wider box than an upright one',
      rotated.box && rotated.box.width > resized.box.width + 8,
      `the painted box went from ${resized.box.width}\u00d7${resized.box.height} to ${rotated.box?.width}\u00d7${rotated.box?.height}`,
    );

    // Arrow keys: a nudge is a move, and it goes through the same panel.
    // Four steps of 0.005 of the frame is 2% of it. The *right* edge is the one to measure: the clip was
    // snapped onto the frame's top-left corner, and a turned clip's bounding box hangs off that corner, so
    // its left edge is clipped by the canvas and moves less than the clip does.
    const nudgedDx = nudged.box.x1 - rotated.box.x1;
    const panelDx = Number(String(nudged.panel.x).replace('%', '')) - Number(String(rotated.panel.x).replace('%', ''));
    assert(
      'arrow keys nudge the selected clip, one step at a time',
      Math.abs(nudgedDx - 4 * 0.005 * gestures.frame.width) <= 3 && Math.abs(panelDx - 2) <= 0.5,
      `the picture moved ${nudgedDx.toFixed(1)} of the ${(4 * 0.005 * gestures.frame.width).toFixed(1)} px four steps ask for, and the panel moved ${panelDx}%`,
    );
    assert(
      'and the panel\u2019s numbers followed the nudge',
      nudged.panel.x !== rotated.panel.x,
      `the panel still read ${nudged.panel.x}`,
    );
    console.log(
      `  \u2022 the box: moved 60\u00d740 px, resized to ${resized.box.width}\u00d7${resized.box.height} px of the layer, turned to ${rotated.panel.rotation}, nudged four steps`,
    );
  }

  // ---- fit, stretch and reset, which is where the picture's own shape is at stake ---------------
  const shapes = await evaluate(
    cdp,
    `(async () => {
      const media = document.querySelector('#media-canvas');
      const painted = () => {
        const d = media.getContext('2d').getImageData(0, 0, media.width, media.height).data;
        let x0 = media.width;
        let y0 = media.height;
        let x1 = -1;
        let y1 = -1;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] <= 10) continue;
          const p = (i - 3) / 4;
          const x = p % media.width;
          const y = Math.floor(p / media.width);
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        return { x0: x0, y0: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
      };
      const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const text = (id) => document.querySelector('#' + id).textContent;

      // Back to the clip as it arrived — upright, its own shape — so what the fit settings do to the
      // picture is measured on an unturned box. A square turned 120\u00b0 has a *wider* bounding box than the
      // square itself, which is exactly the kind of thing that makes a fit check read as a failure.
      document.querySelector('#clip-reset').click();
      await tick();
      document.querySelector('#clip-fit-frame').click();
      await tick();
      const contained = painted();

      const fit = document.querySelector('#clip-fit');
      fit.value = 'stretch';
      fit.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      const stretched = painted();
      const stretchedFit = document.querySelector('#clip-fit').value;
      const stretchedWhere = text('clip-inspector-where');

      document.querySelector('#clip-reset').click();
      await tick();
      const reset = painted();

      return {
        frame: { width: media.width, height: media.height },
        contained: contained,
        stretched: stretched,
        stretchedFit: stretchedFit,
        stretchedWhere: stretchedWhere,
        reset: reset,
        resetFit: document.querySelector('#clip-fit').value,
        resetRotation: text('clip-rot-out'),
        resetWhere: text('clip-inspector-where'),
      };
    })()`,
    { timeout: 120 },
  );

  if (shapes?.frame) {
    // A 64\u00d764 image: contained in a 16:9 frame it is a square band in the middle, stretched it fills the
    // frame exactly. The two are different pictures of the same file, which is the whole point of fit.
    assert(
      'Fit frame fits a square picture inside the frame without distorting it',
      Math.abs(shapes.contained.width - shapes.contained.height) <= 2 && shapes.contained.width < shapes.frame.width - 10,
      `a 64\u00d764 file painted ${shapes.contained.width}\u00d7${shapes.contained.height} on a ${shapes.frame.width}\u00d7${shapes.frame.height} layer`,
    );
    assert(
      'and stretch fills the box exactly, which is the one setting that distorts',
      shapes.stretchedFit === 'stretch' &&
        /stretch/.test(String(shapes.stretchedWhere)) &&
        Math.abs(shapes.stretched.width - shapes.frame.width) <= 2 &&
        Math.abs(shapes.stretched.height - shapes.frame.height) <= 2,
      `the panel said ${JSON.stringify(shapes.stretchedWhere)} and stretch painted ${shapes.stretched.width}\u00d7${shapes.stretched.height} of a ${shapes.frame.width}\u00d7${shapes.frame.height} layer`,
    );
    assert(
      'Reset puts the picture back to its own shape, upright and centred',
      shapes.resetFit === 'contain' &&
        shapes.resetRotation === '0\u00b0' &&
        Math.abs(shapes.reset.width - shapes.reset.height) <= 2,
      `fit ${shapes.resetFit}, rotation ${shapes.resetRotation}, painted ${shapes.reset.width}\u00d7${shapes.reset.height}`,
    );
    console.log(
      `  \u2022 fit: contained ${shapes.contained.width}\u00d7${shapes.contained.height}, stretched ${shapes.stretched.width}\u00d7${shapes.stretched.height}, reset ${shapes.reset.width}\u00d7${shapes.reset.height} on a ${shapes.frame.width}\u00d7${shapes.frame.height} frame`,
    );
  } else {
    assert('the fit controls can be driven from the panel', false, 'the clip was not painted at all');
  }

  console.log('\n\u25a0 cropping a clip, on the preview');
  // A crop cuts the clip's **own file**, so it is checked on a picture whose two halves can be told
  // apart: red on the left half, blue on the right. A solid colour cannot say *which* half a cut left
  // behind — the pixels can, and they are the only place that answer is final.
  await evaluate(
    cdp,
    `(async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#ff0000'; g.fillRect(0, 0, 32, 64);
      g.fillStyle = '#0000ff'; g.fillRect(32, 0, 32, 64);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'bands.png', { type: 'image/png' }));
      const input = document.querySelector('#media-in');
      input.files = dt.files; input.dispatchEvent(new Event('change'));
    })()`,
  );
  await waitFor(cdp, clipLane, (v) => v >= 2, { describe: 'the two-band clip to be added' });
  await delay(250);
  // Clicking its row is also what parks the playhead inside its window, so the clip really is on the
  // frame to be grabbed — the same reason the sections above select the row rather than trust the import.
  await evaluate(cdp, selectByName('bands\\.png'));
  await delay(250);

  const cropRun = await evaluate(
    cdp,
    `(async () => {
      const overlay = document.querySelector('#overlay-canvas');
      const media = document.querySelector('#media-canvas');
      const canvas = document.querySelector('#preview-canvas');
      // A synthetic pointer event has no pointer id behind it, so capture is stubbed — the same stub the
      // gesture section above uses, for the same reason.
      overlay.setPointerCapture = () => {};
      overlay.releasePointerCapture = () => {};
      const frameRect = () => canvas.getBoundingClientRect();
      const perCss = () => (frameRect().width > 0 ? media.width / frameRect().width : 1);
      const px = (logical) => logical / perCss();
      const client = (bx, by) => {
        const r = frameRect();
        const k = perCss();
        return { x: r.left + bx / k, y: r.top + by / k };
      };
      const gesture = (from, to) => {
        const event = (type, at) =>
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: at.x,
            clientY: at.y,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: type === 'pointerup' ? 0 : 1,
          });
        overlay.dispatchEvent(event('pointerdown', from));
        overlay.dispatchEvent(event('pointermove', to));
        overlay.dispatchEvent(event('pointerup', to));
      };
      const settle = async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 60));
      };
      const text = (id) => document.querySelector('#' + id).textContent;
      // The banded clip's own picture, read out of the frame. Red is its left half and blue its right, so
      // the rectangle the two cover together is that clip and nothing else: the other clip on the layer is
      // magenta, which counts as neither, and the captions are on a canvas of their own.
      const bands = () => {
        const d = media.getContext('2d').getImageData(0, 0, media.width, media.height).data;
        let red = 0;
        let blue = 0;
        let x0 = media.width;
        let y0 = media.height;
        let x1 = -1;
        let y1 = -1;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] <= 10) continue;
          const r = d[i - 3];
          const g = d[i - 2];
          const b = d[i - 1];
          const isRed = r > 200 && g < 60 && b < 60;
          const isBlue = b > 200 && r < 60 && g < 60;
          if (!isRed && !isBlue) continue;
          if (isRed) red += 1;
          if (isBlue) blue += 1;
          const p = (i - 3) / 4;
          const x = p % media.width;
          const y = Math.floor(p / media.width);
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        return { red: red, blue: blue, x0: x0, y0: y0, x1: x1, y1: y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
      };
      const insets = () => ({
        left: parseFloat(text('clip-crop-left-out')),
        right: parseFloat(text('clip-crop-right-out')),
        top: parseFloat(text('clip-crop-top-out')),
        bottom: parseFloat(text('clip-crop-bottom-out')),
      });
      const where = () => text('clip-inspector-where');
      const toggle = document.querySelector('#clip-crop-toggle');

      const whole = bands();
      if (!whole.red || !whole.blue) return { error: 'the two-band picture was not on the frame to cut' };
      const before = { bands: whole, insets: insets(), where: where(), mode: toggle.checked };

      // ---- the cut: crop mode on, the picture's right edge dragged to the middle of the picture ------
      // The picture is whole, so its own rectangle *is* the crop frame the handles moved onto.
      toggle.checked = true;
      const mid = (whole.y0 + whole.y1) / 2;
      gesture(client(whole.x1 - 1, mid), client((whole.x0 + whole.x1) / 2, mid));
      await settle();
      const cut = { bands: bands(), insets: insets(), where: where() };

      // ---- the panel's own slider, on the same clip: one crop, two ways in --------------------------
      const slider = document.querySelector('#clip-crop-right');
      slider.value = '0.25';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      const slid = { bands: bands(), insets: insets() };

      document.querySelector('#clip-crop-reset').click();
      await settle();
      const reset = { bands: bands(), insets: insets(), where: where() };

      // ---- the mode off: the same drag is an ordinary box edit, and the media is left alone ---------
      // The point is the picture's right edge, taken from the frame rather than remembered, so it is the
      // same place the crop handle was — the only thing that changed between the two drags is the mode.
      toggle.checked = false;
      const edge = bands();
      const grab = client(edge.x1 - 1, (edge.y0 + edge.y1) / 2);
      gesture(grab, { x: grab.x - px(60), y: grab.y - px(40) });
      await settle();
      const plain = { bands: bands(), insets: insets(), where: where(), mode: toggle.checked };

      return {
        before: before,
        cut: cut,
        slid: slid,
        reset: reset,
        plain: plain,
        perCss: perCss(),
      };
    })()`,
    { timeout: 120 },
  );

  if (cropRun?.error) {
    assert('a clip can be cropped on the preview', false, cropRun.error);
  } else {
    // The box's own size in pixels, which a crop does not touch — taken out of the panel line so that
    // "the box did not move" is compared against the panel's own numbers rather than against a copy of
    // the layout this harness would have to keep in step.
    const boxPx = (line) => String((String(line).match(/(\d+)\u00d7(\d+) px/) || [])[0] ?? '');
    assert(
      'the crop controls arrive switched off, showing a whole picture',
      cropRun.before.mode === false &&
        cropRun.before.insets.left === 0 &&
        cropRun.before.insets.right === 0 &&
        cropRun.before.insets.top === 0 &&
        cropRun.before.insets.bottom === 0 &&
        cropRun.before.bands.red > 0 &&
        cropRun.before.bands.blue > 0,
      `mode ${cropRun.before.mode}, insets ${JSON.stringify(cropRun.before.insets)}, ${cropRun.before.bands.red} red and ${cropRun.before.bands.blue} blue pixels`,
    );
    // Half the picture's width is what dragging its right edge to its own middle asks for. The picture is
    // a square in a 16:9 box, so a cut to 50% wide is drawn *half as wide and just as tall*.
    assert(
      'dragging the picture\u2019s right edge in cuts the media to half its width',
      Math.abs(cropRun.cut.insets.right - 50) <= 1.5 &&
        Math.abs(cropRun.cut.bands.width - cropRun.before.bands.width / 2) <= 4 &&
        Math.abs(cropRun.cut.bands.height - cropRun.before.bands.height) <= 2,
      `the panel said ${cropRun.cut.insets.right}% cut and the picture went ${cropRun.before.bands.width}\u00d7${cropRun.before.bands.height} \u2192 ${cropRun.cut.bands.width}\u00d7${cropRun.cut.bands.height} px`,
    );
    assert(
      'and the half that was cut is gone from the file\u2019s own pixels, not hidden behind the box',
      cropRun.cut.bands.blue === 0 && cropRun.cut.bands.red > 0,
      `the frame still had ${cropRun.cut.bands.blue} blue and ${cropRun.cut.bands.red} red pixels of the two halves`,
    );
    assert(
      'and the box itself never moved: a crop is not a resize',
      boxPx(cropRun.cut.where) === boxPx(cropRun.before.where),
      `the box read ${boxPx(cropRun.before.where)} before and ${boxPx(cropRun.cut.where)} after`,
    );
    // The slider says how much to cut off *one* side, so 25% is a quarter off the right and three
    // quarters of the picture left behind — the same statement the drag above made as 50%.
    assert(
      'the panel\u2019s own inset slider cuts the same picture, one side at a time',
      Math.abs(cropRun.slid.insets.right - 25) <= 1.5 &&
        Math.abs(cropRun.slid.bands.width - cropRun.before.bands.width * 0.75) <= 4 &&
        cropRun.slid.bands.blue > 0,
      `the panel said ${cropRun.slid.insets.right}% off the right and the picture was ${cropRun.slid.bands.width}px of the ${cropRun.before.bands.width}px it started at`,
    );
    assert(
      'and Reset crop shows the whole file again, both halves included',
      cropRun.reset.insets.left === 0 &&
        cropRun.reset.insets.right === 0 &&
        Math.abs(cropRun.reset.bands.width - cropRun.before.bands.width) <= 3 &&
        Math.abs(cropRun.reset.bands.height - cropRun.before.bands.height) <= 3 &&
        cropRun.reset.bands.blue > 0,
      `insets ${JSON.stringify(cropRun.reset.insets)} with the picture back at ${cropRun.reset.bands.width}\u00d7${cropRun.reset.bands.height} px and ${cropRun.reset.bands.blue} blue pixels`,
    );
    assert(
      'with crop mode off the same drag is an ordinary box edit, and cuts nothing',
      cropRun.plain.mode === false &&
        cropRun.plain.insets.right === 0 &&
        cropRun.plain.insets.left === 0 &&
        (cropRun.plain.bands.x1 !== cropRun.reset.bands.x1 || cropRun.plain.bands.y1 !== cropRun.reset.bands.y1),
      `mode ${cropRun.plain.mode}, insets ${JSON.stringify(cropRun.plain.insets)}, the picture now at x1=${cropRun.plain.bands.x1} y1=${cropRun.plain.bands.y1}`,
    );
    console.log(
      `  \u2022 the crop: the picture\u2019s right edge cut away ${cropRun.cut.insets.right}% of the file, the slider cut ${cropRun.slid.insets.right}% off the right, and Reset put the whole file back \u2014 with the box at ${boxPx(cropRun.before.where)} throughout`,
    );
  }

  // Hand the selection back. A clip and a caption are never both selected — clicking either one clears
  // the other, so the two panels can never describe different things — and the sections below edit a
  // caption. Clicking a caption row is also the *proof* of that rule: the clip's panel must close.
  await evaluate(cdp, 'document.querySelector("#blocks .row")?.click()');
  await check(
    cdp,
    'selecting a caption closes the clip\u2019s transform panel',
    'document.querySelector("#clip-inspector").hidden',
    (v) => v === true,
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
    'the sources panel reports a track on its own, and what it means for the programme',
    'document.querySelector("#sources-message").textContent',
    (v) => /Track loaded: .*carries the clock/.test(v),
  );
  await check(
    cdp,
    'and its badge carries the state in colour and in words, not an empty line',
    'document.querySelector("#sources-status").textContent',
    (v) => /^\u2713 track [\d.]+s$/.test(v),
  );
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
  await check(
    cdp,
    'a server whose packages drifted from the pinned set says so before a job is queued',
    'document.querySelector("#transcribe-note").textContent.includes("av 19.0.1 (pinned 18.1.0)")',
    (v) => v === true,
  );
  await check(
    cdp,
    'and it names the command that repairs it rather than only the symptom',
    'document.querySelector("#transcribe-note").textContent.includes("pip install -r requirements.txt")',
    (v) => v === true,
  );

  // Presets used to read "fast — base model", which names neither a model nor a file. The menu is now
  // built from the server's own catalogue, so what a preset loads is on the label, and whether this
  // machine already has that model is beside it — the failure that started all of this was a second
  // laptop whose cache was empty, with nothing on screen to say so.
  await check(
    cdp,
    'the preset menu names the model each preset loads, not a size category',
    '[...document.querySelectorAll("#transcribe-preset option")].map((o)=>o.textContent).join("|")',
    (v) => String(v).includes('Whisper small, 244 M') && String(v).includes('distil-whisper large-v3, 756 M'),
  );
  await check(
    cdp,
    'and says which of those models is already downloaded here',
    '[...document.querySelectorAll("#transcribe-preset option")].map((o)=>o.textContent).join("|")',
    (v) => String(v).includes('downloaded') && String(v).includes('will download'),
  );
  await check(
    cdp,
    'the note under the menu names the repository the run will load',
    'document.querySelector("#transcribe-model-note").textContent',
    (v) => String(v).includes('Systran/faster-whisper-small') && String(v).includes('already downloaded'),
  );
  await evaluate(
    cdp,
    '(()=>{const s=document.querySelector("#transcribe-preset");s.value="accurate";s.dispatchEvent(new Event("change"));})()',
  );
  await check(
    cdp,
    'choosing another preset re-reads it, and says when that model is not here yet',
    'document.querySelector("#transcribe-model-note").textContent',
    (v) => String(v).includes('Whisper medium') && String(v).includes('NOT downloaded yet'),
  );
  await evaluate(
    cdp,
    '(()=>{const s=document.querySelector("#transcribe-preset");s.value="balanced";s.dispatchEvent(new Event("change"));})()',
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
  // A real subtitle file rather than a sentence with a .srt name: the Sources panel puts this very
  // file into its TRUTH field once the run finishes, and a file that cannot be parsed there would
  // make that auto-fill a lie.
  const lyrics = '1\n00:00:12,000 --> 00:00:16,000\nAnd they say that a hero can save us\n';
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
  // The badge carries a state mark as well as the word, so "done" is asserted as it is actually
  // written rather than loosened to a substring — the mark is part of what a person reads.
  await waitFor(cdp, 'document.querySelector("#transcribe-status").textContent', (v) => v === DONE_TAG, {
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
    (v) => v === DONE_TAG,
  );
  // ...and says *what* finished, in the panel's own state line. "done" on its own is a claim about
  // nothing: the number of captions is the part a person can check against what they expected.
  await check(
    cdp,
    'and says what it produced',
    'document.querySelector("#transcribe-message").textContent',
    (v) => /\b\d+\s+captions\b/.test(String(v)) && /recording\.wav/.test(String(v)),
  );
  // The stage has to show the result of its own run: the captions the server sent were mounted as
  // the document, not merely remembered in `aiDoc`.
  await check(
    cdp,
    'the transcribed captions were mounted on the timeline',
    'document.querySelectorAll("#timeline .timeline-clip").length',
    (v) => Number(v) > 0,
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

  // The Sources panel is where a person goes next, so the run's own files are put there instead of
  // being left in a job folder to be found by hand. The AI source is the run's Veed master — the
  // timing everything downstream is built on — and TRUTH is the lyric file the run was actually
  // given, because a subtitle file *is* the spelling authority and that is where it belongs.
  await check(
    cdp,
    'the run\'s Veed master is put in the AI source field, not left in a job folder',
    '(()=>{const f=document.querySelector("#ai-in").files;return f.length===1?f[0].name:""})()',
    (v) => /\.veed\.json$/.test(String(v)),
  );
  // The studio's own SRT, not the lyric sheet the run was given: the sheet is the words that were
  // asked for, and the SRT is what the studio produced from the recording (transcribed against the
  // audio, aligned, validated, reconciled with those lyrics). Where the two disagree about spelling,
  // the file that was measured against the audio is the one worth correcting against.
  await check(
    cdp,
    'and the run\u2019s own SRT is in the TRUTH field, rather than the lyric sheet it was given',
    '(()=>{const f=document.querySelector("#truth-in").files;return f.length===1?f[0].name:""})()',
    (v) => v === 'stub.srt',
  );
  await check(
    cdp,
    'the log says what it filled in rather than changing the panel behind the user\'s back',
    'document.querySelector("#log").textContent.includes("filled in from this run")',
    (v) => v === true,
  );

  // ------------------------------------------------------------------------- //
  // the runs the server already finished
  // -------------------------------------------------------------------------
  //
  // The other half of the two studios being a suite: a run's output already exists on the Python
  // side, so opening it has to be a click rather than a hunt through a job folder. Nothing in this
  // section transcribes anything, and the check below proves it — the job is opened from the list.
  console.log('\n■ opening a run the server already finished');
  await evaluate(cdp, 'document.querySelector("#runs-refresh").click()');
  await delay(400);
  await check(
    cdp,
    'the finished runs are listed',
    'document.querySelectorAll("#runs-select option").length',
    (v) => v === 1,
  );
  await check(
    cdp,
    'a run is named by its recording, not by the path the server keeps it at',
    'document.querySelector("#runs-select option").textContent',
    (v) => String(v).includes('Just an Ordinary Boy.mp3') && !String(v).includes('/'),
  );
  await check(
    cdp,
    'a run that has not finished is not offered, because it has nothing to open',
    'document.querySelector("#transcribe-url").value.includes("127.0.0.1") && !document.querySelector("#runs-select").textContent.includes("halfway")',
    (v) => v === true,
  );

  await evaluate(cdp, 'document.querySelector("#runs-open").click()');
  await delay(600);
  await check(
    cdp,
    'opening one says what it opened',
    'document.querySelector("#transcribe-status").textContent',
    (v) => v === '\u2713 opened',
  );
  await check(
    cdp,
    'and its captions are on the timeline',
    'document.querySelectorAll("#timeline .timeline-clip").length',
    (v) => Number(v) > 0,
  );
  // An opened run gets the same treatment as a fresh one: its two artifacts are fetched from the job
  // that wrote them and put where the next step looks. The names come from the server's own output
  // (`stub.veed.json` / `stub.srt`), so this is the run's files rather than a guess at them.
  await check(
    cdp,
    'an opened run fills the panel from its own artifacts too',
    '(()=>{const a=document.querySelector("#ai-in").files;const t=document.querySelector("#truth-in").files;return [a.length?a[0].name:"", t.length?t[0].name:""].join("|")})()',
    (v) => v === 'stub.veed.json|stub.srt',
  );
  assert(
    'no second transcription was run to open it',
    stubState.uploads.length === 1,
    `${stubState.uploads.length} upload(s) — opening a finished run must not upload anything`,
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
  // An **indexed MP4** rather than the old recorded WebM, on purpose, and it is the file a user
  // actually loads (a phone/camera capture). It was chosen when the export seeked every frame and a
  // MediaRecorder WebM's missing seek index made this section take minutes; the export now decodes
  // the picture in order (`openPictureStream`), so the choice no longer decides whether this runs —
  // but the *fallback* path still seeks, and pointing this at a file with no index would exercise it
  // in its worst case rather than its normal one.
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

    // The preview has to honour the cut. This is the bug this locks down: a media element plays its
    // own whole file and knows nothing about the timeline, so cutting the tail off a clip used to
    // leave the preview running happily through the seconds that had just been dropped. Only the
    // preview can stop that, so it is checked through the real transport rather than by calling the
    // model: scrub with the seek bar, press Play, and see where the picture actually stops.
    const seekTo = (seconds) =>
      `(()=>{const s=document.querySelector('#seek');s.value='${seconds}';s.dispatchEvent(new Event('input',{bubbles:true}));return document.querySelector('#preview-video').currentTime})()`;
    await evaluate(cdp, seekTo(2));
    await delay(150);
    await evaluate(
      cdp,
      'document.querySelector(\'#timeline .timeline-actions button[data-command="cut-right"]\').click()',
    );
    await delay(250);
    await check(
      cdp,
      'Cut right on a loaded picture really does shorten the programme',
      'document.querySelector("#timeline-status").textContent',
      (v) => /\d+\.\ds of \d+\.\ds after the cuts/.test(String(v)),
    );
    await evaluate(cdp, seekTo(0));
    await delay(150);
    await evaluate(cdp, 'document.querySelector("#play-btn").click()');
    // Wait for the picture to stop, not for it to pass the cut: a preview that ignored the cut runs to
    // the end of the file and stops there too, and the assertion below is what tells the two apart.
    await waitFor(
      cdp,
      'document.querySelector("#preview-video").paused',
      (v) => v === true,
      { attempts: 80, intervalMs: 100, describe: 'the preview to stop' },
    );
    const playedTo = await evaluate(
      cdp,
      '(()=>{const v=document.querySelector("#preview-video");return {t:Number(v.currentTime.toFixed(2)),paused:v.paused,label:document.querySelector("#play-btn").textContent}})()',
    );
    assert(
      'and the preview stops at the cut instead of playing on into the material it dropped',
      playedTo.t < 2.2 && playedTo.paused,
      `the picture was at ${playedTo.t}s (paused: ${playedTo.paused}) — the cut was at 2.0s`,
    );
    assert(
      'the transport goes back to Play once it stops itself at the cut',
      String(playedTo.label).includes('Play'),
      `the button said ${JSON.stringify(playedTo.label)}`,
    );
    await evaluate(
      cdp,
      'document.querySelector(\'#timeline .timeline-actions button[data-command="reset"]\').click()',
    );
    await delay(250);
    await check(
      cdp,
      'Reset puts the whole recording back before the export section measures it',
      'document.querySelector("#timeline-status").textContent',
      (v) => /^\d+ captions?$/.test(String(v)),
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
    // The one case that used to look like a bug: a picture shorter than the track is the normal shape
    // here (a cut-down video against a full-length master), and the transport has to keep playing over
    // the blank frame instead of stopping or snapping to the picture's end. Whatever it decides, the
    // sources panel is where a person is told which of the two is carrying the programme.
    await check(
      cdp,
      'the sources panel compares the two lengths instead of leaving it to be discovered',
      'document.querySelector("#sources-message").textContent',
      (v) => /The picture is [\d.]+s and the track is [\d.]+s, so the programme is/.test(v),
    );
    await check(
      cdp,
      'and the badge says the result is a compromise, not a clean load',
      'document.querySelector("#sources-status").textContent',
      (v) => /^\u26a0 /.test(v),
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
    let progressChecked = false;
    let completionChecked = false;
    // ---- stopping an export -------------------------------------------------
    // Cancel used to be disabled for the whole run, so a long export could not be given up on: the
    // button looked actionable and did nothing at all. It now stops the job through the AbortSignal the
    // encoder already accepted, and reports a stop rather than dressing it up as a failure.
    await reSelectVideo();
    await evaluate(cdp, `window.__openExport({ format: 'mp4', quality: 'high', resolution: 'source' })`);
    const blobsBeforeStop = await evaluate(cdp, 'window.__blobSizes.length');
    await evaluate(cdp, 'document.querySelector("#export-dialog-go").click()');
    const runningPercent = '(()=>{const m=/^(\\d+)%$/.exec(document.querySelector("#export-dialog-percent").textContent);return m?Number(m[1]):-1})()';
    await waitFor(cdp, runningPercent, (v) => v >= 5 && v < 100, {
      attempts: 200,
      intervalMs: 100,
      describe: 'the export to be genuinely mid-encode',
    });
    const stopButton = '[...document.querySelectorAll("#export-dialog button")].find((b)=>/^(cancel|stop)/i.test(b.textContent.trim()))';
    await check(
      cdp,
      'a running export offers to stop itself instead of a dead Cancel button',
      `(()=>{const c=${stopButton};return [c.textContent.trim(), c.disabled].join("/")})()`,
      (v) => v === 'Stop export/false',
    );
    await evaluate(cdp, `${stopButton}.click()`);
    await waitFor(cdp, 'document.querySelector("#export-dialog-go").disabled', (v) => v === false, {
      attempts: 100,
      intervalMs: 100,
      describe: 'the stopped export to settle',
    });
    await check(
      cdp,
      'stopping it reports a stop rather than a failure, and leaves the window usable',
      '(()=>{const bar=document.querySelector("#export-dialog-bar").classList;return {percent:document.querySelector("#export-dialog-percent").textContent,note:document.querySelector("#export-dialog-note").textContent,cancelled:bar.contains("cancelled"),failed:bar.contains("failed")}})()',
      (v) =>
        v.cancelled === true &&
        v.failed === false &&
        v.percent === 'stopped' &&
        /no file was written/.test(String(v.note)),
    );
    await check(
      cdp,
      'and the export that was stopped wrote no file at all',
      'window.__blobSizes.length',
      (v) => v === blobsBeforeStop,
    );
    await evaluate(cdp, 'document.querySelector("#export-dialog").close()');

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
      // The window the report asked for: a bar with a real height, and a percentage to read. Both
      // were missing before — `.progress` had no rule of its own inside the dialog, so the track and
      // the bar inside it rendered zero pixels tall and an export ran with no visible sign at all.
      // Measured while the dialog is open, because a closed `<dialog>` is `display: none`.
      if (!progressChecked) {
        progressChecked = true;
        await check(
          cdp,
          'the export window shows a progress track with a real height rather than an invisible one',
          '(()=>{const t=document.querySelector("#export-dialog-progress").getBoundingClientRect();const b=document.querySelector("#export-dialog-bar").getBoundingClientRect();return {track:Math.round(t.height),bar:Math.round(b.height),trackWidth:Math.round(t.width)}})()',
          (v) => v.track >= 6 && v.bar >= 6 && v.trackWidth > 100,
        );
        await check(
          cdp,
          'and a percentage to read rather than a bar that has to be judged',
          'document.querySelector("#export-dialog-percent").textContent',
          (v) => /^\d+%$/.test(String(v)),
        );
      }
      const before = await evaluate(cdp, 'window.__blobSizes.length');
      const started = Date.now();
      await evaluate(cdp, 'document.querySelector("#export-dialog-go").click()');
      try {
        await waitFor(
          cdp,
          `window.__blobSizes.length > ${before} && !document.querySelector("#export-status").textContent.includes("encoding")`,
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
      // `runExport` resolves with the file it wrote and the window reports it in the same tick, so a
      // short wait lets that continuation land before the finished state is read back.
      await delay(250);
      const finished = await evaluate(
        cdp,
        '(()=>({percent:document.querySelector("#export-dialog-percent").textContent,note:document.querySelector("#export-dialog-note").textContent}))()',
      );
      if (!completionChecked) {
        completionChecked = true;
        assert(
          'the window reports the finished file by name and size instead of its last progress line',
          /^Saved .+\.(mp4|webm) — [\d.]+ MB/.test(String(finished.note)),
          `the note read ${JSON.stringify(finished.note)}`,
        );
        assert(
          'and reads 100% rather than a stalled percentage',
          finished.percent === '100%',
          `the percentage read ${JSON.stringify(finished.percent)}`,
        );
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
      (v) => v === SAVED_TAG,
    );
    await check(
      cdp,
      'and named the file it wrote, in the export panel',
      'document.querySelector("#export-message").textContent',
      (v) => /Saved .+\.mp4/.test(String(v)),
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
    // How the picture was read, which is the difference between an export that takes as long as
    // decoding takes and one that takes 1448 ms per frame. Both are real paths and either *works* —
    // but only one of them is the fast one, and a silent fall back to the other is exactly the kind
    // of regression an export that has already been made 13x faster is going to suffer.
    await check(
      cdp,
      'the picture is decoded in order rather than seeked once per frame',
      'document.querySelector("#log").textContent.includes("decoded in order")',
      (v) => v === true,
    );
    await check(
      cdp,
      'and nothing fell back to stepping the picture through the browser',
      'document.querySelector("#log").textContent.includes("stepping it through the browser")',
      (v) => v === false,
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

  console.log('\n■ a picture shorter than the track');
  // The bug this round fixes, measured through the real transport instead of by calling the model:
  // with a 5 s picture under a longer master, playback stopped when the picture ran out. The programme
  // is its longest part, so the sound carries it — and the picture layer goes blank rather than
  // freezing on its last frame while the track plays on over it.
  const longTrack = `(() => {
    const rate = 8000, seconds = 8, samples = rate * seconds;
    const bytes = new Uint8Array(44 + samples * 2);
    const dv = new DataView(bytes.buffer);
    const ascii = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ascii(36, 'data'); dv.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 8000), true);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'master.wav', { type: 'audio/wav' }));
    const input = document.querySelector('#audio-in');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return input.files.length;
  })()`;
  await check(cdp, 'a master track longer than the picture can be loaded', longTrack, (v) => v === 1);
  await waitFor(
    cdp,
    '(()=>{const a=document.querySelector("#preview-audio");return a.readyState>=1&&a.duration>7})()',
    (v) => v === true,
    { describe: 'the 8s master track to decode' },
  );

  // Started just before the picture's end, so what is measured is the handover rather than five
  // seconds of ordinary playback.
  await evaluate(
    cdp,
    `(()=>{const s=document.querySelector('#seek');s.value='4.4';s.dispatchEvent(new Event('input',{bubbles:true}));return s.value})()`,
  );
  await delay(200);
  await evaluate(cdp, 'document.querySelector("#play-btn").click()');
  await waitFor(
    cdp,
    '(()=>{const a=document.querySelector("#preview-audio");return Number(a.currentTime.toFixed(2))>6.2})()',
    (v) => v === true,
    { attempts: 120, intervalMs: 100, describe: "the transport to carry on past the picture's end" },
  );
  const past = await evaluate(
    cdp,
    '(()=>({label:document.querySelector("#play-btn").textContent,audio:Number(document.querySelector("#preview-audio").currentTime.toFixed(2)),videoEnded:document.querySelector("#preview-video").ended,visibility:document.querySelector("#preview-video").style.visibility}))()',
  );
  assert(
    'a picture shorter than the track no longer stops the programme at the picture',
    past.audio > 6.2 && past.videoEnded === true && String(past.label).includes('Pause'),
    `the track was at ${past.audio}s with the picture ended, and the button said ${JSON.stringify(past.label)}`,
  );
  assert(
    'and the picture layer goes blank rather than freezing on its last frame',
    past.visibility === 'hidden',
    `visibility was ${JSON.stringify(past.visibility)}`,
  );
  await evaluate(cdp, 'document.querySelector("#play-btn").click()'); // stop it again

  console.log('\n■ the preview copy (preview only — the export keeps the original)');
  // A 640×360 picture is small enough that the copy is not even offered, which is the first half of
  // the rule: the feature exists for pictures that actually stall a transport.
  await check(
    cdp,
    'a picture that decodes fine is not offered a copy at all',
    'document.querySelector("#proxy-build").disabled',
    (v) => v === true,
  );
  await check(
    cdp,
    'and the panel says what a copy would be for, and that the export is untouched',
    'document.querySelector("#proxy-note").textContent',
    (v) => String(v).includes('Export always encodes the original file'),
  );
  // Then the copy itself, built through the real module in a real browser: a real decode, a canvas,
  // real WebCodecs encoders, the real muxer. This is the half no unit test can reach.
  //
  // The fixture is made **with a soundtrack**, which the page's own test picture has not got, because
  // the one thing a preview copy must not silently lose is the sound — and "is the captured track
  // silent?" is a question about this browser's behaviour, not about this code. The copy is then
  // *played back* and counted frame by frame: a copy that stutters is exactly the failure the rewrite
  // of this module was for, and the only way to catch it is to watch the file play.
  const sourceSrcBefore = await evaluate(cdp, 'document.querySelector("#preview-video").src');
  const proxyRun = await evaluate(
    cdp,
    `(async () => {
      try {
        const mod = await import('./src/io/preview-proxy.js');
        if (!mod.proxySupported()) return { skipped: true };
        const { Muxer, ArrayBufferTarget } = await import('./vendor/muxers/webm-muxer.mjs');

        // ---- a fixture with a picture and a 440 Hz tone, built here so no gitignored file is needed
        const W = 320, H = 180, FPS = 30, SECONDS = 4, TONE = 440;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const g = canvas.getContext('2d');
        const vchunks = [];
        const venc = new VideoEncoder({ output: (c, m) => vchunks.push({ t: c.timestamp, c, m }), error: () => {} });
        venc.configure({ codec: 'vp09.00.10.08', width: W, height: H, bitrate: 800000, framerate: FPS });
        for (let i = 0; i < FPS * SECONDS; i++) {
          g.fillStyle = 'hsl(' + ((i * 5) % 360) + ' 80% 45%)';
          g.fillRect(0, 0, W, H);
          g.fillStyle = '#fff';
          g.fillRect((i * 6) % W, 60, 30, 30);
          const frame = new VideoFrame(canvas, { timestamp: Math.round((i / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
          venc.encode(frame, { keyFrame: i % 30 === 0 });
          frame.close();
        }
        await venc.flush();
        venc.close();
        const achunks = [];
        const aenc = new AudioEncoder({ output: (c, m) => achunks.push({ t: c.timestamp, c, m }), error: () => {} });
        aenc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
        const per = 960; // 20 ms
        const samples = new Float32Array(per);
        for (let n = 0; n < Math.ceil((SECONDS * 48000) / per); n++) {
          for (let k = 0; k < per; k++) samples[k] = Math.sin(2 * Math.PI * TONE * ((n * per + k) / 48000)) * 0.4;
          const data = new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: per,
            numberOfChannels: 1,
            timestamp: Math.round((n * per / 48000) * 1e6),
            data: samples,
          });
          aenc.encode(data);
          data.close();
        }
        await aenc.flush();
        aenc.close();

        // Both muxers want monotonically increasing timestamps, so the fixture is written in time
        // order too — the same merge the module itself does.
        const target = new ArrayBufferTarget();
        const fixtureMuxer = new Muxer({
          target,
          video: { codec: 'V_VP9', width: W, height: H, frameRate: FPS },
          audio: { codec: 'A_OPUS', numberOfChannels: 1, sampleRate: 48000 },
        });
        const ordered = [
          ...vchunks.map((e) => ({ ...e, kind: 'video' })),
          ...achunks.map((e) => ({ ...e, kind: 'audio' })),
        ].sort((a, b) => a.t - b.t || (a.kind === 'video' ? -1 : 1));
        for (const entry of ordered) {
          if (entry.kind === 'video') fixtureMuxer.addVideoChunk(entry.c, entry.m);
          else fixtureMuxer.addAudioChunk(entry.c, entry.m);
        }
        fixtureMuxer.finalize();
        const url = URL.createObjectURL(new Blob([target.buffer], { type: 'video/webm' }));

        // ---- the copy ----
        const started = performance.now();
        const result = await mod.buildPreviewProxy({ url, size: { width: 160, height: 90 }, fps: 30 });
        const copySeconds = (performance.now() - started) / 1000;

        // ---- what the copy sounds like: decoded back, and measured rather than eyeballed ----
        let rms = 0;
        try {
          const context = new AudioContext();
          const decoded = await context.decodeAudioData(await result.blob.arrayBuffer());
          const channel = decoded.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
          rms = Math.sqrt(sum / Math.max(1, channel.length));
          context.close();
        } catch (err) {
          rms = -1;
        }

        // ---- how the copy plays: every frame the browser actually presents ----
        const copyUrl = URL.createObjectURL(result.blob);
        const player = document.createElement('video');
        player.muted = true;
        player.playsInline = true;
        player.preload = 'auto';
        player.src = copyUrl;
        player.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;';
        document.body.appendChild(player);
        await new Promise((resolve) => player.addEventListener('loadedmetadata', resolve, { once: true }));
        let playedFrames = 0;
        const count = () => {
          playedFrames += 1;
          if (!player.ended) player.requestVideoFrameCallback(count);
        };
        player.requestVideoFrameCallback(count);
        await player.play();
        await new Promise((resolve) => {
          player.addEventListener('ended', resolve, { once: true });
          setTimeout(resolve, 6000);
        });
        const playedFor = player.currentTime;
        player.pause();
        player.remove();
        URL.revokeObjectURL(copyUrl);
        URL.revokeObjectURL(url);

        return {
          bytes: result.blob.size,
          width: result.width,
          height: result.height,
          seconds: Number(result.seconds.toFixed(2)),
          sourceSeconds: Number(result.sourceSeconds.toFixed(2)),
          audio: result.audio,
          audioError: result.audioError,
          mimeType: result.mimeType,
          frames: result.frames,
          sourceFrames: FPS * SECONDS,
          averageFps: result.averageFps,
          videoBitrate: result.videoBitrate,
          audioCodec: result.audioCodec,
          codec: result.codec,
          sourceCodec: result.sourceCodec,
          summary: result.summary,
          copySeconds: Number(copySeconds.toFixed(2)),
          rms: Number(rms.toFixed(4)),
          playedFor: Number(playedFor.toFixed(2)),
          playedFrames,
        };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    })()`,
    { timeout: 120 },
  );
  if (proxyRun?.skipped) {
    console.log('  \u2022 skipped \u2014 this browser has no WebCodecs VideoEncoder');
  } else if (proxyRun?.error) {
    assert('a preview copy can be built from the loaded picture', false, proxyRun.error);
  } else {
    assert(
      'a smaller copy of the picture really is produced, here, from the file that is loaded',
      proxyRun.bytes > 2000 && proxyRun.width === 160 && proxyRun.height === 90,
      `got ${JSON.stringify(proxyRun)}`,
    );
    assert(
      'and it runs for about as long as the picture it was copied from',
      proxyRun.sourceSeconds > 3.5 && Math.abs(proxyRun.seconds - proxyRun.sourceSeconds) < 0.5,
      `the copy is ${proxyRun.seconds}s of a ${proxyRun.sourceSeconds}s picture`,
    );
    // The fixture is exactly `FPS * SECONDS` frames long, and every one of them has to be in the
    // copy. This is the check the wall-clock version of this feature could not pass: it wrote the
    // frames a hidden <video> happened to present on the way past, which on a heavy file is a
    // fraction of them - a "smoother" copy that had thrown away half the motion.
    assert(
      'every frame of the picture is in the copy, not just the ones a clock had time for',
      proxyRun.frames === proxyRun.sourceFrames,
      `the copy holds ${proxyRun.frames} frame(s) of the ${proxyRun.sourceFrames} in the picture it was made from`,
    );
    assert(
      'and the copy is made without playing the picture through',
      proxyRun.copySeconds < proxyRun.sourceSeconds - 1,
      `a copy of a ${proxyRun.sourceSeconds}s picture took ${proxyRun.copySeconds}s to make`,
    );
    assert(
      'the copy carries the picture\u2019s own soundtrack, and it is not silence',
      proxyRun.audio === true && proxyRun.rms > 0.02,
      `audio=${proxyRun.audio}, rms=${proxyRun.rms}${proxyRun.audioError ? `, the encoder said: ${proxyRun.audioError}` : ''}`,
    );
    assert(
      'and the copy itself plays without dropping frames \u2014 measured, not assumed',
      proxyRun.playedFrames >= 80 && proxyRun.playedFor >= 3.5,
      `the copy presented ${proxyRun.playedFrames} frame(s) over ${proxyRun.playedFor}s`,
    );
    console.log(
      `  \u2022 the copy: ${proxyRun.width}\u00d7${proxyRun.height} ${proxyRun.codec}, ${proxyRun.bytes} bytes, ` +
        `${proxyRun.seconds}s of ${proxyRun.sourceSeconds}s, sound ${proxyRun.audio ? `captured (rms ${proxyRun.rms})` : 'not captured'}, ${proxyRun.mimeType}`,
    );
    console.log(`  \u2022 ${proxyRun.summary}; converted in ${proxyRun.copySeconds}s`);
    console.log(
      `  \u2022 played back: ${proxyRun.playedFrames} frames over ${proxyRun.playedFor}s ` +
        `(${(proxyRun.playedFrames / Math.max(0.01, proxyRun.playedFor)).toFixed(1)} fps)`,
    );
  }
  await check(
    cdp,
    'building a copy does not disturb the picture already on screen',
    'document.querySelector("#preview-video").src',
    (v) => v === sourceSrcBefore,
  );

  console.log('\n■ a copy builds itself');
  // The picture this run has been using is 640x360, which is *not* offered a copy — so this section
  // brings its own: a second of 1080p, encoded here, loaded through the panel's own file input. 1080p
  // on purpose, because it is the size that used to be waved through ("1080p decodes fine") and is now
  // the size the preview is copied down to 720p for. Nothing is clicked: whether a copy appears without
  // being asked for is the whole question.
  const auto = await evaluate(
    cdp,
    `(async () => {
      try {
        const mod = await import('./src/io/preview-proxy.js');
        if (!mod.proxySupported()) return { skipped: true };
        const { Muxer, ArrayBufferTarget } = await import('./vendor/muxers/webm-muxer.mjs');

        // ---- a one-second 1080p picture, made with the same WebCodecs the feature uses
        const W = 1920, H = 1080, FPS = 30, SECONDS = 1;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const g = canvas.getContext('2d');
        const chunks = [];
        const enc = new VideoEncoder({ output: (c, m) => chunks.push({ c, m }), error: () => {} });
        enc.configure({ codec: 'vp09.00.10.08', width: W, height: H, bitrate: 1000000, framerate: FPS });
        for (let i = 0; i < FPS * SECONDS; i++) {
          g.fillStyle = 'hsl(' + ((i * 11) % 360) + ' 70% 40%)';
          g.fillRect(0, 0, W, H);
          g.fillStyle = '#fff';
          g.fillRect((i * 20) % W, 400, 60, 60);
          const frame = new VideoFrame(canvas, { timestamp: Math.round((i / FPS) * 1e6), duration: Math.round(1e6 / FPS) });
          enc.encode(frame, { keyFrame: i % 15 === 0 });
          frame.close();
        }
        await enc.flush();
        enc.close();
        const target = new ArrayBufferTarget();
        const muxer = new Muxer({ target, video: { codec: 'V_VP9', width: W, height: H, frameRate: FPS } });
        for (const entry of chunks) muxer.addVideoChunk(entry.c, entry.m);
        muxer.finalize();
        const blob = new Blob([target.buffer], { type: 'video/webm' });

        // ---- loaded the way a person loads one
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'big-picture.webm', { type: 'video/webm' }));
        const input = document.querySelector('#video-in');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));

        // ---- and then nobody touches anything
        const note = document.querySelector('#proxy-note');
        const clear = document.querySelector('#proxy-clear');
        const started = performance.now();
        let sawBuilding = false;
        while (performance.now() - started < 90000) {
          const text = note.textContent;
          if (clear.textContent === 'Stop copying' || /copying/.test(text)) sawBuilding = true;
          if (/Export still encodes the original 1920/.test(text)) {
            return {
              sawBuilding,
              seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
              note: text,
              src: document.querySelector('#preview-video').src,
              clearLabel: clear.textContent,
              size: document.querySelector('#video-note').textContent,
            };
          }
          if (/could not be made/.test(text)) return { error: text };
          await new Promise((r) => setTimeout(r, 200));
        }
        return { error: 'no copy arrived: ' + note.textContent };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    })()`,
    { timeout: 150 },
  );
  if (auto?.skipped) {
    console.log('  \u2022 skipped — this browser has no WebCodecs VideoEncoder');
  } else if (auto?.error) {
    assert('a 1080p picture gets a copy without anybody pressing the button', false, auto.error);
  } else {
    assert(
      'a 1080p picture bigger than the preview gets a copy with nobody having asked',
      auto.sawBuilding === true,
      `the panel never showed a copy being built: ${JSON.stringify(auto)}`,
    );
    assert(
      'and it is a 720p copy — a quarter of the pixels of the 1080p file, for the preview only',
      /1280\u00d7720/.test(auto.note),
      `the note said ${JSON.stringify(auto.note)}`,
    );
    assert(
      'the preview moves onto the copy, and the export stays on the original 1080p picture',
      String(auto.src).startsWith('blob:') && /Export still encodes the original 1920\u00d71080/.test(auto.note),
      `src ${JSON.stringify(auto.src)} with the note ${JSON.stringify(auto.note)}`,
    );
    assert(
      'and the picture itself is untouched — the copy is not what the export would encode',
      /1920\u00d71080/.test(auto.size),
      `the panel says ${JSON.stringify(auto.size)}`,
    );
    console.log(`  \u2022 it built itself in ${auto.seconds}s: ${auto.note}`);
  }

  console.log('\n■ the copy\u2019s resolution is the user\u2019s to pick');
  // The 1080p picture from the section above is still loaded, with a 720p copy playing. The picker is
  // the one control that decides how big a copy is, so it is exercised the way a person exercises it:
  // choose a rung, and watch the copy become that rung. No button is pressed — changing the size is
  // itself the instruction, and stopping first would be a second decision nobody asked for.
  const picked = await evaluate(
    cdp,
    `(async () => {
      const select = document.querySelector('#proxy-size');
      if (!select) return { error: 'there is no size picker' };
      const options = [...select.options].map((o) => o.value);
      const note = document.querySelector('#proxy-note');
      const video = document.querySelector('#preview-video');
      // The element's own size, waited for rather than read once. A panel note about a copy is
      // published as the copy is handed to the transport, and the element's load() has just taken its
      // dimensions down to 0x0 until the new file's metadata arrives - so reading videoWidth in that
      // window is how a correct swap reads as a 0x0 picture. It is a read of the element that is being
      // waited for, not a weaker claim: the size is still asserted below, exactly as it was.
      const elementPicture = async () => {
        const until = performance.now() + 30000;
        while (performance.now() < until) {
          if (video.videoWidth > 0) return video.videoWidth + '\u00d7' + video.videoHeight;
          await new Promise((r) => setTimeout(r, 100));
        }
        return '0\u00d70';
      };
      const chosen = async (id, wanted) => {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const until = performance.now() + 60000;
        let matched = false;
        while (performance.now() < until) {
          await new Promise((r) => setTimeout(r, 200));
          const text = note.textContent;
          if (/could not be made/.test(text)) return { id, error: text };
          if (wanted.test(text)) {
            matched = true;
            break;
          }
        }
        const picture = await elementPicture();
        return { id, matched, note: note.textContent, video: picture };
      };
      const first = await chosen('480p', /854\u00d7480 copy/);
      const back = await chosen('1080p', /previewing the original/i);
      return { options, first, back };
    })()`,
    { timeout: 180 },
  );
  if (picked?.error) {
    assert('the panel offers a copy size the user can choose', false, picked.error);
  } else {
    assert(
      'the panel offers a ladder of copy sizes, biggest first, with 720p the default',
      Array.isArray(picked.options) && picked.options.join(',') === '1080p,720p,540p,480p,360p',
      `the picker offered ${JSON.stringify(picked.options)}`,
    );
    assert(
      'choosing 480p rebuilds the copy at 480p, without anyone pressing a button',
      picked.first.matched === true && /preview is a 854\u00d7480 copy/.test(String(picked.first.note)),
      `the panel said ${JSON.stringify(picked.first.note)}`,
    );
    assert(
      'and the preview element really is a smaller picture than the master',
      picked.first.video === '854\u00d7480',
      `the element reported ${picked.first.video}` +
        `${picked.first.matched ? '' : ' and the panel never said the copy was a 854\u00d7480 one'}`,
    );
    assert(
      'and the export still encodes the original 1920\u00d71080 master at 480p',
      /Export still encodes the original 1920\u00d71080/.test(String(picked.first.note)),
      `the panel said ${JSON.stringify(picked.first.note)}`,
    );
    // 1080p is the master's own size, so there is nothing to copy down to: the preview goes back to the
    // file that was loaded rather than building a copy of equal size.
    assert(
      'picking a rung the picture is not bigger than sends the preview back to the original',
      /previewing the original/i.test(String(picked.back.note)) && picked.back.video === '1920\u00d71080',
      `the panel said ${JSON.stringify(picked.back.note)} and the element was ${picked.back.video}`,
    );
    console.log(
      `  \u2022 the ladder: ${picked.options.join(' \u2192 ')}; 480p rebuilt the copy and 1080p sent the preview back to the master`,
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
