/**
 * io/preview-proxy.js — a smaller copy of the picture, for the *preview* only.
 *
 * The problem this solves is not rendering. Measured with `tools/preview-perf.mjs`, the editor's own
 * frame loop holds 59.7 fps against a bare `<video>`'s 60.1 while the browser presents **18.5** frames a
 * second of a 4K AV1 file (24.4 on the same page with nothing else on it): the decoder is the limit, and
 * no care taken in this app's frame loop can lift it. The only thing that helps is asking the decoder for
 * less, which means a smaller file — so one is made here, in the browser, from the file the user already
 * has. Against that same harness the copy is presented at **60.1** frames a second.
 *
 * The copy is made by **Mediabunny** (`vendor/mediabunny/`), and that is the second attempt at this
 * module. The first one played the picture through a hidden `<video>` and encoded the frames it
 * presented, and the copy it produced was *as choppy as the original*: a `<video>` element presents
 * frames on the wall clock, so a 4K file whose decoder manages 15.9 frames a second offers 15.9
 * frames a second to whoever is watching — the copy inherited exactly the stutter it existed to
 * remove, and no amount of care in an encoder could undo it. Mediabunny drives the decoder itself
 * (`VideoDecoder`, hardware-accelerated where the machine has it, and on no clock at all) and writes
 * every frame it gets, so the copy carries the file's real motion, and a pass over a three-minute
 * clip takes as long as decoding takes rather than as long as the clip runs.
 *
 * Three decisions worth stating, because each one has an obvious cheaper alternative that is wrong:
 *
 * * **It is not an export path.** The copy is a preview aid. `io/preview-source.js` keeps the two
 *   apart, and the export is handed the *original* URL and the original's resolution — a finished
 *   file must never come out of the low-resolution copy.
 * * **Nothing is dropped to keep up with a clock.** The copy's frame rate is capped (a 60 fps master
 *   is worth 30 for judging whether a caption lands on the beat) but never raised, and the cap is
 *   only applied when the source really is faster than it: a 24 fps film is copied at 24, not
 *   padded to 30. The length is the file's own length, to the frame.
 * * **The sound comes along.** A preview that loses the picture's own soundtrack the moment it is
 *   made smoother is a bad trade, so the audio track is carried over too — copied where the
 *   container allows it, re-encoded where it does not — and the copy says whether it worked.
 *
 * The arithmetic — whether a picture is worth copying, what size to copy it to, what to ask the
 * encoder for — is pure and unit-tested in Node. Only `buildPreviewProxy()` needs a browser.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  Quality,
  WebMOutputFormat,
} from '../../vendor/mediabunny/mediabunny.min.mjs';
import { evenSize } from './webcodecs-export.js';

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
 * WebM — VP9, VP8 or AV1 video with Opus audio — because it is what a browser can *contain* without
 * a licence or a muxer of its own, and because Mediabunny can encode into it on any Chrome. MP4 is
 * the export's business: a preview aid that failed on the machines that need it most would be worse
 * than no aid at all.
 */
export const PROXY_CONTAINER = 'webm';

/** The MIME type of a copy. WebM, spelled the way a `<video>` element expects to be told. */
export const PROXY_MIME_TYPE = 'video/webm';

/** A keyframe about every two seconds, so the copy can be scrubbed like the file it came from. */
export const PROXY_KEYFRAME_SECONDS = 2;

/**
 * How close to the ceiling a source frame rate has to be before the cap is not worth applying.
 *
 * 29.97 is not 30, and a copy of a 29.97 master that was "capped" to 30 would be asked to *raise*
 * its rate — inventing frames for the sake of a number. The tolerance is what keeps the cap a cap:
 * below it, the source's own rate is left alone.
 */
export const PROXY_RATE_TOLERANCE = 0.5;

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

/**
 * What to ask the converter for, for the picture. Pure, so the shape is pinned in a test.
 *
 * `fit: 'contain'` rather than `fill`: the size here is the source's own aspect ratio rounded to even
 * numbers, and a copy that stretched the picture by the rounding error would be a copy nobody could
 * judge a caption's position against. `quality` is quantitative — an explicit bitrate, from
 * `proxyBitrate` — because the qualitative levels ("high", "medium") let an encoder decide what a
 * copy is worth, and this file's whole value is being cheap to decode.
 *
 * `frameRate` is **not** set here. It is the caller's to add, and only when the source is genuinely
 * faster than the ceiling: setting it on a slower source asks the converter to invent frames.
 */
export function proxyVideoOptions({ width, height, fps = DEFAULT_PROXY_FPS, bitsPerSecond = null }) {
  const { width: w, height: h } = evenSize(width, height);
  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || DEFAULT_PROXY_FPS)));
  return {
    width: w,
    height: h,
    fit: 'contain',
    quality: new Quality({ bitrate: Math.round(Number(bitsPerSecond) || proxyBitrate(w, h, rate)) }),
    keyFrameInterval: PROXY_KEYFRAME_SECONDS,
  };
}

/**
 * Why a track did not make it into the copy, as one sentence per track. Pure.
 *
 * Mediabunny drops what it cannot carry rather than failing the whole conversion, which is the right
 * behaviour and a terrible thing to hide: a copy with no sound is a bug report, and "no encodable
 * target codec" is one somebody can act on.
 */
export function describeDiscards(discardedTracks = []) {
  return (discardedTracks ?? [])
    .map((entry) => `${entry?.track?.type ?? 'a track'} was left out of the copy (${entry?.reason ?? 'unknown reason'})`)
    .join('; ');
}

/**
 * How far the copy's length is from the original's, as a sentence — or `''` when it is close enough
 * not to be worth mentioning.
 *
 * A converted copy is not a promise to the millisecond either — the last frame's own length is a
 * nominal one — so the difference is reported rather than claimed away. The threshold is one frame
 * at 30 fps plus a little: below that, nothing in a preview can be seen to be out of step.
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
 * What the copy holds, in one line — the difference between "the copy is choppy" and "the copy is a
 * file with sixty-one frames a second in it".
 *
 * The rate is measured off the copy rather than reported from the rate that was asked for, because
 * those two are not the same number and the one a person can see is this one. Pure.
 */
export function describeFrames({ frames = 0, seconds = 0 } = {}) {
  const kept = Math.max(0, Math.round(Number(frames) || 0));
  const length = Number(seconds) || 0;
  if (!kept) return '';
  const rate = length > 0 ? ` — ${(kept / length).toFixed(1)} a second` : '';
  return (
    `${kept} frame(s) in the copy${rate}; every one of them the file's own, because nothing here ` +
    'waits for a clock'
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

/** The cancellation every caller already handles: `AbortError`, not a message about a codec. */
function abortError() {
  return new DOMException('copy cancelled', 'AbortError');
}

/**
 * The picture's own frame rate, from its own timestamps, or `0` when it cannot be read.
 *
 * Mediabunny's estimate rather than a packet count: it inspects a bounded prefix (256 packets by
 * default) and reasons about the lattice the frames sit on, which is what makes it cheap enough to
 * run before a conversion and stable on a file with dropped frames. An estimate it cannot make is
 * not a reason to refuse a copy — the cap simply is not applied, and the copy keeps the source's own
 * rate, which is the safe answer.
 */
async function probeFrameRate(track) {
  try {
    const metrics = await track.computeFrameRateMetrics();
    const rate = Number(metrics?.bestGuessFrameRate ?? metrics?.averageFrameRate ?? 0);
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  } catch {
    return 0;
  }
}

/**
 * Copy the picture at `url` into a smaller WebM, for the preview to play.
 *
 * One pass, and the decoding in it is not on any clock: the frames are decoded as fast as the machine
 * can decode them and written with the timestamps they had in the source, so the copy holds the
 * picture's real motion even when the machine cannot decode it in real time. That is the whole
 * difference from the wall-clock version this replaced, and it is measured in `tools/ui-smoke.mjs`
 * (a fixture of known length played back and counted frame by frame) rather than asserted here.
 *
 * @param {object} options
 * @param {string} options.url                        the original picture (an object URL or a file URL)
 * @param {{width:number,height:number}} [options.size] the copy's size; defaults to `proxySize()`
 * @param {number} [options.fps]                      the copy's frame rate ceiling
 * @param {number} [options.bitsPerSecond]
 * @param {AbortSignal} [options.signal]
 * @param {(fraction:number, message:string)=>void} [options.onProgress]
 * @returns {Promise<{blob: Blob, mimeType: string, width: number, height: number, seconds: number,
 *   sourceSeconds: number, frames: number, averageFps: number, videoBitrate: number,
 *   audio: boolean, audioCodec: string, audioError: string, drift: string, encodeSeconds: number,
 *   codec: string, sourceCodec: string, container: string, summary: string}>}
 */
export async function buildPreviewProxy({
  url,
  size = null,
  fps = DEFAULT_PROXY_FPS,
  bitsPerSecond = null,
  signal = null,
  onProgress = null,
} = {}) {
  if (!url) throw new Error('there is no picture to copy');
  if (!proxySupported()) {
    throw new Error(
      'this browser cannot make a preview copy (it needs WebCodecs VideoEncoder and a canvas) — use Chrome or Edge',
    );
  }
  if (signal?.aborted) throw abortError();

  // The bytes, not the element: the converter reads the container itself, which is what lets it
  // decode off the clock. `fetch` on an object URL hands back the same blob the element is playing,
  // so nothing is copied into memory to do this.
  const blob = await (await fetch(url)).blob();
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  let copy = null;

  try {
    if (!(await input.canRead())) {
      throw new Error(
        'this file is in a container the converter cannot read, so no copy can be made from it ' +
          '(MP4/MOV, WebM/MKV, MPEG-TS, MP3, WAV, OGG, FLAC and AAC are the ones it knows)',
      );
    }
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('this file has no video track to copy');

    const sourceSeconds = await input.computeDuration();
    const target = size ?? proxySize(await track.getDisplayWidth(), await track.getDisplayHeight());
    if (!target) throw new Error('the picture has no usable size to copy');
    const { width, height } = evenSize(target.width, target.height);

    const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || DEFAULT_PROXY_FPS)));
    const sourceRate = await probeFrameRate(track);
    const video = proxyVideoOptions({ width, height, fps: rate, bitsPerSecond });
    if (sourceRate > rate + PROXY_RATE_TOLERANCE) video.frameRate = rate;

    if (onProgress) {
      onProgress(
        0,
        `${width}×${height}${sourceRate > rate + PROXY_RATE_TOLERANCE ? ` at ${rate}` : ''} — ` +
          'decoding the picture off the clock, so nothing is dropped to keep up',
      );
    }

    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    // `tracks: 'primary'` and not the default `'all'`: a copy is one picture, and a file with a
    // second video track (an angle, a thumbnail reel) must not turn into a second track to keep in
    // step. The sound is left unconfigured on purpose — the converter picks a codec the environment
    // can actually encode into this container, which is more than this module can promise.
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video,
      audio: {},
      showWarnings: false,
    });

    if (signal?.aborted) throw abortError();
    if (!conversion.isValid) {
      const why = describeDiscards(conversion.discardedTracks);
      throw new Error(
        `this browser cannot make a copy of this file${why ? ` — ${why}` : ' (nothing in it could be re-encoded)'}`,
      );
    }

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      void conversion.cancel();
    };
    signal?.addEventListener('abort', cancel, { once: true });

    const started = performance.now();
    conversion.onProgress = (progress) => {
      const fraction = Math.min(1, Math.max(0, Number(progress) || 0));
      onProgress?.(fraction, `copying the picture — ${Math.round(fraction * 100)}%`);
    };

    try {
      await conversion.execute();
    } catch (err) {
      // Cancellation is reported by *this* module, not by the library's own error class: the bundle
      // is minified, so a name is not something to branch on, and a flag is.
      if (cancelled || signal?.aborted) throw abortError();
      throw err;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    const encodeSeconds = (performance.now() - started) / 1000;

    const buffer = output.target.buffer;
    if (!buffer || !buffer.byteLength) {
      throw new Error('the copy came out empty — this browser may not be able to encode what this file is made of');
    }
    const written = new Blob([buffer], { type: PROXY_MIME_TYPE });

    // What the copy holds, read back out of the copy rather than assumed from the settings it was
    // asked for: the rate, the frame count and the size are the numbers the panel shows, and a
    // number that describes what was requested instead of what exists is how a broken copy looks
    // fine until somebody plays it. The file is small, so this pass costs nothing worth measuring.
    copy = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
    const copyTrack = await copy.getPrimaryVideoTrack();
    const stats = copyTrack ? await copyTrack.computePacketStats() : null;
    const frames = Math.round(Number(stats?.packetCount) || 0);
    const averageFps = Number((Number(stats?.averagePacketRate) || 0).toFixed(2));
    const videoBitrate = Math.round(Number(stats?.averageBitrate) || 0);
    const codec = copyTrack ? (await copyTrack.getCodec()) ?? '' : '';
    const sourceCodec = (await track.getCodec()) ?? '';
    const copyWidth = copyTrack ? (await copyTrack.getDisplayWidth()) || width : width;
    const copyHeight = copyTrack ? (await copyTrack.getDisplayHeight()) || height : height;
    const writtenSeconds = await copy.computeDuration().catch(() => 0);
    const seconds = writtenSeconds > 0 ? writtenSeconds : Number(sourceSeconds) || 0;

    const copyAudio = await copy.getPrimaryAudioTrack();
    const audioCodec = copyAudio ? (await copyAudio.getCodec()) ?? '' : '';
    const audio = Boolean(copyAudio);
    const sourceAudio = await input.getPrimaryAudioTrack();
    // A missing soundtrack is reported when the picture *had* one: a silent file copied silently is
    // not a failure, and saying "the copy has no sound" about it would be a false alarm.
    const audioError = audio || !sourceAudio ? '' : describeDiscards(conversion.discardedTracks);

    onProgress?.(1, 'the copy is ready');
    return {
      blob: written,
      mimeType: written.type,
      width: copyWidth,
      height: copyHeight,
      seconds,
      sourceSeconds: Number(sourceSeconds) || seconds,
      frames,
      averageFps,
      videoBitrate,
      audio,
      audioCodec,
      audioError,
      drift: describeDrift(sourceSeconds, seconds),
      encodeSeconds: Number(encodeSeconds.toFixed(2)),
      codec,
      sourceCodec,
      container: PROXY_CONTAINER,
      summary: describeFrames({ frames, seconds }),
    };
  } finally {
    copy?.dispose?.();
    input.dispose?.();
  }
}
