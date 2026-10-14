/**
 * preview-perf.mjs — what the preview actually does with a real, large picture.
 *
 * "The preview is choppy on a 4K file" is a claim about two very different pieces of work, and the
 * point of this harness is to tell them apart before anyone optimises the wrong one:
 *
 *   1. **the decoder** — a 3840x2160 AV1 video is decoded in software unless the machine has an AV1
 *      decoder in hardware, and the preview has no say in that at all;
 *   2. **the app** — the caption canvas, the timeline, the transport readouts: everything that runs
 *      once per animation frame next to that decoder, and steals the CPU it needs.
 *
 * So both are measured, in the same browser, on the same file, in the same run:
 *
 *   * **control** — a bare `<video>` on an otherwise empty page, playing the same file. This is the
 *     floor: no editor, no captions, no timeline. It separates (1) from (2).
 *   * **editor** — the real page, with the picture and the track loaded, playing for the same time.
 *
 * Two numbers are reported for each: the frames the *browser drew* (rAF) and the frames the *video
 * actually presented* (`requestVideoFrameCallback`). When the video presents 30/s and rAF is at 12/s,
 * the app is the problem; when the video presents 6/s, no amount of app-side work will help.
 *
 * `--proxy` adds a third arm, and it is the one that answers "is the preview copy worth making?": the
 * copy is built through the editor's own button (the real module, the real decoder, the real encoder),
 * and then the same editor is measured again playing *that* file.
 *
 * The copy builds itself on load now, which the run has to account for twice over: the automatic pass is
 * stopped through the stop button before the editor arm — a build running underneath an arm would
 * measure contention instead of the app — and the picture is put back on the original, so that arm still
 * means what it always meant. The log line for it says which happened. The number to read is the middle
 * column - frames presented a second - against the editor arm's, because a copy that presents more of
 * the picture's motion per second than the original is the entire point of the feature, and a copy
 * that presents no more than the original is a feature that should be deleted.
 *
 * `--dpr <n>` runs the whole thing at a forced device pixel ratio, which is how the *other* cost was
 * supposed to be measured: the caption canvas is fitted to the stage and backed at `logical x DPR`, so
 * a 1400px stage on a 200% display asks the app to clear and rasterise 2800x1575 pixels every frame.
 * What it found instead is that the app's share of the cost does not depend on the display: the editor
 * presents about half the frames a bare element presents here at DPR 1 *and* at DPR 2, so a high-DPI
 * screen is not the thing to blame.
 *
 * `--hide-canvas` takes the caption canvas out of the document for the editor arm and leaves everything
 * else in place. The app still draws into it (a detached canvas is still a canvas), so what is removed
 * is the *compositing* of it and nothing else — the cost of putting that surface on screen every frame.
 * It was written to ask whether the caption canvas was stealing the decoder's CPU, and the answer is
 * no: at DPR 2 the editor arm presented 9.0-14.0 frames a second across runs with the canvas in place,
 * 14.0 with it removed and 12.4 with its backing store capped at 1x. One setting spreads as wide as the
 * difference between settings, and a flag that cannot move a number by more than the noise around it
 * says the surface is not the limit. Read it as "how much is this one surface costing", never as a
 * reading to chase unless a whole run moves it.
 *
 * Usage:
 *   node tools/preview-perf.mjs --video <path> [--audio <path>] [--seconds 5] [--label baseline] [--proxy] [--dpr 2] [--hide-canvas]
 *
 * `--video` is relative to the **workspace** (the folder above this project), because the only
 * large pictures on this machine are the gitignored reference captures — and a harness that needs a
 * committed 80 MB fixture is a harness that will not be run.
 *
 * Caveat, stated rather than buried: this drives **headless** Chrome, whose video pipeline and CPU
 * scheduling are not the ones a person watching the editor has. The absolute numbers are therefore
 * not the user's numbers. The *comparison* is the result — both arms run in the same browser with the
 * same file, so the difference between them is the app's own cost.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');

const args = { port: 8199, cdpport: 9399, seconds: 5, audio: null, label: '' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--video') args.video = process.argv[++i];
  else if (a === '--audio') args.audio = process.argv[++i];
  else if (a === '--seconds') args.seconds = Number(process.argv[++i]);
  else if (a === '--port') args.port = Number(process.argv[++i]);
  else if (a === '--cdpport') args.cdpport = Number(process.argv[++i]);
  else if (a === '--label') args.label = process.argv[++i];
  else if (a === '--proxy') args.proxy = true;
  else if (a === '--dpr') args.dpr = Number(process.argv[++i]);
  else if (a === '--hide-canvas') args.hideCanvas = true;
}
if (!args.video) {
  console.error('usage: node tools/preview-perf.mjs --video <path relative to the workspace> [--audio <path>]');
  process.exit(2);
}
/**
 * A path given on the command line, found the way a person would write it.
 *
 * Looked for relative to the workspace first, then inside `referece_material/` — which is where the
 * captures actually live and is gitignored, so it is the difference between a path of six words and
 * a path of forty. Returns the URL the page should fetch as well, resolved against the workspace
 * root, which is what the dev server is serving.
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

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result?.value;
}

/**
 * Start counting in the page.
 *
 * Two counters, because they answer different questions: `rAF` is what the *app* managed to draw, and
 * `videoFrames` is what the *decoder* managed to present. The gap counter records only frames that
 * took longer than two display refreshes, which is what a dropped frame feels like.
 */
const START_COUNTERS = `(() => {
  window.__perf = { raf: 0, videoFrames: 0, gaps: [], widestGap: 0, started: performance.now() };
  const v = document.querySelector('video');
  let prev = performance.now();
  const tick = (now) => {
    window.__perf.raf += 1;
    const gap = now - prev;
    prev = now;
    if (gap > window.__perf.widestGap) window.__perf.widestGap = gap;
    if (gap > 34) window.__perf.gaps.push(gap);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (v && v.requestVideoFrameCallback) {
    const onFrame = () => {
      window.__perf.videoFrames += 1;
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }
  return true;
})()`;

const READ_COUNTERS = `(() => {
  const p = window.__perf;
  const v = document.querySelector('video');
  const elapsed = (performance.now() - p.started) / 1000;
  return {
    seconds: elapsed,
    raf: p.raf,
    videoFrames: p.videoFrames,
    gaps: p.gaps.length,
    widestGap: p.widestGap,
    video: v
      ? { width: v.videoWidth, height: v.videoHeight, ready: v.readyState, duration: v.duration, error: v.error ? v.error.code : 0 }
      : null,
    // What the app has to paint every frame. It is *not* the document's resolution - the canvas is
    // fitted to the stage - but it *is* the stage at device resolution, which on a high-DPI display
    // is a lot of pixels to clear and rasterise sixty times a second. Printed because "the preview
    // stutters" is answered by knowing whether the decoder or this number is the limit.
    canvas: (() => {
      const c = document.querySelector('#preview-canvas');
      return c ? { width: c.width, height: c.height, css: c.clientWidth + 'x' + c.clientHeight, dpr: window.devicePixelRatio } : null;
    })(),
  };
})()`;

function report(name, counters) {
  const raf = counters.raf / counters.seconds;
  const presented = counters.videoFrames / counters.seconds;
  console.log(
    `  ${name.padEnd(9)} rAF ${raf.toFixed(1)}/s · video presented ${presented.toFixed(1)}/s · ` +
      `${counters.gaps} frame(s) over 34 ms · widest ${counters.widestGap.toFixed(0)} ms`,
  );
  if (counters.canvas) {
    console.log(
      `            the canvas drawn every frame: ${counters.canvas.width}x${counters.canvas.height} ` +
        `backing store for ${counters.canvas.css} at DPR ${counters.canvas.dpr}`,
    );
  }
  // A video that presented nothing is a *failed measurement*, not a fast one: say why, rather than
  // letting a zero be read as "the app is fine here".
  if (presented === 0 && counters.video) {
    console.log(
      `            (the element presented no frames at all — readyState ${counters.video.ready}, ` +
        `${counters.video.w}x${counters.video.h}, MediaError ${counters.video.error})`,
    );
  }
  return { ...counters, raf, presented };
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found — set CHROME_PATH');
  const videoUrl = video.url;
  const audioUrl = track?.url ?? null;

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
    ...(args.dpr ? [`--force-device-scale-factor=${args.dpr}`] : []),
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'preview-perf-'))}`,
    'about:blank',
  ]);
  const cdp = await connect(args.cdpport);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const origin = `http://127.0.0.1:${args.port}`;
  console.log(
    `preview performance${args.label ? ` · ${args.label}` : ''}\n` +
      `  file     ${args.video}${args.audio ? ` + ${args.audio}` : ''}\n` +
      `  measured for ${args.seconds}s per arm, headless Chrome (see the caveat in this file)\n`,
  );

  // ---- arm 1: the floor. A bare <video>, nothing else on the page. -------------
  await cdp.send('Page.navigate', {
    url: `${origin}/caption-studio/tools/preview-perf-control.html?src=${videoUrl}`,
  });
  await delay(2500);
  await evaluate(cdp, 'document.querySelector("video").play()');
  await evaluate(cdp, START_COUNTERS);
  await delay(args.seconds * 1000);
  const control = report('control', await evaluate(cdp, READ_COUNTERS));

  // ---- arm 2: the editor, same file, same length of time. ----------------------
  await cdp.send('Page.navigate', { url: `${origin}/caption-studio/index.html` });
  await delay(2500);
  await evaluate(cdp, 'document.querySelector("#demo-btn").click()');
  await delay(400);

  const loadMedia = async (selector, url, name, type) => {
    const loaded = await evaluate(
      cdp,
      `(async () => {
        const bytes = await (await fetch(${JSON.stringify(url)})).arrayBuffer();
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
        const input = document.querySelector(${JSON.stringify(selector)});
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        return bytes.byteLength;
      })()`,
      { awaitPromise: true },
    );
    return loaded;
  };
  const videoBytes = await loadMedia('#video-in', videoUrl, 'perf-picture.mp4', 'video/mp4');
  if (audioUrl) await loadMedia('#audio-in', audioUrl, 'perf-track.mp3', 'audio/mpeg');

  // The picture has to be *decoded* before the measurement means anything: a video element that
  // cannot read the file presents nothing, and \"0/s\" would then be read as \"the app is fine\".
  const ready = await evaluate(
    cdp,
    `(async () => {
      const v = document.querySelector('#preview-video');
      if (v.readyState < 2) await new Promise((ok) => { v.addEventListener('loadeddata', ok, { once: true }); setTimeout(ok, 20000); });
      return { ready: v.readyState, w: v.videoWidth, h: v.videoHeight, duration: v.duration, error: v.error ? v.error.code : 0 };
    })()`,
    { awaitPromise: true },
  );
  console.log(`  loaded   ${(videoBytes / 1e6).toFixed(1)} MB → ${ready.w}x${ready.h}, readyState ${ready.ready}${ready.error ? `, MediaError ${ready.error}` : ''}`);

  // ---- what the picture's own copy is doing before anything is measured --------------------
  //
  // The copy is built automatically when a picture big enough to need one is loaded. Two things follow,
  // and both are handled here rather than left to skew the arm that comes next: the pass is stopped (it
  // is a heavy job sharing the CPU with the decoder), and the preview is put back on the original, so
  // "editor" keeps meaning "the editor playing the file the user loaded". Both go through the panel's
  // own buttons, which is also the only test the stop button gets.
  const autoCopy = await evaluate(
    cdp,
    `(async () => {
      const clear = document.querySelector('#proxy-clear');
      const note = document.querySelector('#proxy-note');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const started = performance.now();
      // Up to 20s for the automatic pass to announce itself: reading a 80 MB file off a dev server is
      // not instant, and the button is the thing that says whether it started.
      while (performance.now() - started < 20000) {
        if (clear.textContent === 'Stop copying') break;
        // Nothing is being built: either this picture is not offered a copy at all, or the automatic
        // one finished before this got a look in. Both are answered by the same button below.
        if (/Export always encodes the original file/.test(note.textContent)) break;
        if (/Export still encodes the original/.test(note.textContent)) break;
        await wait(200);
      }
      const wasCopying = clear.textContent === 'Stop copying';
      let clicked = false;
      if (!clear.disabled) {
        clear.click();
        clicked = true;
      }
      const until = performance.now() + 30000;
      while (performance.now() < until && clear.textContent === 'Stop copying') await wait(200);
      return { wasCopying, clicked, note: note.textContent };
    })()`,
    { awaitPromise: true },
  );
  console.log(
    `  autocopy ${autoCopy.wasCopying ? 'built itself on load and was stopped through the button' : 'not offered for this picture'}${autoCopy.clicked ? '' : ' (no button to press)'}`,
  );

  // The canvas out of the way, if asked: the app goes on drawing into it, but the browser stops
  // compositing it, which is the half of the app's per-frame cost a HiDPI display multiplies.
  if (args.hideCanvas) {
    const removed = await evaluate(
      cdp,
      '(()=>{const c=document.querySelector("#preview-canvas");c?.remove();return Boolean(c)})()',
    );
    console.log(`  canvas   ${removed ? 'removed from the document for the editor arm' : 'not found'}`);
  }

  // Playing for real: the transport, not a paused element, is what the measurement is about.
  await evaluate(cdp, 'document.querySelector("#play-btn").click()');
  await delay(700);
  await evaluate(cdp, START_COUNTERS);
  await delay(args.seconds * 1000);
  const editor = report('editor', await evaluate(cdp, READ_COUNTERS));

  // ---- arm 3: the same editor, playing a copy of the same file ----------------
  let copy = null;
  if (args.proxy) {
    // The copy is built the way a person builds one - through the button, in this page - because a
    // harness that reached past the UI would measure the module and not the feature. This is the
    // *rebuild* path now: the automatic pass that runs on load was stopped above, and the button is
    // what builds one after that. The picture is stopped first: the conversion is not supposed to
    // need the transport, and this way it cannot be said to have ridden on it.
    await evaluate(cdp, 'document.querySelector("#play-btn").click()');
    await delay(400);
    const built = await evaluate(
      cdp,
      `(async () => {
        const build = document.querySelector('#proxy-build');
        const note = document.querySelector('#proxy-note');
        if (build.disabled) return { error: 'this picture is not offered a copy' };
        const started = performance.now();
        build.click();
        while (performance.now() - started < 900000) {
          await new Promise((r) => setTimeout(r, 400));
          const text = note.textContent;
          if (/could not be made|was stopped/.test(text)) return { error: text };
          if (/Export still encodes the original/.test(text)) {
            return { seconds: (performance.now() - started) / 1000, note: text };
          }
        }
        return { error: 'the copy never finished' };
      })()`,
      { awaitPromise: true },
    );
    if (built?.error) {
      console.log(`  copy      could not be built: ${built.error}`);
    } else {
      console.log(`  copy      built in ${built.seconds.toFixed(1)}s — ${built.note}`);
      await evaluate(cdp, 'document.querySelector("#play-btn").click()');
      await delay(700);
      await evaluate(cdp, START_COUNTERS);
      await delay(args.seconds * 1000);
      copy = report('copy', await evaluate(cdp, READ_COUNTERS));
    }
  }

  // ---- the comparison ---------------------------------------------------------
  const overhead = control.raf > 0 ? (1 - editor.raf / control.raf) * 100 : 0;
  const decodeBound = editor.presented < editor.raf * 0.9;
  console.log(
    `\n  verdict  the app drew ${editor.raf.toFixed(1)}/s against the bare element's ${control.raf.toFixed(1)}/s` +
      `${overhead > 0 ? ` (${overhead.toFixed(0)}% slower)` : ' (no measurable cost)'}`,
  );
  console.log(
    `           the decoder presented ${editor.presented.toFixed(1)} of those ${editor.raf.toFixed(1)} frames — ` +
      (decodeBound
        ? 'the limit is the decode, not the app'
        : 'the decoder kept up, so anything felt here is app-side'),
  );
  if (copy) {
    const gained = editor.presented > 0 ? copy.presented / editor.presented : 0;
    console.log(
      `\n  the copy: the decoder presented ${copy.presented.toFixed(1)}/s of it against ${editor.presented.toFixed(1)}/s ` +
        `of the original (${gained.toFixed(1)}x) — ` +
        (gained >= 1.5
          ? 'the copy is being presented at the display\u2019s own rate, where the original was starved by its decode'
          : 'no real gain here; this file did not need a copy'),
    );
  }

  cdp.close();
  stopAll();
}

main().catch((err) => {
  console.error(`preview-perf failed: ${err.message}`);
  stopAll();
  process.exit(1);
});
