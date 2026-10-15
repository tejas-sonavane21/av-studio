/**
 * proxy-speed.mjs — what the preview copy's build actually spends its time on.
 *
 * "Making the copy takes too long" is a claim about two jobs that have nothing to do with each other,
 * and the fix for one does nothing for the other:
 *
 *   1. **the decode** — every frame of the *original* is decoded, and nothing about the copy's size,
 *      codec or bitrate changes that. It is the price of admission for a 4K master;
 *   2. **the scale and the encode** — the frames are resampled down and compressed, and this is the
 *      half the copy's own settings *can* change.
 *
 * So this harness measures both, in the same browser, on a real file, off the same clock: a
 * decode-and-scale arm (frames read through a `CanvasSink`, no encoder at all) and one arm per set of
 * conversion settings. The decode arm is the floor — an arm barely above it is waiting on the file
 * rather than on its own settings, and no copy setting can shorten that wait.
 *
 *   node tools/proxy-speed.mjs --video <path> [--seconds 15] [--long-edge 1280] [--arms decode,module]
 *
 * `--slice <seconds>` remuxes the first N seconds of the file (copy mode: no decoder involved) and runs
 * the arms on that instead, which is how a 161 s capture is asked a question in a minute rather than in
 * a quarter of an hour. The per-frame costs are the file's; only the count of frames changes.
 * `--synthetic 1280x720:10` makes the fixture here instead of loading one, which is how the encoder is
 * asked a question with no 4K decode in front of it.
 *
 * `--video` is relative to the workspace or to `referece_material/` inside it, as in
 * `tools/preview-perf.mjs`, so the gitignored captures can be named in a few words.
 *
 * ## The arms
 *
 * | arm | what it is |
 * |---|---|
 * | `decode` | frames decoded and scaled, no encoder — the floor |
 * | `module` | the real `buildPreviewProxy()`: the feature, end to end |
 * | `modulecopy` | the module's own call sequence, written out here line by line |
 * | `baseline` | the same conversion with the module's own option builder, and nothing else |
 * | `notrim` / `fps30` | `baseline` with the window taken away / with the frame-rate cap set |
 * | `vp8` `vp9` `av1` `hw` | `baseline` asking for one codec, or for the hardware encoder |
 *
 * ## What it found on this machine (2026-10, headless Chrome, the 2160p AV1 fixture)
 *
 * **Where the seconds go: decoding and resampling the master.** The arm to compare against is `decode`
 * (frames read through a canvas and scaled, no encoder at all), and every arm below is printed with its
 * own figure **per ten seconds of picture** so the comparison can be made across windows. On a 4 s window
 * the floor came out at **21.3-21.7 s per ten seconds** of picture against **23.8-24.0 s** for the
 * module's own conversion; the three clean re-runs of the same two arms at the bottom of this header put
 * the floor at 19.6-20.9 s against 24.4-25.6 s. Across those four runs the floor is **80-89%** of the
 * module's arm, so between four fifths and nine tenths of the pass is the master's own decode and the
 * resample into the copy, and no setting of the copy touches it. That is why the copy's settings came out
 * flat:
 *
 * * **The rung does not move it.** A 4 s window: 10.7 s at the 720p rung against 10.8 s at 480p; from a
 *   720p master with the 4K decode taken out (`--synthetic 1280x720:10`), 4.5 s against 4.8 s — the
 *   resample path does more work at the smaller rung, and either way it is the resample, not the
 *   encoder, that the seconds go to.
 * * **The codec does not move it either.** VP8 and VP9 land within 2% of each other on the same window.
 * * **The hardware encoder is not reachable here.** `prefer-hardware` **fails outright** for VP9 — the
 *   only hardware encoder Chrome will admit to on this machine is H.264, and WebM cannot carry it — so
 *   nothing asks for it on the strength of a guess.
 *
 * ## Read the numbers with the machine in mind
 *
 * Wall-clock on this box is not a stable unit. The same 4 s window was measured at **4.0 s** early in a
 * session and at **12-15 s** an hour into one, and the two full-file builds behind the README's numbers
 * came out 431.1 s and 459.8 s for identical work. Two causes were caught in the act, and both are worth
 * knowing before believing a single arm:
 *
 * * **Interrupted probe runs leave browsers converting in the background.** A run that is killed from
 *   outside (a terminal timeout, a closed window) can leave its Chrome and its dev server alive, still
 *   decoding 4K, and the next run then measures the contention rather than the code. The check is
 *   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'proxy-speed' }`; an early
 *   measurement here showed one path at 2.4x another, and a clean re-run of the same two arms showed
 *   **12.3 s against 12.1 s** — that is, no gap at all, and a lesson about the harness rather than about
 *   the code. Three later clean re-runs of `--arms decode,modulecopy` on the same 4 s window, with the
 *   strays cleared, read **7.87 against 9.8**, **8.41 against 10.04** and **8.38 against 10.29** seconds —
 *   19.6-20.9 s per ten seconds of picture for the floor against 24.4-25.6 s for the module, and the
 *   floor's admitted share 80-89% of the arm. The direction and roughly the size of the effect survive;
 *   the exact seconds do not.
 * * **Heat and other work.** Run arms twice, alternate their order, and believe a difference only when it
 *   is bigger than the spread across repeats.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, '..');

const args = {
  port: 8201,
  cdpport: 9401,
  seconds: 15,
  longEdge: 1280,
  arms: ['decode', 'module', 'baseline'],
  label: '',
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--video') args.video = process.argv[++i];
  else if (a === '--seconds') { args.seconds = Number(process.argv[++i]); args.secondsGiven = true; }
  else if (a === '--long-edge') args.longEdge = Number(process.argv[++i]);
  else if (a === '--arms') args.arms = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--slice') args.slice = Number(process.argv[++i]);
  else if (a === '--synthetic') args.synthetic = process.argv[++i];
  else if (a === '--label') args.label = process.argv[++i];
  else if (a === '--port') args.port = Number(process.argv[++i]);
  else if (a === '--cdpport') args.cdpport = Number(process.argv[++i]);
  else if (a === '--configs') args.configs = true;
  else if (a === '--cadence') args.cadence = true;
  else if (a === '--headful') args.headful = true;
}
if (!args.video && !args.synthetic) {
  console.error(
    'usage: node tools/proxy-speed.mjs --video <path relative to the workspace> [--seconds 15] [--arms decode,module,baseline]\n' +
      '   or: node tools/proxy-speed.mjs --synthetic 1280x720:10 [--long-edge 1280]',
  );
  process.exit(2);
}

/** A path given on the command line, found the way a person would write it. */
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

/** A fixture made here, at a known size and length: ten seconds of 720p is `1280x720:10`. */
function synthetic() {
  const [shape, seconds] = String(args.synthetic).split(':');
  const [width, height] = shape.split('x').map(Number);
  if (!(width > 0 && height > 0)) {
    console.error(`--synthetic wants WxH:seconds, got ${JSON.stringify(args.synthetic)}`);
    process.exit(2);
  }
  return { width, height, seconds: Number(seconds) || 10, fps: 30 };
}

const video = args.video ? locate(args.video) : null;
const built = args.synthetic ? synthetic() : null;
// A slice is the window the arms run over unless one was named on the command line.
if (args.slice && !args.secondsGiven) args.seconds = args.slice;

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

async function evaluate(cdp, expression, { awaitPromise = false, timeout = 30 } = {}) {
  const call = cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  const result = await Promise.race([call, delay(timeout * 1000).then(() => ({ timedOut: true }))]);
  if (result.timedOut) throw new Error(`evaluate timed out after ${timeout}s`);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result?.value;
}

/**
 * The page-side run: one fixture, one window of it, one arm at a time.
 *
 * Every conversion arm is built from the module's own option builder — `proxyVideoOptions()` — so an arm
 * is this project's real settings for the picture with a single field changed, rather than a hand-rolled
 * encoder config that could drift from what the feature actually does.
 */
const RUN = (videoUrl, fixture, slice, seconds, longEdge, arms) => `(async () => {
  const { Input, BlobSource, BufferSource, BufferTarget, Output, WebMOutputFormat, Mp4OutputFormat, Conversion,
          CanvasSink, ALL_FORMATS, canEncodeVideo, getEncodableVideoCodecs } = await import('/caption-studio/vendor/mediabunny/mediabunny.min.mjs');
  const { proxyVideoOptions, buildPreviewProxy, proxySize } = await import('/caption-studio/src/io/preview-proxy.js');
  const { evenSize } = await import('/caption-studio/src/io/webcodecs-export.js');

  // Progress is reported through the document title, because a window of a 4K file is minutes of work
  // and a harness that prints nothing until it is done cannot tell "slow" from "stuck". A step is
  // *recorded* always and put in the title only when asked: a title assignment crosses process
  // boundaries, and a conversion that reports every frame would spend more time telling this harness
  // how it is doing than doing it.
  const began = performance.now();
  const trace = [];
  const mark = (name, title = true) => {
    trace.push(name + '@' + Math.round(performance.now() - began) + 'ms');
    if (title) document.title = name;
  };

  // Every decoder and encoder the page configures, recorded per arm. If two arms ask for the same
  // picture and one takes twice as long, this is where the difference has to show up.
  let workingOn = 'setup';
  const configurations = [];
  const decodeCalls = [];
  const realDecodeCall = VideoDecoder.prototype.decode;
  VideoDecoder.prototype.decode = function (frame) {
    decodeCalls.push({ arm: workingOn, t: performance.now() - began });
    return realDecodeCall.call(this, frame);
  };
  const realDecode = VideoDecoder.prototype.configure;
  VideoDecoder.prototype.configure = function (config) {
    configurations.push({
      arm: workingOn, kind: 'decoder', codec: config.codec,
      codedWidth: config.codedWidth, codedHeight: config.codedHeight,
      hardwareAcceleration: config.hardwareAcceleration ?? null,
      optimizeForLatency: config.optimizeForLatency ?? null,
    });
    return realDecode.call(this, config);
  };
  const realEncode = VideoEncoder.prototype.configure;
  VideoEncoder.prototype.configure = function (config) {
    configurations.push({
      arm: workingOn, kind: 'encoder', codec: config.codec,
      width: config.width, height: config.height, bitrate: config.bitrate,
      framerate: config.framerate ?? null, latencyMode: config.latencyMode ?? null,
      hardwareAcceleration: config.hardwareAcceleration ?? null,
    });
    return realEncode.call(this, config);
  };

  const report = { bytes: 0, arms: [], encodable: [], errors: [], trace, configurations, decodeCalls };
  let blob;
  if (${JSON.stringify(fixture)}) {
    mark('fixture');
    const spec = ${JSON.stringify(fixture)};
    const { Muxer, ArrayBufferTarget } = await import('/caption-studio/vendor/muxers/webm-muxer.mjs');
    const canvas = document.createElement('canvas');
    canvas.width = spec.width; canvas.height = spec.height;
    const g = canvas.getContext('2d');
    const chunks = [];
    const enc = new VideoEncoder({ output: (c, m) => chunks.push({ c, m }), error: () => {} });
    enc.configure({
      codec: 'vp09.00.10.08', width: spec.width, height: spec.height,
      bitrate: Math.round(spec.width * spec.height * spec.fps * 0.12), framerate: spec.fps,
    });
    const total = spec.fps * spec.seconds;
    for (let i = 0; i < total; i++) {
      g.fillStyle = 'hsl(' + ((i * 3) % 360) + ' 60% 35%)';
      g.fillRect(0, 0, spec.width, spec.height);
      g.fillStyle = '#fff';
      g.fillRect((i * Math.round(spec.width / spec.fps)) % spec.width, Math.round(spec.height / 3), Math.round(spec.width / 12), Math.round(spec.height / 12));
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i / spec.fps) * 1e6), duration: Math.round(1e6 / spec.fps) });
      enc.encode(frame, { keyFrame: i % spec.fps === 0 });
      frame.close();
    }
    await enc.flush();
    enc.close();
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: 'V_VP9', width: spec.width, height: spec.height, frameRate: spec.fps } });
    for (const entry of chunks) muxer.addVideoChunk(entry.c, entry.m);
    muxer.finalize();
    blob = new Blob([target.buffer], { type: 'video/webm' });
    report.built = true;
    mark('fixture-ready');
  } else {
    mark('fetch');
    blob = await (await fetch(${JSON.stringify(videoUrl)})).blob();
    mark('fetched');
    if (${JSON.stringify(slice)}) {
      // A slice of the real file, *remuxed* rather than re-encoded (copy mode, no decoder involved), so
      // the arms run on the genuine 4K picture at a length that fits in a coffee break.
      mark('slice');
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input, output, tracks: 'primary', copy: { mode: 'forced' },
        trim: { start: 0, end: ${JSON.stringify(slice)} }, showWarnings: false,
      });
      if (!conversion.isValid) throw new Error('the slice came out invalid: ' + conversion.discardedTracks.map((d) => d.reason).join(','));
      await conversion.execute();
      blob = new Blob([output.target.buffer], { type: 'video/mp4' });
      input.dispose?.();
      mark('sliced');
    }
  }
  report.bytes = blob.size;

  const size = evenSize(${longEdge}, ${Math.round((longEdge * 9) / 16)});
  const quality = proxyVideoOptions({ width: size.width, height: size.height }).quality;
  // The codec list first, the config second. Every codec in it is probed with a *real* VideoEncoder,
  // which is the only answer worth having — "Chrome supports VP9" is not the same claim as "this
  // machine will encode VP9 at this size".
  report.encodable = await getEncodableVideoCodecs(undefined, { width: size.width, height: size.height, quality }).catch((err) => ['probe failed: ' + err.message]);
  report.hardware = await getEncodableVideoCodecs(['avc', 'vp9', 'av1', 'vp8'], { width: size.width, height: size.height, quality, hardwareAcceleration: 'prefer-hardware' }).catch(() => []);

  // Is this machine decoding the picture in hardware? A hardware AV1 decoder is several times the
  // software one, and it is not something an option here can ask for — but it *is* the difference
  // between two runs on the same file, so it has to be on the record.
  if (globalThis.VideoDecoder) {
    const base = { codec: 'av01.0.05M.08', codedWidth: 3840, codedHeight: 2160 };
    report.decoders = [];
    for (const hw of ['no-preference', 'prefer-hardware', 'prefer-software']) {
      const answer = await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw }).catch((err) => ({ supported: false, why: String(err.message || err) }));
      report.decoders.push({ hardwareAcceleration: hw, supported: Boolean(answer.supported) });
    }
    const capabilities = await navigator.mediaCapabilities?.decodingInfo({
      type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 3840, height: 2160, bitrate: 3000000, framerate: 30 },
    }).catch(() => null);
    report.powerEfficient = capabilities
      ? [capabilities.supported, capabilities.smooth, capabilities.powerEfficient].join('/')
      : 'unknown';
  }

  mark('probe');
  const probe = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  const sourceSeconds = await probe.computeDuration();
  const display = { width: await track.getDisplayWidth(), height: await track.getDisplayHeight() };
  const sourceCodec = (await track.getCodec()) ?? '';
  const rateMetrics = await track.computeFrameRateMetrics().catch(() => null);
  report.source = {
    seconds: Number(sourceSeconds.toFixed(3)),
    ...display,
    codec: sourceCodec,
    bestGuessFrameRate: Number(rateMetrics?.bestGuessFrameRate ?? 0),
    averageFrameRate: Number(rateMetrics?.averageFrameRate ?? 0),
  };

  const start = 0;
  const end = Math.min(${seconds}, sourceSeconds);

  // ---- read the frames the way the module reads them, and time what that costs ---------------
  // The harness's own two fields come *last*: an arm that reports the copy's duration as its seconds
  // would otherwise overwrite the time it took to produce it, and a bench that prints the clip's length
  // where the wall clock belongs is worse than no bench at all.
  const measuring = async (name, run) => {
    workingOn = name;
    mark(name + ':open');
    const started = performance.now();
    const result = await run();
    const spent = (performance.now() - started) / 1000;
    mark(name + ':done');
    return { ...result, arm: name, seconds: Number(spent.toFixed(2)) };
  };

  /** Frames decoded and scaled, with no encoder anywhere: the floor every other arm sits on. */
  const decodeArm = () =>
    measuring('decode', async () => {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const t = await input.getPrimaryVideoTrack();
      const sink = new CanvasSink(t, { width: size.width, height: size.height, fit: 'contain', poolSize: 2 });
      const began = performance.now();
      let frames = 0;
      for await (const wrapped of sink.canvases(start, end)) {
        frames += 1;
        if (frames === 1) report.decodeFirstFrameMs = Number((performance.now() - began).toFixed(1));
      }
      input.dispose?.();
      return { decode: true, frames, framesPerSecond: Number((frames / (performance.now() - began) * 1000).toFixed(1)) };
    });

  /** What a copy holds, read back out of the copy rather than assumed from the settings. */
  const readCopy = async (buffer) => {
    const copy = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
    const copyTrack = await copy.getPrimaryVideoTrack();
    const packets = copyTrack ? await copyTrack.computePacketStats() : null;
    const read = {
      frames: Math.round(Number(packets?.packetCount) || 0),
      codec: (copyTrack ? await copyTrack.getCodec() : '') ?? '',
      width: copyTrack ? await copyTrack.getDisplayWidth() : 0,
      height: copyTrack ? await copyTrack.getDisplayHeight() : 0,
      videoBitrate: Math.round(Number(packets?.averageBitrate) || 0),
      seconds: Number((await copy.computeDuration().catch(() => 0)).toFixed(3)),
    };
    copy.dispose?.();
    return read;
  };

  // ---- one conversion arm, with a single field of the real options changed -------------------
  const conversionArm = (def) =>
    measuring(def.label, async () => {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const t = await input.getPrimaryVideoTrack();
      const video = proxyVideoOptions({ width: size.width, height: size.height, fps: 30 });
      for (const [key, value] of Object.entries(def.video ?? {})) video[key] = value;
      if (def.video?.codec) {
        // A codec this browser cannot encode is *reported*, not silently converted into a slower one.
        const ok = await canEncodeVideo(def.video.codec, { width: size.width, height: size.height, quality: video.quality }).catch(() => false);
        if (!ok) return { skipped: true, reason: 'this browser cannot encode ' + def.video.codec };
      }
      const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input, output, tracks: 'primary', video, audio: {},
        ...(def.trim === false ? {} : { trim: { start, end } }),
        showWarnings: false,
      });
      if (!conversion.isValid) {
        return { skipped: true, reason: 'invalid: ' + conversion.discardedTracks.map((d) => d.reason).join(',') };
      }
      if (def.progress) conversion.onProgress = () => {};
      await conversion.execute();
      const buffer = output.target.buffer;
      input.dispose?.();
      return { bytes: buffer?.byteLength ?? 0, ...(await readCopy(buffer)) };
    });

  // ---- the module itself: the real feature, on this picture ---------------------------------
  const moduleArm = () =>
    measuring('module', async () => {
      const url = URL.createObjectURL(blob);
      try {
        const result = await buildPreviewProxy({
          url,
          size,
          onProgress: (fraction) => {
            const percent = Math.round(fraction * 100);
            mark('module:' + percent + '%', percent % 5 === 0 && percent !== modulePercent);
            if (percent % 5 === 0) modulePercent = percent;
          },
        });
        return {
          encodeSeconds: result.encodeSeconds, bytes: result.blob.size,
          width: result.width, height: result.height, frames: result.frames, codec: result.codec,
          videoBitrate: result.videoBitrate, audio: result.audio, audioCodec: result.audioCodec,
          seconds: Number(result.seconds.toFixed(3)),
        };
      } finally {
        URL.revokeObjectURL(url);
      }
    });

  // ---- the module's own sequence, written out: this is the arm the gap reproduces in ----------
  const moduleCopyArm = () =>
    measuring('modulecopy', async () => {
      const url = URL.createObjectURL(blob);
      try {
        const input = new Input({ source: new BlobSource(await (await fetch(url)).blob()), formats: ALL_FORMATS });
        await input.canRead();
        const t = await input.getPrimaryVideoTrack();
        await input.computeDuration();
        const target = proxySize(await t.getDisplayWidth(), await t.getDisplayHeight());
        const { width, height } = evenSize(target.width, target.height);
        const metrics = await t.computeFrameRateMetrics().catch(() => null);
        const sourceRate = Number(metrics?.bestGuessFrameRate ?? metrics?.averageFrameRate ?? 0);
        const video = proxyVideoOptions({ width, height, fps: 30 });
        if (sourceRate > 30.5) video.frameRate = 30;
        const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
        const conversion = await Conversion.init({ input, output, tracks: 'primary', video, audio: {}, showWarnings: false });
        if (!conversion.isValid) throw new Error('the module\\u2019s call came out invalid');
        conversion.onProgress = () => {};
        await conversion.execute();
        const buffer = output.target.buffer;
        input.dispose?.();
        return { bytes: buffer?.byteLength ?? 0, ...(await readCopy(buffer)) };
      } finally {
        URL.revokeObjectURL(url);
      }
    });

  const defs = {
    baseline: { label: 'baseline', video: {} },
    notrim: { label: 'notrim', video: {}, trim: false },
    fps30: { label: 'fps30', video: { frameRate: 30 } },
    progress: { label: 'progress', video: {}, progress: true },
    vp8: { label: 'vp8', video: { codec: 'vp8' } },
    vp9: { label: 'vp9', video: { codec: 'vp9' } },
    av1: { label: 'av1', video: { codec: 'av1' } },
    hw: { label: 'hw', video: { hardwareAcceleration: 'prefer-hardware' } },
  };

  let modulePercent = -1;
  for (const name of ${JSON.stringify(arms)}) {
    try {
      if (name === 'decode') report.arms.push(await decodeArm());
      else if (name === 'module') report.arms.push(await moduleArm());
      else if (name === 'modulecopy') report.arms.push(await moduleCopyArm());
      else if (defs[name]) report.arms.push(await conversionArm(defs[name]));
      else report.errors.push('no such arm: ' + name);
    } catch (err) {
      report.arms.push({ arm: name, error: String((err && err.message) || err) });
    }
  }
  mark('done');
  probe.dispose?.();
  return report;
})()`;

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found — set CHROME_PATH');

  launch('node', ['tools/serve.mjs', String(args.port), '..'], { cwd: PROJECT_ROOT });
  await delay(700);

  launch(chrome, [
    ...(args.headful ? [] : ['--headless=new']),
    `--remote-debugging-port=${args.cdpport}`,
    '--remote-allow-origins=*',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'proxy-speed-'))}`,
    'about:blank',
  ]);
  const cdp = await connect(args.cdpport);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const origin = `http://127.0.0.1:${args.port}`;
  await cdp.send('Page.navigate', { url: `${origin}/caption-studio/index.html` });
  await delay(2500);

  const label = args.label ? ` · ${args.label}` : '';
  console.log(
    `preview copy speed${label}\n` +
      `  file      ${args.video ?? `a fixture made here: ${args.synthetic}`}\n` +
      `  window    up to ${args.seconds}s of it, copy at ${args.longEdge} long edge\n` +
      `  browser   ${args.headful ? 'headful' : 'headless'} Chrome\n`,
  );

  const running = evaluate(cdp, RUN(video?.url ?? '', built, args.slice ?? null, args.seconds, args.longEdge, args.arms), {
    awaitPromise: true,
    timeout: 1800,
  });
  // While the page works the page's own title says which step it is on, so a run that takes minutes is
  // visibly *working* rather than silently stuck.
  let settled = false;
  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let step = '';
  while (!settled) {
    await delay(3000);
    if (settled) break;
    try {
      const title = await evaluate(cdp, 'document.title');
      if (title && title !== step) {
        step = title;
        console.log(`  · ${title}`);
      }
    } catch {
      /* the renderer is mid-frame; the next tick will read it */
    }
  }
  const report = await running;

  if (report.errors.length) for (const e of report.errors) console.log(`  ! ${e}`);
  console.log(
    `  source    ${report.source.width}×${report.source.height} ${report.source.codec}, ` +
      `${report.source.seconds}s, frame rate ${report.source.bestGuessFrameRate || '?'}\n` +
      `  encoders  ${report.encodable.join(', ') || 'none this machine will use'}` +
      `${report.hardware?.length ? `\n            with the hardware preference: ${report.hardware.join(', ')}` : ''}` +
      `${report.decoders ? `\n  the 4K AV1 decoder here: ${report.decoders.map((d) => `${d.hardwareAcceleration} ${d.supported ? 'yes' : 'no'}`).join(', ')} (power efficient: ${report.powerEfficient})\n` : ''}`,
  );

  const decode = report.arms.find((arm) => arm.decode);
  // Every arm is also printed per ten seconds of picture, because that is the unit the header above and
  // the README quote and a 4 s window is not the same question as a 15 s one: a number nobody can
  // recompute from this output is a number nobody can check.
  const window = Number(report.source?.seconds) || 0;
  const perTen = (arm) =>
    window > 0 && arm.seconds ? ` ${((arm.seconds / window) * 10).toFixed(1)}s per 10s of picture,` : '';
  for (const arm of report.arms) {
    if (arm.decode) {
      console.log(
        `  ${'decode+scale'.padEnd(12)} ${String(arm.seconds).padStart(7)}s${perTen(arm)}  ` +
          `${arm.frames} frames (${arm.framesPerSecond}/s of picture), no encoder involved`,
      );
      continue;
    }
    if (arm.skipped) {
      console.log(`  ${String(arm.arm).padEnd(12)} skipped — ${arm.reason}`);
      continue;
    }
    if (arm.error) {
      console.log(`  ${String(arm.arm).padEnd(12)} failed — ${arm.error}`);
      continue;
    }
    // The floor's share of this arm, not just the difference: "1.9s over" is 20% of a 9.8 s arm and 4%
    // of a 45 s one, and the share is what decides whether the arm was measuring the file or itself.
    const over =
      decode && arm.seconds
        ? ` (${(arm.seconds - decode.seconds).toFixed(2)}s over the decode floor of ` +
          `${((decode.seconds / arm.seconds) * 100).toFixed(0)}% of this arm)`
        : '';
    const own = arm.encodeSeconds != null ? ` [its own conversion: ${arm.encodeSeconds}s]` : '';
    console.log(
      `  ${String(arm.arm).padEnd(12)} ${String(arm.seconds).padStart(7)}s${perTen(arm)}  ` +
        `${arm.width}×${arm.height} ${arm.codec}, ${arm.frames} frames, ` +
        `${(arm.bytes / 1e6).toFixed(2)} MB at ${(arm.videoBitrate / 1e6).toFixed(2)} Mbps${over}${own}`,
    );
  }
  console.log(
    '\n  read it as: the decode arm is the floor. An arm that is barely above it is waiting on the\n' +
      '  file, not on its own settings — and no copy setting can shorten that wait.',
  );

  if (args.cadence) {
    console.log('\n  the cadence of the frames handed to the decoder, per arm:');
    const byArm = new Map();
    for (const call of report.decodeCalls ?? []) {
      if (!byArm.has(call.arm)) byArm.set(call.arm, []);
      byArm.get(call.arm).push(call.t);
    }
    for (const [arm, times] of byArm) {
      const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
      const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
      console.log(
        `    ${String(arm).padEnd(12)} ${times.length} frames over ${(span / 1000).toFixed(2)}s, ` +
          `gap median ${median.toFixed(1)}ms, largest ${gaps[gaps.length - 1]?.toFixed(1) ?? '-'}ms`,
      );
    }
  }
  if (args.configs) {
    console.log('\n  what each arm asked the browser\u2019s codecs for:');
    for (const c of report.configurations ?? []) {
      const fields = Object.entries(c).filter(([k]) => k !== 'arm' && k !== 'kind' && c[k] != null);
      console.log(`    ${String(c.arm).padEnd(12)} ${c.kind.padEnd(7)} ${fields.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
  }

  cdp.close();
  stopAll();
  // The report is out; there is nothing left to wait for. Left to itself this process sat on its closed
  // CDP socket and outlived its own run — and a probe that is still alive is a probe the *next* run
  // measures against, which is exactly the contention the header warns about. The timer is unref'd, so a
  // process that drains on its own still exits at once; three seconds is what the last write and
  // `taskkill` need, and it is long after the report has gone to the terminal.
  setTimeout(() => process.exit(0), 3000).unref();
}

main().catch((err) => {
  console.error(`proxy-speed failed: ${err.message}`);
  stopAll();
  process.exit(1);
});
