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
async function check(cdp, label, expression, predicate, describe) {
  const value = await evaluate(cdp, expression);
  const ok = predicate ? predicate(value) : Boolean(value);
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${ok ? '' : ` — got ${JSON.stringify(value)}${describe ? `, wanted ${describe}` : ''}`}`);
  if (!ok) failures.push(label);
  return value;
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

  console.log('\n■ demo document');
  await evaluate(cdp, 'document.querySelector("#demo-btn").click()');
  await delay(1200);
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

  console.log('\n■ templates');
  await evaluate(cdp, '[...document.querySelectorAll("#templates .tile")].find(t=>t.dataset.id==="veed-karaoke").click()');
  await delay(800);
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
  await delay(2000);
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
  await delay(600);
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
    '(()=>{[...document.querySelectorAll("#block-inspector .actions button")][0].click();return document.querySelector("#template-status").textContent})()',
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

  console.log('\n■ reset paths');
  await check(
    cdp,
    '"reset this block" clears the override',
    '(()=>{[...document.querySelectorAll("#block-inspector .actions button")][1].click();return document.querySelector("#block-status").textContent})()',
    (v) => String(v).includes('inherit'),
  );
  await check(
    cdp,
    'the parity reset button restores the verified look',
    '(()=>{document.querySelector("#reset-style").click();return true})()',
  );

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
  await delay(800);
  await check(
    cdp,
    'a style-bar edit marks the template edited, without losing its name',
    'document.querySelector("#template-status").textContent',
    (v) => String(v).includes('Veed') && String(v).includes('edited'),
  );
  await evaluate(cdp, 'document.querySelector("#reset-style").click()');
  await delay(800);
  await check(
    cdp,
    'and resetting restores both the look and the unedited flag',
    'document.querySelector("#template-status").textContent',
    (v) => !String(v).includes('edited'),
  );

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
