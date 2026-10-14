/**
 * io/webcodecs-export.js — the real export.
 *
 * This replaces the old burn-in, which played the video and recorded the screen with `MediaRecorder`.
 * That approach had two faults that could not be fixed from the outside: it took as long as the video
 * did (three minutes of video, three minutes of waiting), and its frame rate was at the mercy of the
 * browser's own compositor — a dropped frame was a frame the export simply never had.
 *
 * The picture is instead **rendered**, not recorded:
 *
 * 1. **Frames are stepped, not played.** For each output frame the picture is seeked to the frame's
 *    own source time, the picture and the caption layer are composited onto an offscreen canvas at
 *    the export's resolution, and that canvas becomes a `VideoFrame`. Nothing depends on wall-clock
 *    time, so the frame rate is exact — every frame the document asks for.
 * 2. **The browser encodes.** `VideoEncoder` (H.264 for `.mp4`, VP9 for `.webm`) and `AudioEncoder`
 *    (AAC or Opus) turn those frames into compressed chunks. This is an *offline* encode with
 *    lookahead, unlike a real-time recorder, so the same bitrate looks noticeably cleaner.
 * 3. **A muxer writes the container.** WebCodecs produces chunks, not a file; the vendored
 *    `mp4-muxer` / `webm-muxer` (see `vendor/VENDOR.md`) assemble them into a playable file.
 *
 * Two things about *which* frames are rendered are worth stating up front, because both were bugs:
 *
 * * **The export decodes from its own element.** It used to seek the video element that is on screen,
 *   which meant the preview visibly ran through the whole clip while the transport was locked — the
 *   worst of both worlds. Given a `sourceUrl` the export now builds its own off-screen element, so the
 *   preview keeps playing (or scrubbing, or sitting still) and is never touched.
 * * **The sound is probed, not assumed.** AAC is not implemented at every bitrate in every Chromium
 *   build — this one accepts 96–192 kbps and refuses 224 kbps and up — and the old code took a refusal
 *   for *that bitrate* as a refusal to encode audio at all, which is why "best" (256 kbps) came out
 *   silent while "high" (192 kbps) did not. The bitrate is now chosen by asking the browser which
 *   neighbouring rate it will take, and the fallback is reported rather than swallowed.
 *
 * Cuts are honoured here too: the timeline stores *kept ranges of the source* (see `model/timeline.js`)
 * and the export walks them, so a trimmed clip is a shorter file rather than a longer one with the
 * removed part left in.
 *
 * Overlay clips (`doc.media`) are rendered the same way, on a layer of their own between the picture and
 * the captions: a video clip is **seeked** to its own frame for each output frame, exactly like the base
 * picture, so a moving logo is stepped rather than sampled — and never played, which is what would make
 * the export depend on the wall clock again.
 *
 * Everything that can be decided without a browser — the codec choices, the frame count, the bitrate
 * ladder, the range mapping — is a pure function, so it is unit-tested in Node (see
 * `tests/unit/webcodecs-export.test.js`).
 */

import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from '../../vendor/muxers/webm-muxer.mjs';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from '../../vendor/muxers/mp4-muxer.mjs';
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from '../../vendor/mediabunny/mediabunny.min.mjs';
import { createRenderer } from '../render/renderer.js';
import { drawMediaClips } from '../render/media-layer.js';
import { fitRect } from '../util/math.js';
import { audioBitrate, videoBitrate } from './download.js';
import { clipSourceTime } from '../model/media.js';
import { outputDuration, outputToSource, trackRanges } from '../model/timeline.js';

/** The containers this studio can write, and what each one is. */
export const EXPORT_FORMATS = Object.freeze({
  mp4: { ext: 'mp4', mime: 'video/mp4', label: 'MP4 — H.264, plays everywhere' },
  webm: { ext: 'webm', mime: 'video/webm', label: 'WebM — VP9, open format' },
});

/** The default container. MP4 is what every other editor and phone expects. */
export const DEFAULT_FORMAT = 'mp4';

/**
 * Video codec candidates, best first.
 *
 * H.264 High (level 4.0) first, then Main, then Baseline — the fallbacks matter on machines without a
 * hardware H.264 encoder, where only Baseline may be offered. VP9 for WebM, with VP8 as the floor.
 * The order is the recommendation; `pickVideoCodec` asks the browser which it will actually take.
 */
const VIDEO_CODECS = Object.freeze({
  mp4: ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'],
  webm: ['vp09.00.10.08', 'vp09.00.31.08', 'vp8'],
});

/**
 * Audio codec candidates. AAC is what an MP4 needs to play in a normal player; Opus is the WebM
 * standard. There is deliberately no "Opus inside an MP4" fallback: it muxes, but it plays in almost
 * nothing, and a file that will not open is worse than a silent one.
 */
const AUDIO_CODECS = Object.freeze({
  mp4: ['mp4a.40.2'],
  webm: ['opus'],
});

/**
 * The rates the audio bitrate search tries, most wanted first.
 *
 * The list exists because a browser may refuse a bitrate it was asked for while accepting its
 * neighbours — measured on this Chrome, AAC takes 96/128/160/192 kbps and refuses 224, 256, 320 and
 * everything at or below 64. A refused *rate* is not a refused *track*, and the ladder is what tells
 * the two apart.
 */
export const AUDIO_BITRATE_LADDER = Object.freeze([
  320000, 256000, 224000, 192000, 160000, 128000, 96000, 64000, 48000, 32000, 24000, 16000,
]);

/**
 * The first codec the browser will encode, or '' when it will take none of them.
 *
 * Pure: the capability probe is injected, so the choice can be tested without a browser. A probe that
 * throws is treated as a "no" for that candidate only — one refused type is not a reason to abandon
 * the remaining ones.
 */
export function pickCodec(candidates, isSupported) {
  const test = typeof isSupported === 'function' ? isSupported : () => false;
  for (const codec of candidates ?? []) {
    try {
      if (test(codec)) return codec;
    } catch {
      /* try the next candidate */
    }
  }
  return '';
}

/** The video codec for a container, or '' if this browser cannot encode any of them. Pure. */
export function pickVideoCodec(format, isSupported) {
  return pickCodec(VIDEO_CODECS[format === 'webm' ? 'webm' : 'mp4'], isSupported);
}

/** The audio codec for a container, or '' if this browser cannot encode one. Pure. */
export function pickAudioCodec(format, isSupported) {
  return pickCodec(AUDIO_CODECS[format === 'webm' ? 'webm' : 'mp4'], isSupported);
}

/**
 * The bitrate to ask for, given what the caller wanted and what the browser will accept. Pure-ish: the
 * probe is injected, so the search is unit-tested without an encoder.
 *
 * The *closest* acceptable rate at or below the request wins, so a lower preference is never quietly
 * upgraded into a bigger file; only when nothing below is accepted does it look upward, and then it
 * takes the smallest rate that works rather than the largest.
 *
 * @returns {Promise<number>} the chosen bitrate, or 0 when the browser will take none of them
 */
export async function resolveAudioBitrate(isSupported, preferred) {
  const want = Math.max(1, Math.round(Number(preferred) || 0));
  const ladder = [...new Set([want, ...AUDIO_BITRATE_LADDER])].sort((a, b) => b - a);
  const below = ladder.filter((rate) => rate <= want);
  const above = ladder.filter((rate) => rate > want).reverse();
  for (const rate of [...below, ...above]) {
    try {
      if (await isSupported(rate)) return rate;
    } catch {
      /* a probe that throws is a no for this rate only */
    }
  }
  return 0;
}

/** How many frames `seconds` needs at `fps`. Pure, and never zero (a one-frame export beats none). */
export function frameCount(seconds, fps) {
  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || 30)));
  const length = Math.max(0, Number(seconds) || 0);
  return Math.max(1, Math.round(length * rate));
}

/** The container muxer names a codec by a different spelling than WebCodecs does. */
export function muxerVideoCodec(format, codec) {
  if (format === 'webm') return codec?.startsWith('vp09') ? 'V_VP9' : 'V_VP8';
  return 'avc';
}

/** The container muxer's audio codec id for the WebCodecs codec we picked. */
export function muxerAudioCodec(format, codec) {
  if (format === 'webm') return 'A_OPUS';
  return codec === 'opus' ? 'opus' : 'aac';
}

/**
 * Even pixel dimensions. A codec configuration with an odd width is refused outright by some
 * encoders, and rounding here means the caller can hand over any size it likes.
 */
export function evenSize(width, height) {
  const even = (n) => {
    const value = Math.max(2, Math.round(Number(n) || 0));
    return value % 2 === 0 ? value : value + 1;
  };
  return { width: even(width), height: even(height) };
}

/**
 * The output resolution a requested height implies at a given frame shape. Pure.
 *
 * A preset names the *short* edge — "1080p" is 1920×1080 landscape and 1080×1920 portrait — so the
 * long edge is derived from the ratio, with an explicit target so 1080p is never turned into 1081.
 */
export function resolutionFor(shortEdge, aspect, { maxWidth = 7680, maxHeight = 4320 } = {}) {
  const short = Math.max(2, Math.round(Number(shortEdge) || 0));
  const ratio = Number(aspect) > 0 ? Number(aspect) : 16 / 9;
  const long = Math.round(ratio >= 1 ? short * ratio : short / ratio);
  const size = ratio >= 1 ? { width: long, height: short } : { width: short, height: long };
  return evenSize(Math.min(size.width, maxWidth), Math.min(size.height, maxHeight));
}

// ---------------------------------------------------------------------------
// browser plumbing
// ---------------------------------------------------------------------------

/** Resolve on `event` (or after `timeout` ms), whichever comes first; `true` if it fired. */
function once(element, event, timeout = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (fired) => {
      if (settled) return;
      settled = true;
      element.removeEventListener(event, onEvent);
      clearTimeout(timer);
      resolve(fired);
    };
    const onEvent = () => finish(true);
    element.addEventListener(event, onEvent, { once: true });
    const timer = setTimeout(() => finish(false), timeout);
  });
}

/** Wait until an element can be seeked. `true` when it is ready. */
async function readyMedia(element, timeout = 20000) {
  if (element.readyState >= 1) return true;
  return once(element, 'loadedmetadata', timeout);
}

/**
 * An element to decode the export from that is **not** the one on screen.
 *
 * Off-screen rather than hidden: `display:none` and `visibility:hidden` can stop some browsers
 * decoding a video at all, while a two-pixel element parked outside the viewport decodes exactly like
 * a visible one and paints nothing anywhere. Being in the document (not merely constructed) is the
 * other part — a detached element is decoded only as a courtesy.
 *
 * The point is that the preview keeps working: the user can scrub, or leave it playing, and the
 * export is unaffected because it never touches that element.
 *
 * Exported because the export needs one in more than one place - the picture and the audio are pulled
 * from different passes - and because an element with this contract is worth being able to name.
 */
export function createDecodeElement(url) {
  const element = document.createElement('video');
  element.muted = true;
  element.defaultMuted = true;
  element.playsInline = true;
  element.setAttribute('playsinline', '');
  element.preload = 'auto';
  element.style.cssText =
    'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(element);
  element.src = url;
  element.load?.();
  return element;
}

/**
 * An off-screen `<img>` for an image clip, awaited on load.
 *
 * Awaited because the alternative is silent: `drawImage` on an image whose bytes have not arrived throws,
 * and the layer's own guard would skip that clip on *every* frame — a logo missing from the whole export
 * because it was a few milliseconds late on the first one. The timeout is the other half: a URL that
 * never loads must delay the export for a moment, not hang it.
 */
async function loadClipImage(url) {
  const image = new Image();
  image.decoding = 'async';
  const loaded = once(image, 'load', 15000);
  image.src = url;
  await loaded;
  return image;
}

/** Take the off-screen element back out of the document and release its decoder. */
function destroyDecodeElement(element) {
  if (!element) return;
  try {
    element.removeAttribute('src');
    element.load?.();
  } catch {
    /* already torn down */
  }
  element.remove();
}

/**
 * The picture as a stream of frames, decoded in order and off any clock, by Mediabunny.
 *
 * This is the difference between an export that takes as long as decoding takes and one that takes
 * 1448 ms per frame. The element path below (*and* the path this export shipped with) steps a paused
 * `<video>` with `currentTime`, and a seek on a paused element is a decoder flush plus a decode from
 * the previous keyframe — paid again for every single output frame, however close together those
 * frames are. Mediabunny drives the decoder itself and hands the frames over in sequence, so a kept
 * range of the file is **one pass** from the keyframe before it to its end, and no frame costs a
 * seek. It also decodes on no clock at all, so nothing is dropped to keep up with one.
 *
 * The frames arrive as canvases already at the output's size with the picture fitted inside them
 * (`fit: 'contain'` — the same arithmetic as `fitRect`), which is why the streaming path draws 1:1
 * and needs no rectangle of its own.
 *
 * Returns `null` — never throws — when this file is not one it can read and decode: an exotic
 * container, or a codec this browser has no decoder for. The caller then falls back to stepping a
 * `<video>` element, which handles anything the browser itself can play. The fallback is kept
 * deliberately runnable rather than theoretical; a path nobody exercises is a path that rots.
 *
 * @param {string} url
 * @returns {Promise<null | {mode: string, sourceSeconds: number, sourceSize: {width:number,height:number},
 *   frames: (options: {range: object, width: number, height: number}) => AsyncIterable<{canvas: HTMLCanvasElement, timestamp: number, duration: number}>,
 *   dispose: () => void}>}
 */
async function openPictureStream(url) {
  if (typeof fetch !== 'function' || typeof VideoDecoder === 'undefined') return null;
  let input = null;
  try {
    const blob = await (await fetch(url)).blob();
    input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    if (!(await input.canRead())) throw new Error('unreadable container');
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    if (!(await track.canDecode())) throw new Error('no decoder for this codec');
    const sourceSeconds = await input.computeDuration();
    const sourceSize = {
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
    };
    if (!(sourceSeconds > 0) || !(sourceSize.width > 0) || !(sourceSize.height > 0)) {
      throw new Error('no usable length or size');
    }
    // One sink for the whole export, built the first time a range asks for frames: the size it wants
    // is the export's own, which is not known until the bitrate and the probe have been settled.
    // `poolSize: 2` rather than 0 — each canvas is drawn and released immediately, so two in flight
    // is already generous, and a new 1080p canvas per frame for five thousand frames is churn.
    //
    // Two kinds of frame come out of this: the picture is asked for *at the output's size with the
    // picture fitted inside it* (drawn 1:1 by the export), and an overlay clip is asked for at its own
    // size, because a clip is fitted into its box by `clipDrawRect`, which needs the media's real
    // shape to do it.
    const sinks = new Map();
    return {
      mode: 'decoded in order, off the clock',
      sourceSeconds,
      sourceSize,
      frames({ range, width = null, height = null }) {
        const key = width && height ? `${width}x${height}` : 'natural';
        if (!sinks.has(key)) {
          sinks.set(
            key,
            width && height
              ? new CanvasSink(track, { width, height, fit: 'contain', poolSize: 2 })
              : new CanvasSink(track, { poolSize: 2 }),
          );
        }
        return sinks.get(key).canvases(range.srcIn, Math.min(range.srcOut, sourceSeconds));
      },
      dispose() {
        try {
          input?.dispose?.();
        } catch {
          /* already disposed */
        }
      },
    };
  } catch {
    try {
      input?.dispose?.();
    } catch {
      /* nothing to release */
    }
    return null;
  }
}

/**
 * How many output frames each kept range supplies, and where each run starts. Pure.
 *
 * The export walks the ranges rather than the frames because the streaming decoder walks them: one
 * pass per kept range, and a cut is a *different pass*, not a rewind. Rounding is settled here so
 * that every output frame belongs to exactly one range — the leftover frames go to the last range,
 * which is what keeps the file's length equal to `frameCount(seconds, rate)` however the cut was
 * placed.
 *
 * @returns {Array<{range: object, startIndex: number, count: number}>}
 */
export function rangeWindows(ranges, rate, totalFrames) {
  const list = Array.isArray(ranges) ? ranges : [];
  const total = Math.max(0, Math.round(Number(totalFrames) || 0));
  const windows = [];
  let index = 0;
  for (const range of list) {
    const seconds = Math.max(0, (Number(range?.srcOut) || 0) - (Number(range?.srcIn) || 0));
    const count = Math.max(0, Math.min(total - index, Math.round(seconds * (Number(rate) || 0))));
    if (count <= 0) continue;
    windows.push({ range, startIndex: index, count });
    index += count;
  }
  if (windows.length && index < total) windows[windows.length - 1].count += total - index;
  return windows;
}

/**
 * Seek the video to a frame's time and wait until that frame is the one it will draw.
 *
 * `seeked` is the contract: when it fires, the element's current frame *is* the one at the new
 * position, and `drawImage` copies it. One animation frame is waited after it so the compositor has
 * certainly presented it; no `requestVideoFrameCallback` is used, because on a *paused* video it can
 * simply never fire and each frame would then cost its whole timeout — which is how an offline encode
 * ends up slower than the real-time recording it replaced.
 *
 * @param {HTMLVideoElement} video
 * @param {number} t                             seconds in the source file
 * @param {{waitForPaint?:boolean, paintTimeout?:number}} [options]
 *   `waitForPaint` is off only in `tools/export-perf.mjs`, which measures what that wait costs and
 *   whether the frame is any different without it.
 */
export async function seekToFrame(video, t, { waitForPaint = true, paintTimeout = 32 } = {}) {
  if (Math.abs(video.currentTime - t) <= 1e-4) return;
  const seeked = once(video, 'seeked', 3000);
  try {
    video.currentTime = t;
  } catch {
    /* not seekable — the current frame stands */
  }
  await seeked;
  if (!waitForPaint) return;
  // One paint, but *bounded*. `requestAnimationFrame` is the right wait in a visible tab and is
  // throttled to nothing in a hidden one — and an export that only works while you watch it would be
  // no better than the recording this replaced. Once `seeked` has fired the decoded frame is what
  // `drawImage` copies, so the wait is belt-and-braces; the timeout is what keeps a background export
  // moving.
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(resolve)),
    new Promise((resolve) => setTimeout(resolve, paintTimeout)),
  ]);
}

/**
 * The duration to encode.
 *
 * A file written by `MediaRecorder` (and some live recordings) reports `duration === Infinity` until
 * it has been fully buffered. Seeking far past the end is the documented way to force the browser to
 * work it out; if even that fails, the document's own last caption end is the honest fallback.
 */
async function resolveDuration(video, fallback) {
  if (Number.isFinite(video.duration) && video.duration > 1e-3) return video.duration;
  const before = video.currentTime;
  const seeked = once(video, 'seeked', 2000);
  try {
    video.currentTime = 1e101;
  } catch {
    /* some containers refuse this; the fallback below covers it */
  }
  await seeked;
  const forced = video.duration;
  try {
    video.currentTime = before;
  } catch {
    /* ignore */
  }
  if (Number.isFinite(forced) && forced > 1e-3) return forced;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

/**
 * Decode an audio file to stereo float PCM at `sampleRate`, entirely offline.
 *
 * A throwaway `OfflineAudioContext` decodes (no autoplay policy, no output device needed), then a
 * second one resamples and up/down-mixes to the exact shape the encoder is configured for. Doing the
 * resample here rather than trusting the file's own rate keeps the configuration and the data in
 * agreement, which is what the encoder checks.
 */
async function decodeAudio(blob, sampleRate = 48000) {
  const bytes = await blob.arrayBuffer();
  const decoder = new OfflineAudioContext(1, 1, 44100);
  const decoded = await decoder.decodeAudioData(bytes);
  const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
  const mixer = new OfflineAudioContext(2, frames, sampleRate);
  const source = mixer.createBufferSource();
  source.buffer = decoded;
  source.connect(mixer.destination);
  source.start();
  return mixer.startRendering();
}

/**
 * Lay a decoded source buffer out along the kept ranges. Pure.
 *
 * The sound gets the same treatment as the picture: the parts of the source the cut removed are not
 * copied, so audio and picture stay in step across a cut. A buffer shorter than `outFrames` leaves
 * silence at the end — the honest result of asking for sound the track does not have.
 */
export function mapAudioToRanges(sourceBuffer, ranges, sampleRate, outFrames, channels = 2) {
  const out = [];
  for (let c = 0; c < channels; c += 1) out.push(new Float32Array(outFrames));
  const available = sourceBuffer.numberOfChannels;
  let written = 0;
  for (const range of ranges ?? []) {
    if (written >= outFrames) break;
    const from = Math.max(0, Math.round(range.srcIn * sampleRate));
    const to = Math.max(from, Math.round(range.srcOut * sampleRate));
    const count = Math.min(to - from, outFrames - written);
    if (count <= 0) continue;
    for (let c = 0; c < channels; c += 1) {
      const data = sourceBuffer.getChannelData(Math.min(c, available - 1));
      out[c].set(data.subarray(from, from + count), written);
    }
    written += count;
  }
  return out;
}

/** Copy planar float PCM into the interleaved-by-plane layout `AudioData` wants. */
function planarChunk(channelData, offset, frames, channels) {
  const out = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c += 1) {
    out.set(channelData[c].subarray(offset, offset + frames), c * frames);
  }
  return out;
}

/**
 * A stopwatch for the export's phases, off unless asked for.
 *
 * The export was reported as slow and the useful answer to "why" is a number per phase rather than
 * a theory, so every phase can be timed: the element seeks, the clip seeks, the compositing, the
 * caption rasterisation, the encode submission and the drains. Nothing is measured when `enabled` is
 * false - that is the whole point of the guard, because this runs once per output frame and a
 * stopwatch on the hot path would be measuring itself.
 *
 * One mark at a time, which is enough: the phases below are sequential, and the encoder runs on its
 * own thread while the next frame is being sought, so what this reports is *wall clock* - what the
 * user waits - not a CPU profile.
 */
function createTimings(enabled) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);
  const phase = {
    load: 0,
    clips: 0,
    duration: 0,
    setup: 0,
    seek: 0,
    clipSeek: 0,
    composite: 0,
    captions: 0,
    encode: 0,
    flush: 0,
    audioDecode: 0,
    audioEncode: 0,
    mux: 0,
  };
  let mark = 0;
  return {
    enabled: Boolean(enabled),
    get phase() {
      return phase;
    },
    start() {
      if (enabled) mark = now();
    },
    stop(name) {
      if (!enabled) return;
      phase[name] += now() - mark;
    },
  };
}

/**
 * Wait until the encoder's queue is short again, so a long export does not pile up in memory.
 *
 * Exported because a measurement of "how fast could this export go if decoding were free" has to
 * drain the queue the same way the export does; a harness with a drain of its own would measure a
 * throughput this pipeline never reaches.
 */
export async function drainEncoder(encoder, threshold) {
  let spins = 0;
  while (encoder.encodeQueueSize > threshold && spins < 6000) {
    await new Promise((resolve) => setTimeout(resolve, 4));
    spins += 1;
  }
}

// ---------------------------------------------------------------------------
// the export itself
// ---------------------------------------------------------------------------

/**
 * Render a document's captions over its video and encode the result to an `.mp4` or `.webm`.
 *
 * @param {object}  options
 * @param {object}  options.doc                        the caption document
 * @param {HTMLVideoElement} [options.video]           an already-loaded element to decode from
 * @param {string}  [options.sourceUrl]                a URL to decode from instead (an off-screen
 *                                                     element is created, so the on-screen preview is
 *                                                     left completely alone)
 * @param {Blob}    [options.audioBlob]                the uploaded audio file, if any
 * @param {'mp4'|'webm'} [options.format='mp4']
 * @param {number}  [options.fps]
 * @param {string}  [options.quality='high']
 * @param {{width:number,height:number}} [options.size]  the output resolution (defaults to the doc)
 * @param {number}  [options.videoBitsPerSecond]       an explicit video bitrate (the dialog's own)
 * @param {number}  [options.audioBitsPerSecond]       the audio bitrate to ask for first
 * @param {(fraction:number, message:string)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {Record<string,string>} [options.clipUrls]  the file behind each overlay clip, by clip id
 * @param {typeof createRenderer} [options.createRendererImpl]
 * @param {boolean} [options.instrument=false]        time each phase and hand the totals back on the
 *                                                     result as `timings` (see `tools/export-perf.mjs`)
 * @param {'auto'|'element'} [options.pictureDecoder='auto']  `'element'` forces the seek-per-frame
 *                                                     path, which is what `tools/export-perf.mjs`
 *                                                     compares the streaming one against
 * @returns {Promise<{blob: Blob, mimeType: string, format: string, seconds: number, sourceSeconds: number, width: number, height: number, frames: number, fps: number, audio: boolean, audioSkipped: string|null, audioNote: string|null, audioBitrate: number, videoCodec: string, audioCodec: string, videoBitsPerSecond: number, trimmed: boolean, clips: number, clipsMissing: string[]}>}
 */
export async function exportDocumentToVideo({
  doc,
  video = null,
  sourceUrl = null,
  audioBlob = null,
  format = DEFAULT_FORMAT,
  fps = 30,
  quality = 'high',
  size = null,
  videoBitsPerSecond = null,
  audioBitsPerSecond = null,
  onProgress = null,
  signal = null,
  clipUrls = null,
  createRendererImpl = createRenderer,
  instrument = false,
  pictureDecoder = 'auto',
} = {}) {
  if (!doc?.blocks?.length) {
    throw new Error('there are no captions to burn in — load a source or open the demo first');
  }
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('this browser has no WebCodecs, so it cannot encode a video — use Chrome or Edge');
  }

  const container = format === 'webm' ? 'webm' : 'mp4';
  // Off unless asked for: a stopwatch per frame is a cost of its own.
  const clock = createTimings(instrument);

  // Overlay clips are decoded from elements of the export's own (see the note in `editor/media-library.js`
  // — the preview's elements are being played and scrubbed, and a seek on one of those would jump the
  // preview under the user while the export ran). `clipsMissing` is what could not be loaded, so the
  // caller can say so instead of shipping a file that quietly lost a logo.
  const clipElements = new Map();
  const clipStreams = new Map();
  const clipsMissing = [];
  let mediaCanvas = null;
  let mediaCtx = null;
  let drawClipLayer = null;

  // ---- the picture ---------------------------------------------------------
  //
  // Two ways to get a frame out of the file, and the export takes the first one it can:
  //
  // * **decoded in order, off the clock**, by Mediabunny — the library the preview's copy is made
  //   with. Frames arrive in sequence, so no frame costs a seek. On this project's 2160p AV1 capture
  //   this is the difference between 1448 ms a frame and about 90 (`tools/export-perf.mjs`).
  // * **seeked frame by frame**, through an off-screen `<video>` — what this export shipped with,
  //   and what it still falls back to for a file Mediabunny cannot read or decode. Never the element
  //   on screen: the export's own, so the preview keeps whatever state the user left it in.
  let owned = null;
  let source = video;
  let picture = null;
  let pictureNote = null;

  if (sourceUrl && pictureDecoder !== 'element') {
    clock.start();
    picture = await openPictureStream(sourceUrl);
    clock.stop('load');
    if (!picture) {
      pictureNote =
        'this file could not be decoded frame by frame, so the export is stepping it through the browser instead';
    }
  }
  if (!picture && sourceUrl) {
    clock.start();
    owned = createDecodeElement(sourceUrl);
    source = owned;
    const ready = await readyMedia(owned);
    clock.stop('load');
    if (!ready && !(owned.videoWidth > 0 || owned.duration > 0)) {
      destroyDecodeElement(owned);
      throw new Error('the picture could not be loaded for the export');
    }
  }
  if (!picture && (!source || !(source.videoWidth > 0 || (Number.isFinite(source.duration) && source.duration > 0)))) {
    destroyDecodeElement(owned);
    throw new Error(
      'burning the captions into a video needs a loaded video — add one under Sources, or download the caption files instead',
    );
  }

  try {
    clock.start();
    const sourceSeconds = picture ? picture.sourceSeconds : await resolveDuration(source, lastCaptionEnd(doc));
    clock.stop('duration');
    const videoRanges = trackRanges(doc, 'video', sourceSeconds);
    if (!videoRanges.length) {
      throw new Error('the video track has been cut away entirely — reset the track to export');
    }
    const seconds = outputDuration(videoRanges);
    if (!(seconds > 0)) {
      throw new Error('the kept part of the video is too short to export — undo a cut and try again');
    }

    // The picture's own size, from whichever path is reading it — never the preview's, which may be
    // a smaller copy of it (see `io/preview-source.js`).
    const pictureSize = picture
      ? picture.sourceSize
      : { width: Number(source.videoWidth) || 0, height: Number(source.videoHeight) || 0 };
    const fallbackSize = evenSize(
      doc.canvas?.width || pictureSize.width || 1280,
      doc.canvas?.height || pictureSize.height || 720,
    );
    const target = size ? evenSize(size.width, size.height) : fallbackSize;
    const { width, height } = target;
    const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || doc.canvas?.fps || 30)));

    // Ask the browser which codec it will actually take, *at the bitrate we mean to use* — the old
    // probe asked with the default quality's bitrate and then encoded at another, so a config the
    // browser would have refused was never seen until `configure()` threw.
    const videoBits = Math.max(
      1,
      Math.round(Number(videoBitsPerSecond) || videoBitrate({ width, height, fps: rate, quality })),
    );
    const probe = await probeVideoConfig(container, width, height, rate, videoBits);
    if (!probe.ok) {
      throw new Error(
        `this browser refused every ${container === 'webm' ? 'VP9' : 'H.264'} encoder config (${probe.error ?? 'no supported codec'})`,
      );
    }
    const videoCodec = probe.codec;

    const frameDurUs = Math.round(1e6 / rate);
    // Where the picture sits inside the frame. The streaming path needs no rectangle: its frames are
    // already the output's size with the picture fitted inside them, by the same arithmetic.
    const fit = picture
      ? null
      : fitRect(
          { width: pictureSize.width || width, height: pictureSize.height || height },
          { width, height },
        );

    // ---- offline render surfaces -----------------------------------------
    clock.start();
    const composite = document.createElement('canvas');
    composite.width = width;
    composite.height = height;
    const cctx = composite.getContext('2d');

    const captionCanvas = document.createElement('canvas');
    captionCanvas.width = width;
    captionCanvas.height = height;
    const renderer = createRendererImpl('canvas2d');
    renderer.attach(captionCanvas);
    renderer.resize({ width, height, devicePixelRatio: 1, applyCssSize: false });
    await renderer.ensureFonts(doc);
    clock.stop('setup');

    // ---- the clip layer ----------------------------------------------------
    // A canvas of the same size as the frame, drawn between the picture and the captions. One size, one
    // DPR: the export draws at the output resolution, so the layer needs no scaling of its own.
    const clips = Array.isArray(doc.media) ? doc.media : [];
    if (clips.length) {
      mediaCanvas = document.createElement('canvas');
      mediaCanvas.width = width;
      mediaCanvas.height = height;
      mediaCtx = mediaCanvas.getContext('2d');
      /*
       * Step the video clips to their own frames, then draw the whole layer.
       *
       * A clip's frame lives at `clipSourceTime(clip, t)` **inside its own file** — which is what the
       * head trim advanced (`sourceIn`), and therefore what makes a clip trimmed at the front show the
       * frames it was trimmed *to* rather than the ones it began with. Images need none of this: their
       * single frame is the element.
       *
       * A video clip gets the same treatment as the picture, and for the same measured reason: stepping
       * one with `currentTime` costs about 1.2 s a frame on a 4K overlay — 88% of an export that had
       * already stopped seeking its own picture (`tools/export-perf.mjs --clip`). So it is decoded in
       * order too, one pass over the clip's own window, and the element remains the fallback for a file
       * the streaming decoder cannot read.
       */
      drawClipLayer = async (t) => {
        for (const clip of clips) {
          if (clip.kind !== 'video') continue;
          const stream = clipStreams.get(clip.id);
          if (stream) {
            await advanceClipStream(stream, t);
            continue;
          }
          const element = clipElements.get(clip.id);
          const duration = Number(element?.duration);
          if (!element || !(duration > 0)) continue;
          await seekToFrame(element, Math.min(clipSourceTime(clip, t), Math.max(0, duration - 1e-3)));
        }
        return drawMediaClips(mediaCtx, {
          clips,
          size: { width, height },
          time: t,
          resolve: (id) => clipStreams.get(id)?.current?.canvas ?? clipElements.get(id) ?? null,
        });
      };

      /**
       * Move one clip's own decoder to the frame its window wants at source time `t`.
       *
       * The pass is built the first time the clip is on screen (a clip decoded from its own start when
       * it first appears at `t > start` would show the wrong frames, so the window is `[sourceIn,
       * sourceIn + length]` and every frame in it is decoded in order, which is the point), and it is
       * advanced frame by frame after that: the frame a time wants is the last one that started at or
       * before it.
       */
      const advanceClipStream = async (stream, t) => {
        const clip = stream.clip;
        if (!(t >= clip.start - 1e-6) || !(t <= clip.end + 1e-6)) return;
        const want = clipSourceTime(clip, t);
        if (!stream.iterator) {
          // From *here*, not from the clip's own first frame: the first frame this is called for is the
          // first one the clip is on screen at, and a pass built from the clip's start would decode
          // everything between it and the export's own beginning — which after a cut can be minutes of
          // frames nobody will ever see.
          const from = Math.max(0, want);
          const to = Math.min(stream.stream.sourceSeconds, clipSourceTime(clip, clip.end));
          if (!(to > from)) return;
          stream.iterator = stream.stream.frames({ range: { srcIn: from, srcOut: to } })[Symbol.asyncIterator]();
          const first = await stream.iterator.next();
          stream.current = first.done ? null : first.value;
          stream.peek = first.done ? { done: true } : await stream.iterator.next();
        }
        while (!stream.peek.done && stream.peek.value.timestamp <= want + 1e-6) {
          stream.current = stream.peek.value;
          stream.peek = await stream.iterator.next();
        }
      };
      clock.start();
      for (const clip of clips) {
        const url = clipUrls?.[clip.id];
        if (!url) {
          clipsMissing.push(clip.name || clip.id);
          continue;
        }
        try {
          if (clip.kind === 'video') {
            const stream = await openPictureStream(url);
            if (stream) {
              clipStreams.set(clip.id, { clip, stream, iterator: null, peek: { done: true }, current: null });
            } else {
              const element = createDecodeElement(url);
              await readyMedia(element);
              element.pause?.();
              clipElements.set(clip.id, element);
            }
          } else {
            clipElements.set(clip.id, await loadClipImage(url));
          }
        } catch (err) {
          clipsMissing.push(clip.name || clip.id);
        }
      }
      clock.stop('clips');
    }

    // ---- audio, decided before a single frame is encoded -------------------
    const AudioEncoderApi = typeof AudioEncoder !== 'undefined' ? AudioEncoder : null;
    const audioCodec = AudioEncoderApi ? AUDIO_CODECS[container === 'webm' ? 'webm' : 'mp4'][0] : '';
    // The one sentence every "no sound" path reuses. AAC encoding is not implemented at every bitrate
    // in every Chromium build, so an .mp4 can be silently silent — and the useful thing to say is
    // which format *would* carry the sound, not just that this one did not.
    const audioUnavailable =
      container === 'webm'
        ? 'this browser will not encode Opus audio — the export is silent'
        : 'this browser will not encode AAC audio — this .mp4 is silent; choose the WebM format to keep the sound';
    const wantedAudioBitrate = Math.max(1, Math.round(Number(audioBitsPerSecond) || audioBitrate(quality)));
    let audioBuffer = null;
    let audioSkipped = null;
    let audioNote = null;
    // Named apart from the *requested* rate above, because the two are different numbers whenever the
    // browser refuses the one that was asked for.
    let chosenAudioBitrate = 0;
    if (audioCodec && audioBlob) {
      try {
        clock.start();
        audioBuffer = await decodeAudio(audioBlob, 48000);
        clock.stop('audioDecode');
        const support = (rate) =>
          AudioEncoderApi.isConfigSupported({
            codec: audioCodec,
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: rate,
          }).then((s) => Boolean(s?.supported));
        const accepted = await resolveAudioBitrate(support, wantedAudioBitrate);
        if (accepted) {
          chosenAudioBitrate = accepted;
          if (accepted !== wantedAudioBitrate) {
            audioNote = `the ${container === 'webm' ? 'Opus' : 'AAC'} encoder will not take ${Math.round(wantedAudioBitrate / 1000)} kbps, so the sound is encoded at ${Math.round(accepted / 1000)} kbps`;
          }
        } else {
          audioBuffer = null;
          audioSkipped = audioUnavailable;
        }
      } catch (err) {
        audioBuffer = null;
        audioSkipped = `the audio file could not be decoded (${err?.message ?? err}) — the export is silent`;
      }
    } else if (audioBlob && !audioCodec) {
      audioSkipped = audioUnavailable;
    } else if (!audioBlob) {
      audioSkipped = 'no uploaded audio file was loaded — the export is silent (load the master track under Sources to include sound)';
    }

    // ---- the muxer ---------------------------------------------------------
    const muxTarget = container === 'webm' ? new WebmTarget() : new Mp4Target();
    const muxVideo = { codec: muxerVideoCodec(container, videoCodec), width, height, frameRate: rate };
    const muxAudio = audioBuffer
      ? { codec: muxerAudioCodec(container, audioCodec), numberOfChannels: 2, sampleRate: 48000 }
      : null;
    const muxer =
      container === 'webm'
        ? new WebmMuxer({ target: muxTarget, video: muxVideo, ...(muxAudio ? { audio: muxAudio } : {}) })
        : new Mp4Muxer({
            target: muxTarget,
            video: muxVideo,
            ...(muxAudio ? { audio: muxAudio } : {}),
            fastStart: 'in-memory',
          });

    let encodeError = null;
    const videoEncoder = createVideoEncoder({
      container,
      codec: videoCodec,
      width,
      height,
      rate,
      bitrate: videoBits,
      onChunk: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      onError: (err) => {
        encodeError = err;
      },
    });

    // Save the element's state, but only for an element we did not create — ours came in muted and
    // paused and goes out of the document when we are done. The streaming path has no element at all.
    const saved =
      owned || !source
        ? null
        : { currentTime: source.currentTime, muted: source.muted, volume: source.volume, paused: source.paused };
    if (!owned && source) source.muted = true; // no monitoring while stepping frames

    const total = frameCount(seconds, rate);
    const keyEvery = Math.max(1, Math.round(rate * 2));
    const dropped = doc.blocks.filter((block) => sourceToOutputSafe(videoRanges, block) === false);
    // Output frames that had no picture to draw. Almost always zero; a number here is the honest
    // answer to "the end of my export is black" instead of a shrug.
    let blankFrames = 0;
    // How many frames actually got an overlay clip painted on them. `clipElements.size` counts the
    // files that were *loaded*, which is not the same question and was reported as if it were: a clip
    // decoded in order is not an element at all, so a working export read as "0 clips rendered".
    let clipFrames = 0;

    try {
      await source?.pause?.();
      const audioRanges = trackRanges(doc, 'audio', sourceSeconds);
      let i = 0;
      for (const window of rangeWindows(videoRanges, rate, total)) {
        // One decoder pass per kept range. The frames come in order, so the frame an output frame
        // wants is *the last one that started at or before it* — carried forward, never searched for.
        const iterator = picture
          ? picture.frames({ range: window.range, width, height })[Symbol.asyncIterator]()
          : null;
        let peek = iterator ? await iterator.next() : null;
        let current = peek && !peek.done ? peek.value : null;
        if (peek && !peek.done) peek = await iterator.next();
        try {
          for (let k = 0; k < window.count; k += 1, i += 1) {
            if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
            if (encodeError) throw encodeError;
            const outputTime = i / rate;
            // Where this output frame came from. Captions are drawn at the *source* time, not the
            // output time, because that is the clock they were timed against — which is what keeps a
            // caption on the right frame even when everything before it was cut away.
            const sourceTime = outputToSource(videoRanges, outputTime) ?? sourceSeconds;
            clock.start();
            if (iterator) {
              while (peek && !peek.done && peek.value.timestamp <= sourceTime + 1e-6) {
                current = peek.value;
                peek = await iterator.next();
              }
              if (!current) blankFrames += 1;
            } else {
              await seekToFrame(source, Math.min(sourceTime, Math.max(0, sourceSeconds - 1e-3)));
            }
            clock.stop('seek');

            clock.start();
            cctx.clearRect(0, 0, width, height);
            try {
              if (current) cctx.drawImage(current.canvas, 0, 0, width, height);
              else if (!iterator) cctx.drawImage(source, fit.x, fit.y, fit.width, fit.height);
            } catch {
              /* a frame not yet decodable — the next one draws */
            }
            clock.stop('composite');
            // ...then the clips, *under* the captions: the same stacking the preview shows, because
            // the export is meant to be what the preview showed.
            if (mediaCtx) {
              clock.start();
              try {
                const drawn = await drawClipLayer(sourceTime);
                if (drawn > 0) {
                  cctx.drawImage(mediaCanvas, 0, 0);
                  clipFrames += 1;
                }
              } catch {
                /* the overlay must never abort the export */
              }
              clock.stop('clipSeek');
            }
            clock.start();
            try {
              renderer.draw(doc, sourceTime, {});
              cctx.drawImage(captionCanvas, 0, 0, width, height);
            } catch {
              /* drawing must never abort the export */
            }
            clock.stop('captions');

            clock.start();
            const frame = new VideoFrame(composite, { timestamp: i * frameDurUs, duration: frameDurUs });
            videoEncoder.encode(frame, { keyFrame: i % keyEvery === 0 });
            frame.close();

            if (videoEncoder.encodeQueueSize > 6) await drainEncoder(videoEncoder, 3);
            clock.stop('encode');
            onProgress?.(total > 0 ? (i + 1) / total : 0, `rendering ${i + 1} / ${total} frames`);
          }
        } finally {
          // Let this pass go as soon as the range is done with it, rather than when the garbage
          // collector gets to it: a decoder running on behind the encoder is CPU the encoder is
          // waiting for.
          try {
            await iterator?.return?.();
          } catch {
            /* the pass is over, or the input is already gone */
          }
        }
      }
      clock.start();
      await videoEncoder.flush();
      clock.stop('flush');
      if (encodeError) throw encodeError;

      // ---- audio, one pass -------------------------------------------------
      let audioShort = false;
      if (audioBuffer) {
        const audioEncoder = new AudioEncoderApi({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (err) => {
            encodeError = err;
          },
        });
        audioEncoder.configure({
          codec: audioCodec,
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: chosenAudioBitrate,
        });
        // The sound follows the *audio* track's cuts, mapped onto the same output clock as the picture.
        const outFrames = Math.max(1, Math.round(seconds * 48000));
        const channelData = mapAudioToRanges(audioBuffer, audioRanges, 48000, outFrames, 2);
        audioShort = outputDuration(audioRanges) < seconds - 1e-3;
        const CHUNK = 1024;
        clock.start();
        for (let offset = 0; offset < outFrames; offset += CHUNK) {
          if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
          const frames = Math.min(CHUNK, outFrames - offset);
          const data = new AudioData({
            format: 'f32-planar',
            sampleRate: 48000,
            numberOfFrames: frames,
            numberOfChannels: 2,
            timestamp: Math.round((offset / 48000) * 1e6),
            data: planarChunk(channelData, offset, frames, 2),
          });
          audioEncoder.encode(data);
          data.close();
          if (audioEncoder.encodeQueueSize > 24) await drainEncoder(audioEncoder, 8);
        }
        await audioEncoder.flush();
        clock.stop('audioEncode');
        if (encodeError) throw encodeError;
      }
      onProgress?.(1, 'muxing the file');

      clock.start();
      muxer.finalize();
      clock.stop('mux');
      const { buffer } = muxTarget;
      const meta = EXPORT_FORMATS[container];
      const blob = new Blob([buffer], { type: meta.mime });
      if (!blob.size) throw new Error('the encoder produced an empty file');
      return {
        blob,
        mimeType: meta.mime,
        format: container,
        seconds,
        sourceSeconds,
        width,
        height,
        frames: total,
        fps: rate,
        audio: Boolean(audioBuffer),
        audioSkipped,
        audioNote: audioShort && !audioNote
          ? 'the audio track is shorter than the picture after the cut — the end of the export is silent'
          : audioNote,
        audioBitrate: chosenAudioBitrate,
        videoCodec,
        audioCodec: audioBuffer ? audioCodec : '',
        videoBitsPerSecond: videoBits,
        trimmed: dropped.length > 0 || outputDuration(videoRanges) < sourceSeconds - 1e-3,
        clips: clipElements.size,
        clipsMissing,
        // How the picture was read, and what it cost in honesty: a stream that quietly left frames
        // blank is the one thing this must never do without saying so.
        picture: picture ? picture.mode : 'seeked frame by frame',
        pictureNote,
        blankFrames,
        clipFrames,
        // Wall clock per phase, and only when the caller asked for it. `frames` and `seconds` are
        // repeated here so a reader of the breakdown does not have to hold two objects.
        timings: instrument ? { ...clock.phase, frames: total, seconds } : null,
      };
    } finally {
      try {
        videoEncoder.close();
      } catch {
        /* already closed */
      }
      picture?.dispose();
      if (saved) {
        source.muted = saved.muted;
        source.volume = saved.volume;
        try {
          source.currentTime = saved.currentTime;
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    destroyDecodeElement(owned);
    // Every clip element the export created goes with it — including the ones for clips the file never
    // got to use.
    for (const clip of doc.media ?? []) {
      const element = clipElements.get(clip.id);
      if (element) destroyDecodeElement(element);
      try {
        await clipStreams.get(clip.id)?.iterator?.return?.();
      } catch {
        /* the pass is over, or the input is already gone */
      }
      clipStreams.get(clip.id)?.stream?.dispose?.();
    }
    clipElements.clear();
    clipStreams.clear();
  }
}

/** Is this caption still on screen after the cut? Used only to count what the export dropped. */
function sourceToOutputSafe(ranges, block) {
  const end = Number(block?.end) || 0;
  const start = Number(block?.start) || 0;
  if (!(end > start)) return false;
  let kept = 0;
  for (const range of ranges) kept += Math.max(0, Math.min(end, range.srcOut) - Math.max(start, range.srcIn));
  return kept >= (end - start) * 0.5;
}

/** The last caption's end, used when a container refuses to report a duration. Pure. */
export function lastCaptionEnd(doc) {
  return (doc?.blocks ?? []).reduce((max, block) => (Number.isFinite(block.end) ? Math.max(max, block.end) : max), 0);
}

/**
 * Build and configure the `VideoEncoder` this export encodes through.
 *
 * Two things are decided here and nowhere else:
 *
 * * **`latencyMode: 'realtime'` is the rate control, not a clock.** The default (`quality`) makes
 *   Chrome ignore `bitrate` almost entirely on hard content (noise went out at 14 Mbps against a
 *   0.4 Mbps target), which would make the quality picker a lie: 'balanced' and 'best' produced the
 *   same file. `realtime` turns the bitrate into an actual budget, so the setting means what it says.
 *   The frames are still stepped offline either way.
 * * **`avc: { format: 'avc' }`** puts H.264 in the length-prefixed layout `mp4-muxer` expects.
 *
 * Exported because `tools/export-perf.mjs` measures the ceiling - what this pipeline could do if
 * decoding were free - by feeding frames straight to *this* encoder, and a harness that configured
 * one of its own would drift from the export the first time either changed.
 *
 * @param {{container?:string, codec:string, width:number, height:number, rate:number, bitrate:number,
 *          onChunk:Function, onError:Function}} options
 */
export function createVideoEncoder({
  container = 'mp4',
  codec,
  width,
  height,
  rate,
  bitrate,
  onChunk,
  onError,
}) {
  const encoder = new VideoEncoder({ output: onChunk, error: onError });
  encoder.configure({
    codec,
    width,
    height,
    bitrate,
    framerate: rate,
    latencyMode: 'realtime',
    ...(container === 'mp4' ? { avc: { format: 'avc' } } : {}),
  });
  return encoder;
}

/**
 * Ask `VideoEncoder.isConfigSupported` for each candidate until one says yes.
 * Returns `{ ok, codec, error }` — never throws.
 *
 * Asynchronous on purpose, and that is why it exists at all: `pickVideoCodec` takes a *synchronous*
 * probe, and a `Promise` is always truthy, so a caller that passed `isConfigSupported(...)` directly
 * would silently pick the first candidate the browser cannot encode.
 */
export async function probeVideoConfig(format, width, height, fps, bitrate) {
  if (typeof VideoEncoder?.isConfigSupported !== 'function') {
    return { ok: true, codec: pickVideoCodec(format, () => true), error: null };
  }
  const candidates = format === 'webm' ? VIDEO_CODECS.webm : VIDEO_CODECS.mp4;
  let error = null;
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
        bitrate: bitrate ?? videoBitrate({ width, height, fps }),
      });
      if (support?.supported) return { ok: true, codec, error: null };
    } catch (err) {
      error = err?.message ?? String(err);
    }
  }
  return { ok: false, codec: '', error };
}
