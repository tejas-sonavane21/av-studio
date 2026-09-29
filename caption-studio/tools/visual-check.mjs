/**
 * tools/visual-check.mjs — run the visual parity harness in headless Chrome and print the verdict.
 *
 *     npm run visual                  # reference: the real video.mp4, 6 sample frames
 *     npm run visual -- --ref overlay # reference: v10's own transparent overlay
 *     npm run visual -- --samples 12
 *
 * ## Why this exists (and why not `--dump-dom`)
 *
 * `chrome --headless --dump-dom` was the obvious first attempt and it does not work here: to make
 * Chrome wait for asynchronous work you have to pass `--virtual-time-budget`, which fast-forwards
 * timers — so the harness's own 15-second "waiting for video metadata" guard fires in a few
 * milliseconds and the run fails before a 56 MB video has loaded a single byte.
 *
 * So instead we drive a real headless Chrome over the DevTools protocol, in real time: launch it,
 * poll `window.__parityState` until the page says it is finished, and print the result. That also
 * makes the check repeatable and CI-shaped rather than something a human has to eyeball.
 *
 * Everything is self-contained: this script starts the dev server (rooted at the repository so the
 * reference media is reachable), runs the check, and tears both down.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      if (existsSync(path)) return path;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return null;
}

/** Parse `--key value` / `--flag` pairs. */
function parseArgs(argv) {
  const out = { ref: 'video', samples: 6, port: 8199, cdpport: 9333, keep: false, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        out[key] = Number.isNaN(Number(value)) ? value : Number(value);
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const chromePath = findChrome();

if (!chromePath) {
  console.error('No Chrome found. Set CHROME_PATH to chrome.exe and retry.');
  process.exit(2);
}

const children = [];
function launch(command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') {
        // Chrome spawns a tree of helper processes; a plain kill leaves them holding the profile
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* best effort */
    }
  }
}

process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

/** Poll until a URL answers with a success status. Returns true/false. */
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

/**
 * Poll until a JSON endpoint answers. Returns the parsed body or null.
 * (Separate from `waitForOk` on purpose — trying to JSON-parse an HTML page throws, which reads
 * as "the server is down" when it is in fact serving fine.)
 */
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

/** A minimal DevTools-protocol client over the global WebSocket. */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const consoleLines = [];

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
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (text) consoleLines.push(text);
    }
  });

  const send = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  };

  return { send, consoleLines, close: () => ws.close() };
}

async function main() {
  // ---- dev server (rooted at the repository, so ../referece_material/ is reachable) ----------
  const server = launch(process.execPath, [resolve(PROJECT_ROOT, 'tools/serve.mjs'), String(args.port), '..'], {
    cwd: PROJECT_ROOT,
  });
  server.stdout.on('data', (d) => process.stdout.write(`[serve] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));

  const harnessUrl =
    `http://localhost:${args.port}/caption-studio/tests/visual/parity.html` +
    `?autorun=1&samples=${args.samples}&refpreset=${args.ref}`;

  const harnessOk = await waitForOk(harnessUrl, { attempts: 40 });
  const mediaOk = harnessOk && (await waitForOk(`http://localhost:${args.port}/referece_material/version10/spidy.srt`));
  if (!harnessOk || !mediaOk) {
    console.error(
      `\ndev server check failed on port ${args.port}: harness=${harnessOk ? 'ok' : 'unreachable'}, ` +
        `reference media=${mediaOk ? 'ok' : 'unreachable'}.\n` +
        (harnessOk
          ? 'The server started but the repository root is not reachable — run from caption-studio/ so `..` resolves.\n'
          : 'Is something already using the port? Try --port <n>.\n'),
    );
    stopAll();
    process.exit(2);
  }

  console.log(`■ chrome   ${chromePath}`);
  console.log(`■ harness  ${harnessUrl}`);
  console.log(`■ root     ${WORKSPACE_ROOT}\n`);

  // ---- headless chrome with remote debugging ------------------------------------------------
  // keep the throwaway profile out of the project folder
  const profile = join(tmpdir(), `caption-studio-visual-${args.cdpport}`);
  launch(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=Translate,BackForwardCache',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${args.cdpport}`,
      harnessUrl,
    ],
    { stdio: 'ignore' },
  );

  const version = await waitForJson(`http://127.0.0.1:${args.cdpport}/json/version`);
  if (!version) {
    console.error('headless Chrome never exposed its debugging port');
    stopAll();
    process.exit(2);
  }

  // find the page target (the harness URL we launched with)
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await waitForJson(`http://127.0.0.1:${args.cdpport}/json/list`, { attempts: 1 });
    target = (list ?? []).find((t) => t.type === 'page' && t.url.includes('parity.html'));
    if (!target) await delay(250);
  }
  if (!target?.webSocketDebuggerUrl) {
    console.error('could not find the harness page target in Chrome');
    stopAll();
    process.exit(2);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // ---- wait for the page to finish, reporting progress --------------------------------------
  const deadline = Date.now() + args.timeout * 1000;
  let state = null;
  let seenLogLines = 0;
  let framesSeen = -1;

  while (Date.now() < deadline) {
    const res = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ state: window.__parityState ?? null, log: window.__parityLog ?? [] })',
      returnByValue: true,
    });
    const raw = res?.result?.result?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const line of parsed.log.slice(seenLogLines)) console.log(`  ${line}`);
      seenLogLines = parsed.log.length;
      if (parsed.state) {
        state = parsed.state;
        if ((state.frames?.length ?? 0) !== framesSeen && state.frames?.length) {
          framesSeen = state.frames.length;
        }
        if (state.status !== 'running' && state.status !== 'not-run') break;
      }
    }
    await delay(600);
  }

  cdp.close();

  if (!state || state.status === 'running') {
    console.error('\n✖ the harness never finished (timeout). Try a longer --timeout.');
    stopAll();
    process.exit(2);
  }

  // ---- report -------------------------------------------------------------------------------
  console.log('\n── verdict ────────────────────────────────────────────────');
  console.log(JSON.stringify(state, null, 2));

  const failed = state.status === 'fail' || state.status === 'error';
  console.log('\n' + (failed ? '✖ FAIL' : '✔ ' + state.status.toUpperCase()));

  if (!args.keep) stopAll();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('visual-check crashed:', err);
  stopAll();
  process.exit(2);
});
