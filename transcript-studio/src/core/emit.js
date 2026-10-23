/**
 * core/emit.js — every file this studio writes, behind one registry.
 *
 * Two details are worth knowing before changing anything here.
 *
 * **The timestamps carry milliseconds, and the service's own download does not.**
 * The site's SRT button formats each chunk as `HH:MM:SS` after `Math.floor`ing
 * the seconds, which is where `02:23 --> 02:23` comes from and why a line can
 * look a second late. This emitter writes the reply's own numbers at
 * millisecond precision, so the file it produces is strictly more precise than
 * the one the page offers.
 *
 * **Two of these formats are a bridge, not our own format.** `speech` and `veed`
 * are audio-studio's native artifact and the Veed master caption-studio imports,
 * built by `core/transcript.js`; `audio-studio emit` can re-read the first and
 * caption-studio opens the second with no changes on its side.
 */

import { GENERATOR, roundTime, toAudioStudioTranscript, toVeedMaster } from './transcript.js';

/** `HH:MM:SS,mmm` - SubRip's separator is a comma. */
export function formatSRTTime(seconds) {
  return clock(seconds, ',');
}

/** `HH:MM:SS.mmm` - WebVTT's is a full stop. */
export function formatVTTTime(seconds) {
  return clock(seconds, '.');
}

function clock(seconds, separator) {
  const value = Math.max(0, Number(seconds) || 0);
  const total = Math.round(value * 1000);
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const secs = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${String(millis).padStart(3, '0')}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** One cue per chunk. A cue is only emitted when it has text and a real window. */
export function cuesOf(doc) {
  return (doc.chunks || [])
    .filter((chunk) => chunk.text && chunk.end > chunk.start)
    .map((chunk) => ({ start: roundTime(chunk.start), end: roundTime(chunk.end), text: chunk.text }));
}

export function renderSRT(doc) {
  const blocks = cuesOf(doc).map(
    (cue, index) => `${index + 1}\n${formatSRTTime(cue.start)} --> ${formatSRTTime(cue.end)}\n${cue.text}`,
  );
  return blocks.length ? `${blocks.join('\n\n')}\n\n` : '';
}

export function renderVTT(doc) {
  const blocks = cuesOf(doc).map(
    (cue) => `${formatVTTTime(cue.start)} --> ${formatVTTTime(cue.end)}\n${cue.text}`,
  );
  return blocks.length ? `WEBVTT\n\n${blocks.join('\n\n')}\n\n` : 'WEBVTT\n';
}

/** The words without any timing, one line per chunk - what a lyric sheet is. */
export function renderTXT(doc) {
  const lines = cuesOf(doc).map((cue) => cue.text);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function renderJSON(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function renderAudioStudio(doc) {
  return `${JSON.stringify(toAudioStudioTranscript(doc), null, 2)}\n`;
}

export function renderVeed(doc) {
  return `${JSON.stringify(toVeedMaster(doc), null, 2)}\n`;
}

/**
 * The registry. `extension` is what the file is called; `label` is what the CLI
 * and the GUI call it, because `speech` is a worse word for a user than
 * "audio-studio artifact".
 */
export const ARTIFACTS = Object.freeze({
  json: { extension: '.transcript.json', label: 'transcript JSON', render: renderJSON },
  srt: { extension: '.srt', label: 'SubRip', render: renderSRT },
  vtt: { extension: '.vtt', label: 'WebVTT', render: renderVTT },
  txt: { extension: '.txt', label: 'plain text', render: renderTXT },
  speech: { extension: '.speech.json', label: 'audio-studio artifact', render: renderAudioStudio },
  veed: { extension: '.veed.json', label: 'caption-studio master', render: renderVeed },
});

export const DEFAULT_ARTIFACTS = Object.freeze(['json', 'srt', 'vtt', 'speech', 'veed']);

export function artifactNames() {
  return Object.keys(ARTIFACTS);
}

export function normalizeArtifacts(value) {
  if (value === undefined || value === null || value === '') return [...DEFAULT_ARTIFACTS];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const names = [...new Set(list.map((name) => String(name).trim().toLowerCase()).filter(Boolean))];
  if (!names.length) return [...DEFAULT_ARTIFACTS];
  if (names.includes('all')) return artifactNames();
  const unknown = names.filter((name) => !ARTIFACTS[name]);
  if (unknown.length) {
    throw new Error(`unknown artifact ${unknown.map((name) => JSON.stringify(name)).join(', ')}; expected ${artifactNames().join(', ')}`);
  }
  return names;
}

/**
 * Windows refuses these in a name and POSIX shells dislike them. Same rule as
 * audio-studio's `safe_stem`, so a file this studio writes can be handed to that
 * one without a rename.
 */
const UNSAFE = /[^\p{L}\p{N}._\- ]+/gu;
const MAX_STEM = 80;

export function safeStem(name, fallback = 'transcript') {
  let text = String(name ?? '').replace(/\\/g, '/').split('/').pop();
  text = text.replace(UNSAFE, '_').replace(/\s+/g, ' ').trim().replace(/^[.\- ]+|[.\- ]+$/g, '');
  if (text.length > MAX_STEM) text = text.slice(0, MAX_STEM).replace(/[.\- ]+$/g, '');
  return text || fallback;
}

export function artifactFilename(kind, stem) {
  const entry = ARTIFACTS[kind];
  if (!entry) throw new Error(`unknown artifact ${JSON.stringify(kind)}`);
  return `${safeStem(stem)}${entry.extension}`;
}

/** Every requested artifact, in a stable order, as `{kind, filename, text}`. */
export function renderArtifacts(doc, kinds, stem) {
  return kinds.map((kind) => ({
    kind,
    label: ARTIFACTS[kind].label,
    filename: artifactFilename(kind, stem),
    text: ARTIFACTS[kind].render(doc),
  }));
}

export const generatedBy = GENERATOR;
