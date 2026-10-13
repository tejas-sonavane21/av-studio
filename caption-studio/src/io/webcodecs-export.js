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
 * Exported because `io/preview-proxy.js` needs the same thing for the same reason: copying the picture
 * has to decode it, and decoding it must not disturb the element on screen.
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
 * Seek the video to a frame's time and wait until that frame is the one it will draw.
 *
 * `seeked` is the contract: when it fires, the element's current frame *is* the one at the new
 * position, and `drawImage` copies it. One animation frame is waited after it so the compositor has
 * certainly presented it; no `requestVideoFrameCallback` is used, because on a *paused* video it can
 * simply never fire and each frame would then cost its whole timeout — which is how an offline encode
 * ends up slower than the real-time recording it replaced.
 */
async function seekToFrame(video, t) {
  if (Math.abs(video.currentTime - t) <= 1e-4) return;
  const seeked = once(video, 'seeked', 3000);
  try {
    video.currentTime = t;
  } catch {
    /* not seekable — the current frame stands */
  }
  await seeked;
  // One paint, but *bounded*. `requestAnimationFrame` is the right wait in a visible tab and is
  // throttled to nothing in a hidden one — and an export that only works while you watch it would be
  // no better than the recording this replaced. Once `seeked` has fired the decoded frame is what
  // `drawImage` copies, so the wait is belt-and-braces; the timeout is what keeps a background export
  // moving.
  await Promise.race([
    new Promise((resolve) => requestAnimationFrame(resolve)),
    new Promise((resolve) => setTimeout(resolve, 32)),
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

/** Wait until the encoder's queue is short again, so a long export does not pile up in memory. */
async function drain(encoder, threshold) {
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
} = {}) {
  if (!doc?.blocks?.length) {
    throw new Error('there are no captions to burn in — load a source or open the demo first');
  }
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('this browser has no WebCodecs, so it cannot encode a video — use Chrome or Edge');
  }

  const container = format === 'webm' ? 'webm' : 'mp4';

  // Overlay clips are decoded from elements of the export's own (see the note in `editor/media-library.js`
  // — the preview's elements are being played and scrubbed, and a seek on one of those would jump the
  // preview under the user while the export ran). `clipsMissing` is what could not be loaded, so the
  // caller can say so instead of shipping a file that quietly lost a logo.
  const clipElements = new Map();
  const clipsMissing = [];
  let mediaCanvas = null;
  let mediaCtx = null;
  let drawClipLayer = null;

  // ---- the decode surface -------------------------------------------------
  // Never the element on screen. `sourceUrl` gives the export its own, so the preview keeps whatever
  // state the user left it in — including playing.
  let owned = null;
  let source = video;
  if (sourceUrl) {
    owned = createDecodeElement(sourceUrl);
    source = owned;
    const ready = await readyMedia(owned);
    if (!ready && !(owned.videoWidth > 0 || owned.duration > 0)) {
      destroyDecodeElement(owned);
      throw new Error('the picture could not be loaded for the export');
    }
  }
  if (!source || !(source.videoWidth > 0 || (Number.isFinite(source.duration) && source.duration > 0))) {
    destroyDecodeElement(owned);
    throw new Error(
      'burning the captions into a video needs a loaded video — add one under Sources, or download the caption files instead',
    );
  }

  try {
    const sourceSeconds = await resolveDuration(source, lastCaptionEnd(doc));
    const videoRanges = trackRanges(doc, 'video', sourceSeconds);
    if (!videoRanges.length) {
      throw new Error('the video track has been cut away entirely — reset the track to export');
    }
    const seconds = outputDuration(videoRanges);
    if (!(seconds > 0)) {
      throw new Error('the kept part of the video is too short to export — undo a cut and try again');
    }

    const fallbackSize = evenSize(doc.canvas?.width || source.videoWidth || 1280, doc.canvas?.height || source.videoHeight || 720);
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
    const fit = fitRect(
      { width: source.videoWidth || width, height: source.videoHeight || height },
      { width, height },
    );

    // ---- offline render surfaces -----------------------------------------
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
       */
      drawClipLayer = async (t) => {
        for (const clip of clips) {
          if (clip.kind !== 'video') continue;
          const element = clipElements.get(clip.id);
          const duration = Number(element?.duration);
          if (!element || !(duration > 0)) continue;
          await seekToFrame(element, Math.min(clipSourceTime(clip, t), Math.max(0, duration - 1e-3)));
        }
        return drawMediaClips(mediaCtx, {
          clips,
          size: { width, height },
          time: t,
          resolve: (id) => clipElements.get(id) ?? null,
        });
      };
      for (const clip of clips) {
        const url = clipUrls?.[clip.id];
        if (!url) {
          clipsMissing.push(clip.name || clip.id);
          continue;
        }
        try {
          if (clip.kind === 'video') {
            const element = createDecodeElement(url);
            await readyMedia(element);
            element.pause?.();
            clipElements.set(clip.id, element);
          } else {
            clipElements.set(clip.id, await loadClipImage(url));
          }
        } catch (err) {
          clipsMissing.push(clip.name || clip.id);
        }
      }
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
        audioBuffer = await decodeAudio(audioBlob, 48000);
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
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        encodeError = err;
      },
    });
    videoEncoder.configure({
      codec: videoCodec,
      width,
      height,
      bitrate: videoBits,
      framerate: rate,
      // `realtime` is not "record in real time" — it is the encoder's *rate control*. The default
      // (`quality`) makes Chrome ignore `bitrate` almost entirely on hard content (noise went out at
      // 14 Mbps against a 0.4 Mbps target), which would make the quality picker a lie: 'balanced' and
      // 'best' produced the same file. `realtime` turns the bitrate into an actual budget, so the
      // setting means what it says. The frames are still stepped offline either way.
      latencyMode: 'realtime',
      ...(container === 'mp4' ? { avc: { format: 'avc' } } : {}),
    });

    // Save the element's state, but only for an element we did not create — ours came in muted and
    // paused and goes out of the document when we are done.
    const saved = owned
      ? null
      : { currentTime: source.currentTime, muted: source.muted, volume: source.volume, paused: source.paused };
    if (!owned) source.muted = true; // no monitoring while stepping frames

    const total = frameCount(seconds, rate);
    const keyEvery = Math.max(1, Math.round(rate * 2));
    const dropped = doc.blocks.filter((block) => sourceToOutputSafe(videoRanges, block) === false);

    try {
      await source.pause?.();
      const audioRanges = trackRanges(doc, 'audio', sourceSeconds);
      for (let i = 0; i < total; i += 1) {
        if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
        if (encodeError) throw encodeError;
        const outputTime = i / rate;
        // Where this output frame came from. Captions are drawn at the *source* time, not the output
        // time, because that is the clock they were timed against — which is what keeps a caption on
        // the right frame even when everything before it was cut away.
        const sourceTime = outputToSource(videoRanges, outputTime) ?? sourceSeconds;
        await seekToFrame(source, Math.min(sourceTime, Math.max(0, sourceSeconds - 1e-3)));

        cctx.clearRect(0, 0, width, height);
        try {
          cctx.drawImage(source, fit.x, fit.y, fit.width, fit.height);
        } catch {
          /* a frame not yet decodable — the next one draws */
        }
        // ...then the clips, *under* the captions: the same stacking the preview shows, because the
        // export is meant to be what the preview showed.
        if (mediaCtx) {
          try {
            const drawn = await drawClipLayer(sourceTime);
            if (drawn > 0) cctx.drawImage(mediaCanvas, 0, 0);
          } catch {
            /* the overlay must never abort the export */
          }
        }
        try {
          renderer.draw(doc, sourceTime, {});
          cctx.drawImage(captionCanvas, 0, 0, width, height);
        } catch {
          /* drawing must never abort the export */
        }

        const frame = new VideoFrame(composite, { timestamp: i * frameDurUs, duration: frameDurUs });
        videoEncoder.encode(frame, { keyFrame: i % keyEvery === 0 });
        frame.close();

        if (videoEncoder.encodeQueueSize > 6) await drain(videoEncoder, 3);
        onProgress?.(total > 0 ? (i + 1) / total : 0, `rendering ${i + 1} / ${total} frames`);
      }
      await videoEncoder.flush();
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
          if (audioEncoder.encodeQueueSize > 24) await drain(audioEncoder, 8);
        }
        await audioEncoder.flush();
        if (encodeError) throw encodeError;
      }
      onProgress?.(1, 'muxing the file');

      muxer.finalize();
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
      };
    } finally {
      try {
        videoEncoder.close();
      } catch {
        /* already closed */
      }
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
    }
    clipElements.clear();
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
 * Ask `VideoEncoder.isConfigSupported` for each candidate until one says yes.
 * Returns `{ ok, codec, error }` — never throws.
 *
 * Asynchronous on purpose, and that is why it exists at all: `pickVideoCodec` takes a *synchronous*
 * probe, and a `Promise` is always truthy, so a caller that passed `isConfigSupported(...)` directly
 * would silently pick the first candidate the browser cannot encode. The preview copy
 * (`io/preview-proxy.js`) goes through here for exactly this reason.
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
