/**
 * export-perf.mjs — where an export's time actually goes.
 *
 * "The export is slow" is a claim about a pipeline of five different jobs, and the useful answer is a
 * number per job rather than a theory about which one is at fault. The export steps one output frame
 * at a time, and each frame costs:
 *
 *   1. **a seek** — the picture is seeked to that frame's own source time and the element is waited
 *      on, which on a large file is a decoder flush plus a decode from the previous keyframe;
 *   2. **a composite** — the picture is drawn onto the output canvas, then any overlay clips;
 *   3. **the captions** — the caption layer is rasterised and drawn on top;
 *   4. **an encode** — the canvas becomes a `VideoFrame` and is handed to `VideoEncoder`, whose queue
 *      is drained so a long export does not pile up in memory.
 *
 * This harness times each of the four in the real module, in real Chrome, on a real file, and then
 * runs two experiments that decide what can be done about the result:
 *
 *   * **what the extra paint wait costs** — `seekToFrame` waits one animation frame after `seeked`
 *     ("belt-and-braces", says its comment). Two arms step the same frames with and without it, and
 *     each returns a hash per frame, so the question "does that wait change the picture" is answered
 *     with pixels rather than with an opinion.
 *   * **what the export costs end to end** — the real `exportDocumentToVideo`, over a *cut* of the
 *     file (`timeline.video.ranges`), with `instrument: true`. A cut is how a 5 s slice of a 161 s
 *     capture is asked for: no second fixture, and no knob in the export that exists only for this.
 *
 * The phase totals are wall clock, which is what the user waits: the encoder runs on its own thread
 * while the next frame is being sought, so a phase that looks cheap here is not necessarily cheap in
 * CPU — but a phase that is expensive here is expensive in the only currency the user pays.
 *
 * Usage:
 *   node tools/export-perf.mjs --video <path> [--audio <path>] [--start 15] [--seconds 6]
 *                              [--size 1920x1080] [--fps 30] [--quality high] [--format mp4]
 *                              [--frames 30] [--label baseline]
 *
 * `--video` is relative to the **workspace** (the folder above this project), because the only large
 * pictures on this machine are the gitignored reference captures — same rule as `preview-perf.mjs`.
 *
 * Caveat, stated rather than buried: this drives **headless** Chrome, which on this machine decodes
 * a 2160p AV1 capture in software. The absolute numbers are therefore a worst case and not the
 * user's numbers. What transfers is the *shape* — which phase dominates, and what removing it buys.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');

const args = {
  port: 8197,
  cdpport: 9397,
  start: 15,
  seconds: 6,
  frames: 30,
  fps: 30,
  quality: 'high',
  format: 'mp4',
  size: { width: 1920, height: 1080 },
  label: '',
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--video') args.video = process.argv[++i];
  else if (a === '--audio') args.audio = process.argv[++i];
  else if (a === '--clip') args.clip = process.argv[++i];
  else if (a === '--start') args.start = Number(process.argv[++i]);
  else if (a === '--seconds') args.seconds = Number(process.argv[++i]);
  else if (a === '--frames') args.frames = Number(process.argv[++i]);
  else if (a === '--fps') args.fps = Number(process.argv[++i]);
  else if (a === '--quality') args.quality = process.argv[++i];
  else if (a === '--format') args.format = process.argv[++i];
  else if (a === '--size') {
    const [w, h] = String(process.argv[++i]).split('x').map(Number);
    args.size = { width: w, height: h };
  } else if (a === '--label') args.label = process.argv[++i];
  else if (a === '--port') args.port = Number(process.argv[++i]);
  else if (a === '--cdpport') args.cdpport = Number(process.argv[++i]);
  else if (a === '--skip-seek') args.skipSeek = true;
  else if (a === '--decoder') args.decoder = process.argv[++i];
  else if (a === '--compare') args.compare = Number(process.argv[++i]);
}
if (!args.video) {
  console.error('usage: node tools/export-perf.mjs --video <path relative to the workspace> [--audio <path>]');
  process.exit(2);
}

/**
 * A path given on the command line, found the way a person would write it.
 *
 * Relative to the workspace first, then inside `referece_material/` — the same two places
 * `preview-perf.mjs` looks, and for the same reason: the captures are gitignored, so naming one
 * should not take forty words.
 */
function locate(given) {
  const candidates = [resolve(WORKSPACE_ROOT, given), resolve(WORKSPACE_ROOT, 'referece_material', given)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`no such file: ${given}\n  looked in:\n    ${candidates.join('\n    ')}`);
    process.exit(2);
  }
  const relative = found.slice(WORKSPACE_ROOT.length).split('\\').join('/');
  return { path: found, url: encodeURI(relative) };
}

const video = locate(args.video);
const track = args.audio ? locate(args.audio) : null;
const clip = args.clip ? locate(args.clip) : null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
function launch(command, argv, options = {}) {
  const child = spawn(command, argv, { stdio: 'ignore', ...options });
  children.push(child);
  return child;
}
/**
 * Take the browser and the server down, and *wait* for it.
 *
 * Synchronously, because this runs on the way out: a `spawn`ed `taskkill` may not have been scheduled
 * before the process exits, the browser keeps the debugging port, and the next run then finds the port
 * taken and reports that "Chrome never opened a page" - which reads as a broken harness rather than as
 * a stray process from the last one.
 */
function stopAll() {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore' });
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

/** The smallest CDP client that does what this needs: one target, evaluate, wait. */
async function connect(cdpPort) {
  let target = null;
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
    if (!target) await delay(250);
  }
  if (!target) throw new Error(`Chrome never opened a page on ${cdpPort}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error('CDP websocket failed')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject: fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { resolve: ok, reject: fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

/**
 * Evaluate in the page, at most once every so often.
 *
 * A phase breakdown is only worth reading if the page was not busy: these arms run for minutes, so
 * the evaluate timeout is generous and every value comes back by value.
 */
async function evaluate(cdp, expression, { awaitPromise = true, timeout = 1800000 } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    timeout,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result?.value;
}

/** The phases the export times, in the order a frame meets them, and what each one is. */
const PHASES = [
  ['load', 'opening the off-screen decoder and reading the file'],
  ['duration', 'resolving the source duration'],
  ['clips', 'loading the overlay clips'],
  ['setup', 'the output canvases, the renderer and its fonts'],
  ['seek', 'stepping the picture: one seek per output frame'],
  ['clipSeek', 'stepping each overlay clip, per output frame'],
  ['composite', 'drawing the picture onto the output canvas'],
  ['captions', 'rasterising the caption layer and drawing it'],
  ['encode', 'handing the frame to the encoder, and waiting when its queue is full'],
  ['flush', 'the encoder finishing the frames still in it'],
  ['audioDecode', 'decoding the uploaded audio file'],
  ['audioEncode', 'encoding the soundtrack'],
  ['mux', 'writing the container'],
];

function ms(value) {
  return `${Math.round(Number(value) || 0)} ms`;
}

function report(label, rows) {
  console.log(`\n  ${label}`);
  for (const [name, what] of rows) console.log(`    ${name.padEnd(10)} ${what}`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found — set CHROME_PATH');

  launch('node', ['tools/serve.mjs', String(args.port), '..'], { cwd: PROJECT_ROOT });
  await delay(700);

  launch(chrome, [
    '--headless=new',
    `--remote-debugging-port=${args.cdpport}`,
    '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'export-perf-'))}`,
    'about:blank',
  ]);
  const cdp = await connect(args.cdpport);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const origin = `http://127.0.0.1:${args.port}`;
  const absolute = (relative) => new URL(relative, `${origin}/`).href;

  console.log(
    `export performance${args.label ? ` · ${args.label}` : ''}\n` +
      `  file      ${args.video}${args.audio ? ` + ${args.audio}` : ''}\n` +
      `  window    ${args.start}s + ${args.seconds}s, exported at ${args.size.width}x${args.size.height} ${args.fps}fps ${args.quality} .${args.format}\n` +
      `  decoder   ${args.decoder === 'element' ? 'seeked frame by frame (the path this export shipped with)' : 'decoded in order (Mediabunny)'}\n` +
      `  browser   headless Chrome (see the caveat in this file — this machine decodes AV1 in software)`,
  );

  await cdp.send('Page.navigate', { url: `${origin}/caption-studio/tools/export-perf.html` });
  await delay(1200);
  const ready = await evaluate(cdp, 'Boolean(window.__ready)', { awaitPromise: false });
  if (!ready) throw new Error('the harness page never finished importing the export module');
  if (track) {
    // The soundtrack is fetched by the page (same origin), because a Blob cannot cross the CDP border.
    console.log(`  audio     ${args.audio}`);
  }

  const prep = await evaluate(
    cdp,
    `window.__prep(${JSON.stringify({
      url: absolute(video.url),
      audioUrl: track ? absolute(track.url) : null,
      start: args.start,
      seconds: args.seconds,
      frames: args.frames,
      rate: args.fps,
      quality: args.quality,
      format: args.format,
      size: args.size,
      pictureDecoder: args.decoder === 'element' ? 'element' : 'auto',
      clipUrl: clip ? absolute(clip.url) : null,
    })})`,
  );
  if (prep.error) throw new Error(`${prep.error} (readyState ${prep.ready}, MediaError ${prep.error_code})`);
  console.log(
    `\n  loaded    ${prep.width}x${prep.height}, ${prep.duration.toFixed(1)}s — exporting ` +
      `${prep.window.seconds.toFixed(1)}s of it (${prep.captions} captions in the document)`,
  );

  // ---- the two seek arms -----------------------------------------------------
  //
  // The same frames, stepped twice: once with the paint wait `seekToFrame` does by default and once
  // without it. The hashes are what make this an experiment rather than a preference — if the two
  // lists are equal, the wait bought nothing, and if they differ, the wait is load-bearing.
  let withWait = null;
  let withoutWait = null;
  if (!args.skipSeek) {
    console.log(`\n  stepping ${args.frames} frames, twice (this is the slow part, by design)`);
    withWait = await evaluate(cdp, `window.__seekArm(true)`);
    withoutWait = await evaluate(cdp, `window.__seekArm(false)`);
    const perFrame = (arm) => arm.ms / arm.frames;
    const identical = withWait.hashes.join(',') === withoutWait.hashes.join(',');
    const differing = withWait.hashes.filter((h, i) => h !== withoutWait.hashes[i]).length;
    console.log(
      `    with the paint wait       ${perFrame(withWait).toFixed(1)} ms/frame  ` +
        `(${args.frames} frames in ${(withWait.ms / 1000).toFixed(1)}s)`,
    );
    console.log(
      `    without it                ${perFrame(withoutWait).toFixed(1)} ms/frame  ` +
        `(${args.frames} frames in ${(withoutWait.ms / 1000).toFixed(1)}s)`,
    );
    console.log(
      `    the frames are            ${identical ? 'identical, hash for hash — the wait changed no pixel' : `${differing} of ${args.frames} differ — the wait is load-bearing`}`,
    );
    console.log(
      `    a frame costs this much of the export's own time: ${(perFrame(withWait) - perFrame(withoutWait)).toFixed(1)} ms of pure waiting`,
    );
  }

  // ---- is it the same picture? -----------------------------------------------
  //
  // Run before the export, and only when asked for, because it is the slow arm: it decodes the same
  // frames twice, once through the element and once through the streaming reader.
  if (args.compare) {
    const compared = await evaluate(cdp, `window.__compareArm(${args.compare})`);
    const pct = (x) => `${(x * 100).toFixed(2)}%`;
    console.log(
      `\n  the same picture? ${compared.frames} frames decoded the old way and the new way, compared at ` +
        `${compared.width}x${compared.height} (source ${compared.sourceSize.width}x${compared.sourceSize.height})`,
    );
    console.log('    against the element path, per channel of RGBA, over every frame:');
    for (const v of compared.variants) {
      console.log(
        `      ${v.name}  [${v.canvas}]\n` +
          `        mean ${v.mean.toFixed(3)}/255 · worst ${v.worst}/255 · identical ${pct(v.exact)} · ` +
          `within 2 ${pct(v.within2)} · within 8 ${pct(v.within8)} · past 32 ${pct(v.past32)}`,
      );
      console.log(
        `        a one-pixel sideways shift would be ${v.shiftedRed > v.alignedRed ? 'worse' : 'better'} ` +
          `(${v.alignedRed.toFixed(2)} where it is, ${v.shiftedRed.toFixed(2)} shifted) — so the frame is ` +
          `${v.shiftedRed > v.alignedRed ? 'in the same place' : 'NOT in the same place'}`,
      );
    }
  }

  // ---- the real export -------------------------------------------------------
  const run = await evaluate(cdp, 'window.__exportArm()');
  const timings = run.timings;
  const total = Object.values(timings)
    .filter((v) => typeof v === 'number')
    .reduce((sum, v) => sum + v, 0) - timings.frames - timings.seconds; // the two counters are not phases
  const wall = run.wall;
  const perFrame = wall / run.frames;
  console.log(`\n  the real export: ${run.frames} frames, ${run.wall.toFixed(0)} ms wall clock`);
  console.log(`    ${run.size.width}x${run.size.height} ${run.fps}fps ${run.videoCodec}, ${(run.videoBitsPerSecond / 1e6).toFixed(1)} Mbps`);
  console.log(`    ${(run.bytes / 1e6).toFixed(1)} MB, ${run.frames} frames of ${run.seconds.toFixed(1)}s`);
  console.log(`    audio: ${run.audio ? run.audioCodec : run.audioSkipped ?? 'none'}`);
  console.log('\n    phase breakdown (wall clock, what the user waits):');
  for (const [name, what] of PHASES) {
    const value = Number(timings[name]) || 0;
    if (!value) continue;
    const share = wall > 0 ? (value / wall) * 100 : 0;
    console.log(`      ${name.padEnd(12)} ${ms(value).padStart(9)}  ${share.toFixed(1).padStart(5)}%  ${what}`);
  }
  console.log(`      ${'accounted'.padEnd(12)} ${ms(total).padStart(9)}  ${((total / wall) * 100).toFixed(1).padStart(5)}%  (the phases add up to this)`);
  console.log(`    picture: ${run.picture}${run.pictureNote ? ` (${run.pictureNote})` : ''}`);
  if (run.clipFrames || run.clips || run.clipsMissing?.length) {
    console.log(
      `    clips:   ${run.clipFrames} of ${run.frames} frames had a clip painted on them` +
        `${run.clips ? `, ${run.clips} decoded from a file` : ''}` +
        `${run.clipsMissing?.length ? `, ${run.clipsMissing.length} had no file loaded` : ''}`,
    );
  }
  if (run.blankFrames) console.log(`    ⚠ ${run.blankFrames} output frame(s) had no picture to draw`);
  console.log(`\n    ${perFrame.toFixed(1)} ms per frame — ${(1000 / perFrame).toFixed(2)} frames a second`);
  const projected = (frames, seconds) => ((perFrame * frames) / 1000 / 60).toFixed(1);
  console.log(
    `    at this rate a 161 s, 30 fps export is ${projected(161 * 30)} minutes ` +
      `(${prep.duration.toFixed(0)}s source, same picture)`,
  );
  if (!run.audio) console.log(`    (no soundtrack in this run: ${run.audioSkipped})`);

  cdp.close();
  stopAll();
}

main().catch((err) => {
  console.error(`export-perf failed: ${err.message}`);
  stopAll();
  process.exit(1);
});
