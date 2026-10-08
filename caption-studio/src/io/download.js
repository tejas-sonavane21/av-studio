/**
 * io/download.js — writing the finished thing out.
 *
 * Two different things are called "download" here, and they are deliberately separate:
 *
 * **The caption files.** A document can be written as itself (`.caproj`), as the Veed master JSON the
 * importer reads back, or as a plain `.srt`/`.vtt` for any other editor. This is pure text
 * serialisation and is what `captionFiles` produces — no canvas, no recorder, no waiting.
 *
 * **The video, with the captions burned in.** There is no server here and no ffmpeg on the path, so
 * the picture is composited in a `<canvas>` — the video frame, then the caption layer measured from
 * the same document the preview draws — and that canvas is recorded with `MediaRecorder`. The output
 * is `.webm` (what the browser records natively); an `.mp4` would need an encoder bundled in, which
 * this studio does not carry. Recording is therefore *real time*: a three-minute video takes about
 * three minutes, because the frames are captured as the video plays.
 *
 * A real-time encode has no lookahead and no second pass, so what the result looks like is decided
 * almost entirely by the bitrate it is handed. The browser's own default is conservative enough to be
 * the most visible difference between the export and the source, which is why every recording here
 * names its bitrate explicitly (see `QUALITY_PRESETS`) and why the picture is letterboxed into the
 * frame rather than stretched into it.
 *
 * The recorder is kept injectable (`createRendererImpl`, and the media elements are passed in) so
 * the pure parts — the file names, the caption payloads, the codec choice — can be unit-tested in
 * Node with no browser at all.
 */

import { serializeProject } from './project-file.js';
import { serializeVeedJSON } from './veed-json.js';
import { serializeSRT } from './srt.js';
import { serializeVTT } from './vtt.js';
import { createRenderer } from '../render/renderer.js';
import { fitRect } from '../util/math.js';

/** A file-name stem that cannot escape its folder or confuse a shell. */
function safeStem(name, fallback = 'captions') {
  const base = String(name ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\w.\- ]+/g, '_')
    .trim();
  return base || fallback;
}

/** The stem every exported file shares — the document's name, or `captions`. */
export function exportStem(doc, fallback = 'captions') {
  return safeStem(doc?.name, fallback);
}

/**
 * Every file a caption document can be written as, in one place. Pure.
 *
 * @returns {Array<{name: string, mime: string, text: string}>}
 */
export function captionFiles(doc, { stem = exportStem(doc), withWordTimings = true } = {}) {
  const blocks = doc?.blocks ?? [];
  return [
    { name: `${stem}.caproj`, mime: 'application/json', text: serializeProject(doc) },
    { name: `${stem}.veed.json`, mime: 'application/json', text: JSON.stringify(serializeVeedJSON(doc), null, 2) + '\n' },
    { name: `${stem}.srt`, mime: 'text/plain', text: serializeSRT(blocks) },
    { name: `${stem}.vtt`, mime: 'text/vtt', text: serializeVTT(blocks, { withWordTimings }) },
  ];
}

/**
 * The recording codec, picked by capability rather than assumed.
 *
 * VP9 with audio if the browser can record it, then VP8, then whatever the browser defaults to when
 * nothing is supported (an empty string means "do not pass a mimeType at all", which is safer than
 * naming one the recorder will reject).
 */
export function pickVideoMime(isSupported) {
  const test = typeof isSupported === 'function' ? isSupported : () => false;
  for (const type of [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
  ]) {
    try {
      if (test(type)) return type;
    } catch {
      /* a throw from isTypeSupported is not a reason to give up on the rest */
    }
  }
  return '';
}

/**
 * Recording qualities, expressed as **bits per pixel per frame** rather than a flat bitrate.
 *
 * That unit is the whole point: a flat "8 Mbps" is generous for 720p and thin for 4K, whereas a
 * fixed bits-per-pixel budget means "about this much detail per pixel" at any frame size, which is
 * what "quality" actually means. The numbers are high for the format on purpose — this is a
 * *real-time* VP8/VP9 encode with no lookahead or multi-pass, so it needs a bigger bitrate than a
 * file being compressed offline to look equally clean.
 *
 * `audio` is the Opus bitrate for the same setting; stereo music at 128 kbps is audibly lossy, which
 * is why the default is above it.
 */
export const QUALITY_PRESETS = Object.freeze({
  balanced: { bpp: 0.07, audio: 128000, label: 'balanced — smaller file' },
  high: { bpp: 0.13, audio: 192000, label: 'high — recommended' },
  best: { bpp: 0.24, audio: 256000, label: 'best — largest file' },
});

/** The quality used when nothing is chosen, and by every caller that does not care. */
export const DEFAULT_QUALITY = 'high';

/**
 * Reasonable ends of the range. The floor is deliberately low: it exists to stop a mis-typed setting
 * producing an unwatchable file, not to flatten the quality presets into each other on small frames
 * (a 640×360 export at 400 kbps is perfectly sensible, and clamping it up to 1 Mbps would make
 * "balanced" and "best" produce the same file).
 */
export const MIN_VIDEO_BITRATE = 250000;
export const MAX_VIDEO_BITRATE = 50000000;

/**
 * The video bitrate for a frame size and rate, from a quality preset. Pure and clamped.
 *
 * An unknown preset falls back to the default rather than to zero: a mis-typed setting must not be
 * able to produce a 1 kbps export, and a caller with no opinion must not either.
 */
export function videoBitrate({ width, height, fps = 30, quality = DEFAULT_QUALITY } = {}) {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const rate = Math.min(60, Math.max(1, Number(fps) || 30));
  const bits = w * h * rate * preset.bpp;
  return Math.round(Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, bits)));
}

/** The Opus bitrate for a quality preset. */
export function audioBitrate(quality = DEFAULT_QUALITY) {
  return (QUALITY_PRESETS[quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY]).audio;
}

/** Save a value as a file the user's browser downloads. */
export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke late: revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Save text as a file. */
export function downloadText(name, text, mime = 'text/plain') {
  downloadBlob(name, new Blob([text], { type: mime }));
}

/**
 * A seek to the start, resolving as soon as it lands — or `false` after half a second, so a
 * container that cannot seek at all degrades to the caller's fallback instead of hanging.
 */
function seekToStart(element) {
  return new Promise((resolve) => {
    if (!element || typeof element.currentTime !== 'number') {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (moved) => {
      if (settled) return;
      settled = true;
      element.removeEventListener?.('seeked', onSeeked);
      resolve(moved);
    };
    const onSeeked = () => finish(true);
    element.addEventListener?.('seeked', onSeeked, { once: true });
    try {
      element.currentTime = 0;
    } catch {
      finish(false);
      return;
    }
    setTimeout(() => finish(false), 500);
  });
}

/**
 * Put a media element back at its start, resolving once it is really there.
 *
 * A bare `currentTime = 0` is not enough to rely on. A webm written by `MediaRecorder` carries no
 * seek index, so the element can go on reporting the *end* of the file — and a recording loop that
 * trusts `currentTime` then stops on its very first tick and produces an empty blob, which is
 * exactly what a second export of the same video used to do. The spec's own rewind for an ended
 * element is `play()`: it seeks to the start as part of restarting. That is the fallback here, and
 * either route is confirmed by watching the element's own clock rather than assumed.
 *
 * @returns {Promise<boolean>} whether the element is now somewhere other than the end
 */
async function rewind(element) {
  if (!element || typeof element.currentTime !== 'number') return false;
  if (element.currentTime < 1e-3 && !element.ended) return true;
  if (await seekToStart(element)) return true;
  try {
    await element.play();
  } catch {
    return false;
  }
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (!element.ended && element.currentTime < element.duration - 1e-3) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Burn a document's captions into its video and record the result to a WebM blob.
 *
 * The composite canvas is `doc.canvas` in size — the document's own target resolution, not the
 * preview's on-screen size — so the export does not depend on the window (plan §9.8). Frames are
 * drawn on the video's own clock, which is what keeps the captions on the words they were measured
 * against.
 *
 * The bitrate is set explicitly from a quality preset. Left to itself the browser picks a
 * conservative default that is genuinely soft at 1080p, which is the single biggest difference
 * between what this export looks like and what the source did.
 *
 * @param {object}  options
 * @param {object}  options.doc                     the caption document
 * @param {HTMLVideoElement} options.video          the picture to composite over
 * @param {HTMLMediaElement} [options.audio]        the master track, if the sound is separate
 * @param {number}  [options.fps=30]
 * @param {string}  [options.quality='high']        a `QUALITY_PRESETS` key
 * @param {(fraction:number, message:string)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{blob: Blob, mimeType: string, seconds: number, width: number, height: number, audio: boolean, audioSkipped: string|null, fps: number, videoBitsPerSecond: number, quality: string}>}
 */
export async function recordDocumentToWebm({
  doc,
  video,
  audio = null,
  fps = 30,
  quality = DEFAULT_QUALITY,
  onProgress = null,
  signal = null,
  createRendererImpl = createRenderer,
} = {}) {
  if (!doc?.blocks?.length) {
    throw new Error('there are no captions to burn in — load a source or open the demo first');
  }
  // A loaded picture, by either signal: a decodable frame (videoWidth) or a finite duration. Not
  // *both*, because a WebM written by MediaRecorder commonly reports `duration === Infinity` until it
  // is fully buffered, and refusing to export that file would be wrong — its frames play fine.
  if (!video || !(video.videoWidth > 0 || (Number.isFinite(video.duration) && video.duration > 0))) {
    throw new Error(
      'burning the captions into a video needs a loaded video — add one under Sources, or download the caption files instead',
    );
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('this browser has no MediaRecorder, so it cannot record a video — download the caption files instead');
  }

  const width = Math.max(1, Math.round(doc.canvas?.width || video.videoWidth || 1280));
  const height = Math.max(1, Math.round(doc.canvas?.height || video.videoHeight || 720));
  const rate = Math.min(60, Math.max(1, Math.round(Number(fps) || 30)));
  const videoBitsPerSecond = videoBitrate({ width, height, fps: rate, quality });
  // Where the picture goes inside the frame. Equal shapes give exactly the frame back, so the
  // default flow is untouched; a 16:9 clip in a 9:16 project is letterboxed instead of squeezed.
  const frame = fitRect(
    { width: video.videoWidth || width, height: video.videoHeight || height },
    { width, height },
  );

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

  const saved = {
    videoMuted: video.muted,
    videoVolume: video.volume,
    audioMuted: audio?.muted,
    audioVolume: audio?.volume,
  };

  // Rewind *before* capturing. A second export starts with the elements parked at the end of the
  // file, and `captureStream()` on an element that has already played out hands back a finished
  // stream — a recorder fed one of those produces nothing at all, whatever the video is doing. Being
  // rewound first is also the only way the sound can be in sync from frame one, since playback below
  // starts both elements at zero.
  const rewoundVideo = await rewind(video);
  if (!rewoundVideo && video.ended) {
    // Better a clear failure than an empty .webm: nothing playable is going to come out of this, and
    // it only ever happens for a second export of a file that cannot be replayed at all.
    throw new Error(
      'this video could not be rewound for a second export — reload it under Sources and try again',
    );
  }

  // Which element owns the sound: the master track when one is loaded *and can still take part*, else
  // the picture's own audio.
  //
  // "Can still take part" is the part that matters, and it is not visible in the element's own state.
  // Once an element has been played (or seeked) to the end of its media, Chrome hands
  // `captureStream()` a track whose capture destination is *already finished*: the element looks
  // perfectly playable — a rewind really does put it back at 0.00 with `ended === false` — but the
  // track dies immediately, and a recorder fed it produces **nothing at all**, an empty file. Reloading
  // the source is what revives it, which is exactly what re-selecting the file does, so the take goes
  // ahead without the sound and says so (`audioSkipped`) rather than failing.
  const wantedAudio = Boolean(audio) && Number.isFinite(audio.duration) && audio.readyState > 0;
  const audioSpent = wantedAudio && (audio.ended || audio.currentTime >= audio.duration - 1e-3);
  if (wantedAudio && !audioSpent) await rewind(audio);
  const audioSource = wantedAudio && !audioSpent ? audio : video;

  // Unmute *before* capturing, so the recorded audio track is not the muted one.
  audioSource.muted = false;
  audioSource.volume = 1;
  if (audioSource !== video) video.muted = true;

  const tracks = [...composite.captureStream(rate).getVideoTracks()];
  let hasAudio = false;
  try {
    const mediaStream = audioSource.captureStream?.() ?? audioSource.mozCaptureStream?.();
    // **Only a live track is recorded.** An element that has already played out goes on handing out a
    // *finished* track however carefully it has since been rewound, and a recorder given one produces
    // nothing at all — an empty file, which is the one outcome an export must never have. Leaving the
    // dead track out costs the sound of one take and says so (`audioSkipped`, below).
    const audioTracks = (mediaStream?.getAudioTracks?.() ?? []).filter((track) => track.readyState !== 'ended');
    tracks.push(...audioTracks);
    hasAudio = audioTracks.length > 0;
  } catch {
    /* no audio track available — the export is video-only, which is better than failing */
  }
  const audioSkipped =
    wantedAudio && !hasAudio
      ? 'the imported audio track had already played out, so this take is silent — re-select it to record its sound again'
      : null;

  const mimeType = pickVideoMime((type) => MediaRecorder.isTypeSupported?.(type) ?? false);
  const recorder = new MediaRecorder(new MediaStream(tracks), {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond,
    audioBitsPerSecond: audioBitrate(quality),
  });
  const chunks = [];
  let drawn = 0;
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  // A recorder that refuses the stream says so on this event; without listening, the failure surfaces
  // only as "no frames", which is true but tells the reader nothing.
  let recorderProblem = null;
  recorder.addEventListener('error', (event) => {
    recorderProblem = event?.error?.name ?? event?.error?.message ?? 'recording failed';
  });
  const stopped = new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
  });

  const restore = (pause) => {
    if (pause) {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      if (audioSource !== video) {
        try {
          audioSource.pause();
        } catch {
          /* ignore */
        }
      }
    }
    video.muted = saved.videoMuted;
    video.volume = saved.videoVolume;
    if (audio) {
      audio.muted = saved.audioMuted;
      audio.volume = saved.audioVolume;
    }
  };

  try {
    recorder.start(250);
    await video.play();
    if (audioSource !== video) {
      await audioSource.play().catch(() => {});
    }

    // When the container does not report a duration, the document itself is the clock: the last
    // caption's end is how long the finished thing is. `video.ended` remains the real stop signal.
    const docEnd = (doc.blocks ?? []).reduce((m, b) => Math.max(m, Number.isFinite(b.end) ? b.end : 0), 0);
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : docEnd;
    let raf = 0;
    let finished = false;
    await new Promise((resolve) => {
      const tick = () => {
        if (signal?.aborted) {
          finished = true;
          resolve();
          return;
        }
        const t = video.currentTime;
        drawn += 1;
        cctx.clearRect(0, 0, width, height);
        try {
          cctx.drawImage(video, frame.x, frame.y, frame.width, frame.height);
        } catch {
          /* a frame not yet decoded — the next one will draw */
        }
        try {
          renderer.draw(doc, t, {});
          cctx.drawImage(captionCanvas, 0, 0, width, height);
        } catch {
          /* drawing must never abort the recording */
        }
        onProgress?.(
          duration > 0 ? Math.min(1, t / duration) : 0,
          `recording ${t.toFixed(1)}s / ${duration.toFixed(1)}s`,
        );
        if (video.ended || (duration > 0 && t >= duration - 1e-3)) {
          finished = true;
          resolve();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    cancelAnimationFrame(raf);
    if (!finished) {
      /* unreachable, but keeps the intent explicit */
    }
  } finally {
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* ignore */
    }
    await stopped;
    restore(true);
  }

  const type = mimeType || 'video/webm';
  const blob = new Blob(chunks, { type });
  if (!blob.size || recorderProblem) {
    // Say what the stream actually looked like: "no frames" on its own is true and useless.
    const stream = tracks.map((track) => `${track.kind}:${track.readyState}`).join(',') || 'none';
    const detail = `stream ${stream}, audio ${hasAudio ? 'on' : 'off'}, ${drawn} composited frames, ${mimeType || 'default codec'}`;
    throw new Error(
      recorderProblem
        ? `the recorder refused this stream (${recorderProblem}) — ${detail}`
        : `the recorder produced no frames — ${detail}`,
    );
  }
  return {
    blob,
    mimeType: type,
    seconds: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : video.currentTime,
    width,
    height,
    audio: hasAudio,
    audioSkipped,
    fps: rate,
    videoBitsPerSecond,
    quality,
  };
}
