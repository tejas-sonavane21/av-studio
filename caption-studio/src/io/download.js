/**
 * io/download.js — writing the finished thing out.
 *
 * Two different things are called "download" here, and they are deliberately separate:
 *
 * **The caption files.** A document can be written as itself (`.caproj`), as the Veed master JSON the
 * importer reads back, or as a plain `.srt`/`.vtt` for any other editor. This is pure text
 * serialisation and is what `captionFiles` produces — no canvas, no encoder, no waiting.
 *
 * **The video, with the captions burned in.** That is no longer recorded here. The old path played
 * the video and captured the screen with `MediaRecorder`, so a three-minute video took three minutes
 * and every dropped frame was a frame the export never had. It has been replaced by a real encoder —
 * frames rendered at the document's own resolution and handed to the browser's WebCodecs
 * `VideoEncoder`/`AudioEncoder`, muxed into an `.mp4` or `.webm` — which lives in
 * `io/webcodecs-export.js`. What stays here is the part both paths share: the file names, the caption
 * payloads, and the bitrate arithmetic.
 *
 * The bitrate is expressed as **bits per pixel per frame** rather than a flat number (see
 * `QUALITY_PRESETS`): a flat "8 Mbps" is generous for 720p and thin for 4K, whereas a fixed
 * bits-per-pixel budget means "about this much detail per pixel" at any frame size, which is what
 * "quality" actually means.
 */

import { serializeProject } from './project-file.js';
import { serializeVeedJSON } from './veed-json.js';
import { serializeSRT } from './srt.js';
import { serializeVTT } from './vtt.js';

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
 * Recording qualities, expressed as **bits per pixel per frame** rather than a flat bitrate.
 *
 * That unit is the whole point: a flat "8 Mbps" is generous for 720p and thin for 4K, whereas a
 * fixed bits-per-pixel budget means "about this much detail per pixel" at any frame size, which is
 * what "quality" actually means.
 *
 * `audio` is the bitrate for the audio codec at the same setting.
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

/** The audio bitrate for a quality preset. */
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
