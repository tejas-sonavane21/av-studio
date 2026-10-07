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
 * The recorder is kept injectable (`createRendererImpl`, and the media elements are passed in) so
 * the pure parts — the file names, the caption payloads, the codec choice — can be unit-tested in
 * Node with no browser at all.
 */

import { serializeProject } from './project-file.js';
import { serializeVeedJSON } from './veed-json.js';
import { serializeSRT } from './srt.js';
import { serializeVTT } from './vtt.js';
import { createRenderer } from '../render/renderer.js';

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
 * Burn a document's captions into its video and record the result to a WebM blob.
 *
 * The composite canvas is `doc.canvas` in size — the document's own target resolution, not the
 * preview's on-screen size — so the export does not depend on the window (plan §9.8). Frames are
 * drawn on the video's own clock, which is what keeps the captions on the words they were measured
 * against.
 *
 * @param {object}  options
 * @param {object}  options.doc                     the caption document
 * @param {HTMLVideoElement} options.video          the picture to composite over
 * @param {HTMLMediaElement} [options.audio]        the master track, if the sound is separate
 * @param {number}  [options.fps=30]
 * @param {(fraction:number, message:string)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{blob: Blob, mimeType: string, seconds: number, width: number, height: number, audio: boolean}>}
 */
export async function recordDocumentToWebm({
  doc,
  video,
  audio = null,
  fps = 30,
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

  // Which element owns the sound: the master track when one is loaded, else the picture's own audio.
  const audioSource = audio && Number.isFinite(audio.duration) && audio.readyState > 0 ? audio : video;
  const saved = {
    videoMuted: video.muted,
    videoVolume: video.volume,
    audioMuted: audio?.muted,
    audioVolume: audio?.volume,
  };

  // Unmute *before* capturing, so the recorded audio track is not the muted one.
  audioSource.muted = false;
  audioSource.volume = 1;
  if (audioSource !== video) video.muted = true;

  const tracks = [...composite.captureStream(fps).getVideoTracks()];
  let hasAudio = false;
  try {
    const mediaStream = audioSource.captureStream?.() ?? audioSource.mozCaptureStream?.();
    const audioTracks = mediaStream?.getAudioTracks?.() ?? [];
    tracks.push(...audioTracks);
    hasAudio = audioTracks.length > 0;
  } catch {
    /* no audio track available — the export is video-only, which is better than failing */
  }

  const mimeType = pickVideoMime((type) => MediaRecorder.isTypeSupported?.(type) ?? false);
  const recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : {});
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
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
    try {
      video.currentTime = 0;
      if (audioSource !== video) audioSource.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
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
        cctx.clearRect(0, 0, width, height);
        try {
          cctx.drawImage(video, 0, 0, width, height);
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
  if (!blob.size) throw new Error('the recorder produced no frames — try again, or download the caption files instead');
  return {
    blob,
    mimeType: type,
    seconds: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : video.currentTime,
    width,
    height,
    audio: hasAudio,
  };
}
