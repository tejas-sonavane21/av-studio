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
 * 1. **Frames are stepped, not played.** For each frame the video is seeked to that frame's time, the
 *    picture and the caption layer are composited onto an offscreen canvas at the *document's* own
 *    resolution, and that canvas becomes a `VideoFrame`. Nothing depends on wall-clock time, so the
 *    tab can be in the background and the frame rate is exact — every frame the document asks for.
 * 2. **The browser encodes.** `VideoEncoder` (H.264 for `.mp4`, VP9 for `.webm`) and `AudioEncoder`
 *    (AAC or Opus) turn those frames into compressed chunks. This is an *offline* encode with
 *    lookahead, unlike a real-time recorder, so the same bitrate looks noticeably cleaner.
 * 3. **A muxer writes the container.** WebCodecs produces chunks, not a file; the vendored
 *    `mp4-muxer` / `webm-muxer` (see `vendor/VENDOR.md`) assemble them into a playable file.
 *
 * The sound is decoded from the *uploaded audio file* with `decodeAudioData` and re-encoded in one
 * pass — no playback, so no drift and no "the track had already played out" failure mode. Audio that
 * only exists inside the video file is not extracted (that would need a demuxer this project does not
 * carry); the export says so rather than quietly going silent.
 *
 * Everything that can be decided without a browser — the codec choices, the frame count, the aspect
 * fit — is a pure function, so it is unit-tested in Node (see `tests/unit/webcodecs-export.test.js`).
 */

import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from '../../vendor/muxers/webm-muxer.mjs';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from '../../vendor/muxers/mp4-muxer.mjs';
import { createRenderer } from '../render/renderer.js';
import { fitRect } from '../util/math.js';
import { audioBitrate, videoBitrate } from './download.js';

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
 * @param {HTMLVideoElement} options.video             the picture to composite over
 * @param {Blob}    [options.audioBlob]                the uploaded audio file, if any
 * @param {'mp4'|'webm'} [options.format='mp4']
 * @param {number}  [options.fps]
 * @param {string}  [options.quality='high']
 * @param {(fraction:number, message:string)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {typeof createRenderer} [options.createRendererImpl]
 * @returns {Promise<{blob: Blob, mimeType: string, format: string, seconds: number, width: number, height: number, frames: number, fps: number, audio: boolean, audioSkipped: string|null, videoCodec: string, audioCodec: string, videoBitsPerSecond: number}>}
 */
export async function exportDocumentToVideo({
  doc,
  video,
  audioBlob = null,
  format = DEFAULT_FORMAT,
  fps = 30,
  quality = 'high',
  onProgress = null,
  signal = null,
  createRendererImpl = createRenderer,
} = {}) {
  if (!doc?.blocks?.length) {
    throw new Error('there are no captions to burn in — load a source or open the demo first');
  }
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('this browser has no WebCodecs, so it cannot encode a video — use Chrome or Edge');
  }
  if (!video || !(video.videoWidth > 0 || (Number.isFinite(video.duration) && video.duration > 0))) {
    throw new Error(
      'burning the captions into a video needs a loaded video — add one under Sources, or download the caption files instead',
    );
  }

  const container = format === 'webm' ? 'webm' : 'mp4';
  const width = Math.max(1, Math.round(doc.canvas?.width || video.videoWidth || 1280));
  const height = Math.max(1, Math.round(doc.canvas?.height || video.videoHeight || 720));
  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || doc.canvas?.fps || 30)));

  // Ask the browser which codec it will actually take. `isConfigSupported` is async, so this is the
  // one place the choice is made for real (the synchronous `pickVideoCodec` above is the same order,
  // used by the unit tests and as the fallback when the probe is unavailable).
  const probe = await probeVideoConfig(container, width, height, rate);
  if (!probe.ok) {
    throw new Error(
      `this browser refused every ${container === 'webm' ? 'VP9' : 'H.264'} encoder config (${probe.error ?? 'no supported codec'})`,
    );
  }
  const videoCodec = probe.codec;

  const videoBitsPerSecond = videoBitrate({ width, height, fps: rate, quality });
  const frameDurUs = Math.round(1e6 / rate);
  const fit = fitRect(
    { width: video.videoWidth || width, height: video.videoHeight || height },
    { width, height },
  );

  // ---- offline render surfaces -------------------------------------------
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

  // ---- audio, decoded before a single frame is encoded -------------------
  const AudioEncoderApi = typeof AudioEncoder !== 'undefined' ? AudioEncoder : null;
  const audioCodec = AudioEncoderApi ? AUDIO_CODECS[container === 'webm' ? 'webm' : 'mp4'][0] : '';
  // The one sentence every "no sound" path reuses. AAC encoding is not implemented in every Chromium
  // build, so an .mp4 from a build without it is silent — and the useful thing to say is which format
  // *would* carry the sound, not just that this one did not.
  const audioUnavailable =
    container === 'webm'
      ? 'this browser will not encode Opus audio — the export is silent'
      : 'this browser will not encode AAC audio — this .mp4 is silent; choose the WebM format to keep the sound';
  let audioBuffer = null;
  let audioSkipped = null;
  if (audioCodec && audioBlob) {
    try {
      audioBuffer = await decodeAudio(audioBlob, 48000);
      const support = await AudioEncoderApi.isConfigSupported({
        codec: audioCodec,
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: audioBitrate(quality),
      });
      if (!support?.supported) {
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
  const target = container === 'webm' ? new WebmTarget() : new Mp4Target();
  const muxVideo = { codec: muxerVideoCodec(container, videoCodec), width, height, frameRate: rate };
  const muxAudio = audioBuffer
    ? { codec: muxerAudioCodec(container, audioCodec), numberOfChannels: 2, sampleRate: 48000 }
    : null;
  const muxer =
    container === 'webm'
      ? new WebmMuxer({ target, video: muxVideo, ...(muxAudio ? { audio: muxAudio } : {}) })
      : new Mp4Muxer({
          target,
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
    bitrate: videoBitsPerSecond,
    framerate: rate,
    // `realtime` is not "record in real time" — it is the encoder's *rate control*. The default
    // (`quality`) makes Chrome ignore `bitrate` almost entirely on hard content (noise went out at
    // 14 Mbps against a 0.4 Mbps target), which would make the quality picker a lie: 'balanced' and
    // 'best' produced the same file. `realtime` turns the bitrate into an actual budget, so the
    // setting means what it says. The frames are still stepped offline either way.
    latencyMode: 'realtime',
    ...(container === 'mp4' ? { avc: { format: 'avc' } } : {}),
  });

  // Save the element's state so an export is invisible to whatever the user was doing.
  const saved = { currentTime: video.currentTime, muted: video.muted, volume: video.volume, paused: video.paused };
  video.muted = true; // no monitoring while stepping frames

  const duration = await resolveDuration(video, lastCaptionEnd(doc));
  const total = frameCount(duration, rate);
  const keyEvery = Math.max(1, Math.round(rate * 2));

  try {
    await video.pause?.();
    for (let i = 0; i < total; i += 1) {
      if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      const t = i / rate;
      await seekToFrame(video, Math.min(t, Math.max(0, duration - 1 / rate)));

      cctx.clearRect(0, 0, width, height);
      try {
        cctx.drawImage(video, fit.x, fit.y, fit.width, fit.height);
      } catch {
        /* a frame not yet decodable — the next one draws */
      }
      try {
        renderer.draw(doc, t, {});
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
        bitrate: audioBitrate(quality),
      });
      const channelData = [audioBuffer.getChannelData(0), audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : audioBuffer.getChannelData(0)];
      const CHUNK = 1024;
      for (let offset = 0; offset < audioBuffer.length; offset += CHUNK) {
        if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
        const frames = Math.min(CHUNK, audioBuffer.length - offset);
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
      onProgress?.(1, 'muxing the file');
    }

    muxer.finalize();
    const { buffer } = target;
    const meta = EXPORT_FORMATS[container];
    const blob = new Blob([buffer], { type: meta.mime });
    if (!blob.size) throw new Error('the encoder produced an empty file');
    return {
      blob,
      mimeType: meta.mime,
      format: container,
      seconds: duration,
      width,
      height,
      frames: total,
      fps: rate,
      audio: Boolean(audioBuffer),
      audioSkipped,
      videoCodec,
      audioCodec: audioBuffer ? audioCodec : '',
      videoBitsPerSecond,
    };
  } finally {
    try {
      videoEncoder.close();
    } catch {
      /* already closed */
    }
    // put the element back exactly where it was
    video.muted = saved.muted;
    video.volume = saved.volume;
    try {
      video.currentTime = saved.currentTime;
    } catch {
      /* ignore */
    }
  }
}

/** The last caption's end, used when a container refuses to report a duration. Pure. */
export function lastCaptionEnd(doc) {
  return (doc?.blocks ?? []).reduce((max, block) => (Number.isFinite(block.end) ? Math.max(max, block.end) : max), 0);
}

/**
 * Ask `VideoEncoder.isConfigSupported` for each candidate until one says yes.
 * Returns `{ ok, codec, error }` — never throws.
 */
async function probeVideoConfig(format, width, height, fps) {
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
        bitrate: videoBitrate({ width, height, fps }),
      });
      if (support?.supported) return { ok: true, codec, error: null };
    } catch (err) {
      error = err?.message ?? String(err);
    }
  }
  return { ok: false, codec: '', error };
}
