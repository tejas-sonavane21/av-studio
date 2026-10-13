/**
 * io/preview-proxy.js — a smaller copy of the picture, for the *preview* only.
 *
 * The problem this solves is not rendering. Measured with `tools/preview-perf.mjs`, the editor's own
 * frame loop holds 60.0 fps against a bare `<video>`'s 59.9 while the browser presents **15.9**
 * frames a second of a 4K AV1 file: the decoder is the limit, and no care taken in this app's frame
 * loop can lift it. The only thing that helps is asking the decoder for less, which means a smaller
 * file — so one is made here, in the browser, from the file the user already has.
 *
 * Three decisions worth stating, because each one has an obvious cheaper alternative that is wrong:
 *
 * * **It is not an export path.** The copy is a preview aid. `io/preview-source.js` keeps the two
 *   apart, and the export is handed the *original* URL and the original's resolution — a finished
 *   file must never come out of the low-resolution copy.
 * * **The frames are encoded off the wall clock.** The first version of this recorded the canvas
 *   with `MediaRecorder` while the picture played, and that is what made the copy *worse* than the
 *   original: a recorder stamps every frame with the time it was handed over, so a source that
 *   presents 16 frames a second arrives as a 30 fps file with the same stutter baked in, and — the
 *   part that actually looked choppy — a software VP9 encoder competing with a 4K decoder for the
 *   same cores drops frames under the load, and the drops are invisible until the copy is played.
 *   Here each frame is stamped with the *media* time it had in the source
 *   (`requestVideoFrameCallback`'s `mediaTime`), handed to a `VideoEncoder`, and the encode is
 *   allowed to take longer than playback did: nothing is dropped to keep up with a clock, and the
 *   finished copy runs at exactly the speed of the picture it came from.
 * * **The sound comes along.** A preview that loses the picture's own soundtrack the moment it is
 *   made smoother is a bad trade; the element's audio track is captured into the same file, and
 *   `audio` says whether it did.
 *
 * The arithmetic — whether a picture is worth copying, what size to copy it to, how the two tracks
 * are interleaved — is pure and unit-tested in Node. Only `buildPreviewProxy()` needs a browser.
 */

import { Muxer, ArrayBufferTarget } from '../../vendor/muxers/webm-muxer.mjs';
import { createDecodeElement, evenSize, muxerAudioCodec, muxerVideoCodec, probeVideoConfig } from './webcodecs-export.js';

/** The long edge a copy is scaled to. 720p-landscape, and the size this project measured as enough. */
export const PROXY_LONG_EDGE = 1280;

/**
 * Above this long edge, a picture is worth copying.
 *
 * 1920, so 1080p is left alone — it decodes fine, and a copy of it would only be a second thing to
 * keep in step. 1440p and 4K are the sizes that actually stall a transport on a CPU.
 */
export const PROXY_THRESHOLD = 1920;

/** The copy's frame rate ceiling. The preview is for judging timing, not for grading colour. */
export const DEFAULT_PROXY_FPS = 30;

/**
 * The container every copy is written in.
 *
 * WebM — VP9 video, Opus audio — because the copy has to be *encodable by any Chrome*, on a machine
 * that is simultaneously decoding something far bigger. MP4/H.264 is the export's business: it may
 * need a hardware encoder the browser has not got, and a preview aid that fails on the machines that
 * need it most would be worse than none. `webcodecs-export.js` makes the same choice for `.webm`,
 * through the same `pickVideoCodec`/`pickAudioCodec` probes.
 */
export const PROXY_CONTAINER = 'webm';

/** A keyframe about every two seconds, so the copy can be scrubbed like the file it came from. */
export const PROXY_KEYFRAME_EVERY = 60;

/**
 * The copy's soundtrack codec: Opus, which is what WebM carries and every Chrome can encode.
 *
 * A single name rather than a candidate list, unlike the export's — there is no second option to
 * fall back to inside a WebM, and asking for one the browser has not got would cost the sound.
 */
export const PROXY_AUDIO_CODEC = 'opus';

/**
 * How deep the encoder's queue may get before the picture is paused for a moment.
 *
 * Not a performance knob but a memory and honesty one: every queued frame is a full-size bitmap, and
 * a copy that buffered a three-minute clip would hold a gigabyte. Pausing the *source* — a hidden,
 * muted element nobody is watching — is the alternative to dropping frames, and dropping frames is
 * the stutter this module exists to remove.
 */
export const PROXY_QUEUE_HIGH = 6;

/** How far the queue is drained before the picture is let go again. */
export const PROXY_QUEUE_LOW = 2;

/**
 * Would this picture benefit from a smaller copy?
 *
 * By long edge, which is the thing that decides how many pixels the decoder has to push out per
 * second. A 1080p file is left alone; anything above it is a candidate.
 */
export function needsProxy(width, height, { threshold = PROXY_THRESHOLD } = {}) {
  const long = Math.max(Number(width) || 0, Number(height) || 0);
  return long > threshold;
}

/**
 * The size to copy a `width`×`height` picture at, or `null` when there is nothing to scale.
 *
 * Never upscales: a 720p file copied "up" to the cap would be bigger, slower and no clearer. Even
 * dimensions always, because a codec configuration with an odd edge is refused outright.
 */
export function proxySize(width, height, { longEdge = PROXY_LONG_EDGE, threshold = PROXY_THRESHOLD } = {}) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!(w > 0 && h > 0)) return null;
  const long = Math.max(w, h);
  if (long <= threshold) return evenSize(w, h);
  const scale = longEdge / long;
  return evenSize(w * scale, h * scale);
}

/**
 * The video bitrate to spend on the copy. Pure.
 *
 * Deliberately modest and clamped: this file exists to be *decoded* quickly, and a generous bitrate
 * would undo the point of it. A tenth of a bit per pixel per frame puts 720p30 near 2 Mbps, which is
 * enough that a person can still judge whether a caption sits on the beat.
 */
export function proxyBitrate(width, height, fps = DEFAULT_PROXY_FPS) {
  const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || DEFAULT_PROXY_FPS)));
  const bits = pixels * rate * 0.1;
  return Math.round(Math.min(6_000_000, Math.max(600_000, bits)));
}

/** The `VideoEncoder` configuration for a copy of this size. Pure, so the shape is pinned in a test. */
export function proxyVideoConfig({ codec, width, height, fps = DEFAULT_PROXY_FPS, bitsPerSecond = null }) {
  const { width: w, height: h } = evenSize(width, height);    const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || DEFAULT_PROXY_FPS)));
  return {
    codec,
    width: w,
    height: h,
    bitrate: Math.round(Number(bitsPerSecond) || proxyBitrate(w, h, rate)),
    framerate: rate,
    // The same rate-control the export settled on, for the same reason: `quality` makes Chrome
    // ignore `bitrate` on hard content, and a copy whose bitrate is a suggestion can come out of the
    // encoder at ten times the size — which is the opposite of what this file is for. `realtime` is
    // the encoder's deadline, not a claim about when the frames arrive; they are still stamped with
    // the source's own times.
    latencyMode: 'realtime',
  };
}

/** The `AudioEncoder` configuration for the copy's soundtrack. Pure. */
export function proxyAudioConfig({ codec, sampleRate = 48000, channels = 2, bitsPerSecond = 96000 } = {}) {
  return {
    codec,
    sampleRate: Math.max(8000, Math.round(Number(sampleRate) || 48000)),
    numberOfChannels: Math.max(1, Math.min(2, Math.round(Number(channels) || 2))),
    bitrate: Math.max(6000, Math.round(Number(bitsPerSecond) || 96000)),
  };
}

/**
 * Video and audio chunks as one list, in timestamp order.
 *
 * The two tracks are encoded *independently* — the picture as fast as the decoder gives frames up,
 * the sound as it plays — so they arrive interleaved differently from how they must be written. Both
 * vendored muxers require monotonically increasing timestamps, and a WebM whose audio blocks sit
 * before video blocks they overlap is a file that plays wrong, so the merge happens here rather than
 * being hoped for from arrival order.
 *
 * Pure: entries are `{kind, timestamp, chunk}` and the ordering is by `timestamp`, with video first
 * when two chunks share one.
 */
export function mergeChunks(entries) {
  const order = (entry) => (entry?.kind === 'video' ? 0 : 1);
  return [...(entries ?? [])].sort((a, b) => {
    const byTime = Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0);
    return byTime !== 0 ? byTime : order(a) - order(b);
  });
}

/**
 * How far the copy's length is from the original's, as a sentence — or `''` when it is close enough
 * not to be worth mentioning.
 *
 * Stamped timestamps cannot promise a duration to the millisecond either — the last frame's own
 * length is a nominal one — so the difference is reported rather than claimed away. The threshold is
 * one frame at 30 fps plus a little: below that, nothing in a preview can be seen to be out of step.
 */
export function describeDrift(sourceSeconds, proxySeconds, { tolerance = 0.05 } = {}) {
  const source = Number(sourceSeconds) || 0;
  const copy = Number(proxySeconds) || 0;
  if (!(source > 0) || !(copy > 0)) return '';
  const drift = copy - source;
  if (Math.abs(drift) <= tolerance) return '';
  return (
    `the copy runs ${drift > 0 ? 'longer' : 'shorter'} than the original by ${Math.abs(drift).toFixed(2)}s ` +
    '(the last frame has no next frame to end it) — the preview may drift by that much; the export is unaffected'
  );
}

/**
 * What the copy holds, in one line — the difference between "the copy is choppy" and "the decoder
 * only ever had 16 frames a second to give".
 *
 * `presented` is how many frames the source presented during the pass and `frames` how many were
 * encoded; they should be equal, and saying so is the only way to tell a stutter that came with the
 * file from one this module introduced. Pure.
 */
export function describeFrames({ frames = 0, presented = 0, seconds = 0 } = {}) {
  const kept = Math.max(0, Math.round(Number(frames) || 0));
  const seen = Math.max(0, Math.round(Number(presented) || 0));
  const length = Number(seconds) || 0;
  if (!kept) return '';
  const rate = length > 0 ? (seen / length).toFixed(1) : '';
  const dropped = seen - kept;
  return (
    `${kept} frame(s) encoded` +
    (seen ? ` of the ${seen} the decoder presented` : '') +
    (rate ? ` — the picture had ${rate} frames a second to give` : '') +
    (dropped > 0 ? `; ${dropped} could not be encoded` : '')
  );
}

/** Is this browser able to make a copy at all? */
export function proxySupported(scope = globalThis) {
  return Boolean(
    scope.VideoEncoder &&
      scope.VideoFrame &&
      scope.HTMLCanvasElement?.prototype?.getContext &&
      scope.requestAnimationFrame,
  );
}

/** Resolve on `event`, `false` if it does not arrive within `timeout`. */
function waitFor(element, event, timeout = 8000) {
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

/** A media element loaded with `blob`, off-screen, so its reported duration can be read. */
async function measureSeconds(blob) {
  const element = document.createElement('video');
  element.muted = true;
  element.preload = 'metadata';
  element.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(element);
  const url = URL.createObjectURL(blob);
  try {
    element.src = url;
    element.load?.();
    await waitFor(element, 'loadedmetadata');
    let value = element.duration;
    if (!(Number.isFinite(value) && value > 0)) {
      // The same trick the exporter uses: a file whose index has not been read reports `Infinity`
      // until something makes the browser work the duration out, and seeking far past the end is
      // that something.
      const seeked = waitFor(element, 'seeked', 2000);
      try {
        element.currentTime = 1e101;
      } catch {
        /* the fallback below covers it */
      }
      await seeked;
      value = element.duration;
    }
    return Number.isFinite(value) && value > 0 ? value : 0;
  } finally {
    element.removeAttribute('src');
    element.remove();
    URL.revokeObjectURL(url);
  }
}

/** Wait `ms`, so the encode queue can drain without burning a frame callback on it. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Close a codec, once.
 *
 * A codec that has errored is **already closed** by the browser, so `close()` on it throws
 * `Cannot call 'close' on a closed codec` — and a tidy-up that throws is a copy that failed for a
 * reason that has nothing to do with the copy. The `state` check is the documented way to ask; the
 * catch is for the race between the check and the call.
 */
function closeCodec(codec) {
  try {
    if (codec && codec.state !== 'closed') codec.close();
  } catch {
    /* already closed, or closed in the time it took to ask */
  }
}

/**
 * Copy the picture at `url` into a smaller WebM, for the preview to play.
 *
 * The picture is played through **once**, on an element of our own, drawing each frame it presents
 * into a canvas the size of the copy. That is the cost: one playback of the clip, and nothing about
 * the picture on screen is touched. What is *not* on the clock is the encoding — frames carry the
 * timestamps they had in the source, so a decoder that manages 16 frames a second produces a 16 fps
 * copy that plays at the right speed, rather than a 30 fps file with the stutter preserved.
 *
 * @param {object} options
 * @param {string} options.url                          the original picture (an object URL or a file URL)
 * @param {{width:number,height:number}} [options.size] the copy's size; defaults to `proxySize()`
 * @param {number} [options.fps]                        the copy's frame rate ceiling
 * @param {string} [options.mimeType]                   override the container type of the returned blob
 * @param {number} [options.bitsPerSecond]
 * @param {AbortSignal} [options.signal]
 * @param {(fraction:number, message:string)=>void} [options.onProgress]
 * @returns {Promise<{blob: Blob, mimeType: string, width: number, height: number, fps: number, seconds: number,
 *   sourceSeconds: number, audio: boolean, drift: string, frames: number, presented: number,
 *   averageFps: number, encodeSeconds: number, codec: string, container: string, summary: string}>}
 */
export async function buildPreviewProxy({
  url,
  size = null,
  fps = DEFAULT_PROXY_FPS,
  mimeType = '',
  bitsPerSecond = null,
  signal = null,
  onProgress = null,
} = {}) {
  if (!url) throw new Error('there is no picture to copy');
  if (!proxySupported()) {
    throw new Error('this browser cannot make a preview copy (it needs WebCodecs VideoEncoder and a canvas) — use Chrome or Edge');
  }

  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || DEFAULT_PROXY_FPS)));
  const element = createDecodeElement(url);
  const chunks = [];
  let captured = null;
  let videoEncoder = null;
  let audioEncoder = null;
  let frameHandle = 0;
  let stopDrawing = false;
  let presented = 0;
  let frames = 0;
  let audio = false;
  let audioError = '';
  let encodeError = null;
  let audioReader = null;

  const encodeStart = { at: 0 };

  try {
    const ready = await waitFor(element, 'loadedmetadata', 20000);
    const sourceSeconds = Number(element.duration);
    if (!ready && !(element.videoWidth > 0)) throw new Error('the picture could not be loaded for the copy');

    const target = size ?? proxySize(element.videoWidth, element.videoHeight);
    if (!target) throw new Error('the picture has no usable size to copy');
    const { width, height } = evenSize(target.width, target.height);

    // The codec is the browser's answer, not ours: the export's own probe (same candidate list, same
    // per-codec `isConfigSupported`) decides, so a machine that encodes VP9 and one that only has
    // VP8 both get a copy instead of an error.
    const probe = await probeVideoConfig(
      PROXY_CONTAINER,
      width,
      height,
      rate,
      Math.round(Number(bitsPerSecond) || proxyBitrate(width, height, rate)),
    );
    if (!probe.ok) {
      throw new Error(
        `this browser will not encode VP9 or VP8, which is what a preview copy is written in${probe.error ? ` (${probe.error})` : ''}`,
      );
    }
    const codec = probe.codec;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('this browser would not give a 2D context for the copy');

    // ---- the sound, captured from the element's own track as the picture plays ---- //
    const sound = resolveAudioTrack(element);
    captured = sound?.stream ?? null;
    let audioConfig = null; // decided by the first buffer, not guessed from the track's settings
    if (sound) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => chunks.push({ kind: 'audio', timestamp: chunk.timestamp, chunk, meta }),
        error: (err) => {
          // A soundtrack that fails to encode must not fail the copy: the picture is the point, and
          // `audio: false` in the result says what happened rather than pretending otherwise. The
          // reason is carried out too — "the copy has no sound" is a bug report, and "the copy has no
          // sound because this browser refused 1-channel Opus at 44.1 kHz" is one somebody can act on.
          audio = false;
          audioError = String(err?.message ?? err);
        },
      });
      void drainAudio(audioEncoder, sound.track);
    } else {
      audioError = 'this browser would not give the picture\u2019s audio track an encoder';
    }

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => chunks.push({ kind: 'video', timestamp: chunk.timestamp, chunk, meta }),
      error: (err) => {
        // Recorded, never thrown: an exception out of an encoder callback is an unhandled error in
        // the page, which would take the editor down with it. The copy fails at the check after the
        // flush instead, with the encoder's own message.
        encodeError = err;
      },
    });
    videoEncoder.configure(proxyVideoConfig({ codec, width, height, fps: rate, bitsPerSecond }));

    async function drainAudio(encoder, track) {
      const processor = new MediaStreamTrackProcessor({ track });
      audioReader = processor.readable.getReader();
      for (;;) {
        let result;
        try {
          result = await audioReader.read();
        } catch {
          break;
        }
        if (result.done) break;
        const data = result.value;
        if (stopDrawing) {
          data.close?.();
          break;
        }
        if (!audioConfig) {
          // The configuration comes from the buffer itself, never from `track.getSettings()`. The two
          // disagree: a captured track reports the settings of the *stream*, while the buffers arrive
          // at the rate and channel count the decoder actually produced — and an encoder configured
          // for 2 channels fed 1-channel buffers fails with "Input audio buffer is incompatible with
          // codec parameters", which is a copy that silently loses its sound for no good reason.
          const config = proxyAudioConfig({
            codec: PROXY_AUDIO_CODEC,
            sampleRate: data.sampleRate,
            channels: data.numberOfChannels,
          });
          let supported = false;
          try {
            supported = Boolean((await AudioEncoder.isConfigSupported(config))?.supported);
          } catch {
            supported = false;
          }
          if (!supported) {
            audio = false;
            audioError =
              `this browser will not encode the picture's sound as ${config.codec} at ` +
              `${config.sampleRate} Hz, ${config.numberOfChannels} channel(s)`;
            data.close?.();
            break;
          }
          try {
            encoder.configure(config);
          } catch (err) {
            audio = false;
            audioError = String(err?.message ?? err);
            data.close?.();
            break;
          }
          audioConfig = config;
          audio = true;
        }
        try {
          encoder.encode(data);
        } catch {
          audio = false; // one bad buffer is not a failed copy; the picture still goes out
        }
        data.close?.();
      }
    }

    let throttling = false;
    const throttle = async () => {
      if (throttling || !videoEncoder) return;
      throttling = true;
      try {
        element.pause();
        while (videoEncoder && videoEncoder.encodeQueueSize > PROXY_QUEUE_LOW && !stopDrawing) {
          await sleep(4);
        }
        if (!stopDrawing) await element.play();
      } catch {
        /* a pause that fails is not a failed copy: the next frame draws either way */
      } finally {
        throttling = false;
      }
    };

    const draw = (mediaTime) => {
      if (stopDrawing || !videoEncoder || videoEncoder.state !== 'configured') return;
      try {
        ctx.drawImage(element, 0, 0, width, height);
      } catch {
        return; // a frame that is not decodable yet — the next one draws
      }
      const seconds = Number.isFinite(mediaTime) && mediaTime >= 0 ? mediaTime : Number(element.currentTime) || 0;
      const timestamp = Math.round(seconds * 1e6);
      let frame;
      try {
        frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1e6 / rate) });
      } catch {
        return; // the encoder is closed or the canvas is gone; there is nothing to hand over
      }
      try {
        videoEncoder.encode(frame, { keyFrame: frames % PROXY_KEYFRAME_EVERY === 0 });
        frames += 1;
      } catch {
        /* a refused frame is counted by the difference between what was presented and what was kept */
      } finally {
        frame.close();
      }
      if (videoEncoder.encodeQueueSize > PROXY_QUEUE_HIGH) void throttle();
      if (seconds > 0) {
        const length = Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : seconds;
        onProgress?.(Math.min(1, seconds / length), `copying the picture — ${Math.round((seconds / length) * 100)}%`);
      }
    };

    // `requestVideoFrameCallback` fires once per *presented* frame — which on this project's 4K case
    // is 15.9 a second rather than 60, and is exactly the point: the copy is only ever as good as the
    // decode that is actually available. Its `mediaTime` is the frame's own position in the source,
    // which is the timestamp the copy is written with.
    const schedule = () => {
      if (stopDrawing) return;
      if (typeof element.requestVideoFrameCallback === 'function') {
        frameHandle = element.requestVideoFrameCallback((_now, metadata) => {
          presented += 1;
          draw(metadata?.mediaTime);
          schedule();
        });
      } else {
        frameHandle = requestAnimationFrame(() => {
          presented += 1;
          draw(Number(element.currentTime));
          schedule();
        });
      }
    };

    const finished = new Promise((resolve) => {
      element.addEventListener('ended', () => resolve('ended'), { once: true });
      if (signal) {
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      }
    });

    encodeStart.at = performance.now();
    schedule();
    await element.play();
    const outcome = await finished;
    stopDrawing = true;
    if (typeof element.cancelVideoFrameCallback === 'function' && frameHandle) {
      try {
        element.cancelVideoFrameCallback(frameHandle);
      } catch {
        /* already cancelled */
      }
    }
    if (outcome === 'aborted' || signal?.aborted) throw new DOMException('copy cancelled', 'AbortError');

    // Everything the picture had is now in the encoders. Flushing is where the time goes that a
    // recorder would have spent dropping frames, and it is time nobody is watching: the copy is
    // handed over when it is *finished*, not when the clip stopped playing.
    onProgress?.(1, 'packing the copy');
    try {
      await videoEncoder.flush();
    } catch (err) {
      // A flush that rejects is an encoder that has already failed; the closure below reports it.
      encodeError = encodeError ?? err;
    }
    closeCodec(videoEncoder);
    if (encodeError) throw new Error(`the picture could not be encoded: ${encodeError?.message ?? encodeError}`);
    if (audioEncoder && audioConfig) {
      try {
        await audioEncoder.flush();
      } catch (err) {
        // A codec that failed is closed by the browser, so a rejected flush here is expected
        // whenever the error callback above fired — the reason it fired is what matters.
        audio = false;
        audioError = audioError || String(err?.message ?? err);
      }
      closeCodec(audioEncoder);
    }

    const ordered = mergeChunks(chunks);
    if (!ordered.some((entry) => entry.kind === 'video')) {
      throw new Error('the copy came out empty — the picture may use a codec this browser cannot re-encode');
    }
    if (!ordered.some((entry) => entry.kind === 'audio')) {
      audio = false;
      audioError = audioError || 'no sound was captured from the picture — it may have no audio track';
    }

    const target2 = new ArrayBufferTarget();
    const muxer = new Muxer({
      target: target2,
      video: { codec: muxerVideoCodec(PROXY_CONTAINER, codec), width, height, frameRate: rate },
      // The two tracks are stamped on **different clocks**, and this is the option that squares them.
      // A picture frame carries the media time it had in the source, so the first one is 0. An
      // `AudioData` handed over by a `MediaStreamTrackProcessor` carries the track's own timeline —
      // relative to the age of the *document* (measured here: the first chunk arrived stamped 33 ms,
      // a whole document's worth of milliseconds after zero). Left alone, the muxer refuses the file
      // outright: "The first chunk for your media track must have a timestamp of 0". `offset`
      // rebases each track so its own first timestamp is zero, which is what a copy that starts at
      // the start of the clip means. (`permissive` would accept the number as-is and write a file
      // whose sound starts 33 ms late.)
      firstTimestampBehavior: 'offset',
      ...(audio && audioConfig
        ? {
            audio: {
              codec: muxerAudioCodec(PROXY_CONTAINER, audioConfig.codec),
              numberOfChannels: audioConfig.numberOfChannels,
              sampleRate: audioConfig.sampleRate,
            },
          }
        : {}),
    });
    for (const entry of ordered) {
      if (entry.kind === 'video') muxer.addVideoChunk(entry.chunk, entry.meta);
      else muxer.addAudioChunk(entry.chunk, entry.meta);
    }
    muxer.finalize();

    const blob = new Blob([target2.buffer], { type: mimeType || 'video/webm' });
    if (!blob.size) throw new Error('the copy came out empty — the picture may use a codec this browser cannot re-encode');
    const seconds = await measureSeconds(blob);
    const encodeSeconds = (performance.now() - encodeStart.at) / 1000;
    onProgress?.(1, 'the copy is ready');
    const summary = describeFrames({ frames, presented, seconds: Number.isFinite(sourceSeconds) ? sourceSeconds : seconds });
    return {
      blob,
      mimeType: blob.type,
      width,
      height,
      fps: rate,
      seconds,
      sourceSeconds: Number.isFinite(sourceSeconds) ? sourceSeconds : seconds,
      audio,
      audioError,
      drift: describeDrift(sourceSeconds, seconds),
      frames,
      presented,
      averageFps: seconds > 0 ? Number((frames / seconds).toFixed(2)) : 0,
      encodeSeconds: Number(encodeSeconds.toFixed(2)),
      codec,
      container: PROXY_CONTAINER,
      summary,
    };
  } finally {
    stopDrawing = true;
    closeCodec(videoEncoder);
    closeCodec(audioEncoder);
    for (const track of captured?.getTracks?.() ?? []) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      audioReader?.releaseLock?.();
    } catch {
      /* nothing to release */
    }
    try {
      element.pause();
    } catch {
      /* ignore */
    }
    element.remove();
  }
}

/**
 * The element's own audio track, or `null` when there is none to capture.
 *
 * `captureStream()` is the only way to get the element's *decoded* audio without decoding the file a
 * second time, and the stream is returned rather than just the track so the caller can stop every
 * track it created when the copy is done.
 *
 * Nothing is guessed about the format here — deliberately. The buffers decide it (see `drainAudio`),
 * and whether the result carries signal is *measured* when the copy is played back, not assumed: a
 * silent copy is the failure mode this whole branch exists to avoid, and it cannot be seen in the
 * success or failure of a call.
 */
function resolveAudioTrack(element) {
  if (typeof AudioEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') return null;
  if (typeof element.captureStream !== 'function') return null;
  try {
    const stream = element.captureStream();
    const track = stream?.getAudioTracks?.()?.[0] ?? null;
    if (!track) {
      stream?.getTracks?.().forEach((each) => each.stop());
      return null;
    }
    return { stream, track };
  } catch {
    return null;
  }
}
