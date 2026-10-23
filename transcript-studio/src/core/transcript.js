/**
 * core/transcript.js — the service's chunks as a transcript this suite can use.
 *
 * The service reports **line-level** chunks, not words. That is the one fact the
 * rest of this module is shaped by: a chunk's window is real, its words are not
 * measured, and any per-word timing here is an interpolation inside a window the
 * service did give us.
 *
 * So the native document says exactly that - `provider` says where the text came
 * from, `chunks` carries the measured windows, and the audio-studio adapter marks
 * its word stream `interpolated: true` instead of passing it off as measured.
 * `audio-studio` exists to remove timings that are confidently wrong; a bridge
 * that invented millisecond word onsets and hid the fact would be the same bug
 * wearing a different hat.
 *
 * The other job here is the zero-length chunk. The service does emit them (a
 * one-line cue that started and ended in the same second appears in its own SRT
 * download as `02:23 --> 02:23`). A subtitle cue with no duration is invisible in
 * every player, so it is widened to the smallest window a cue can have, and the
 * repair is counted and reported.
 */

import { MIN_CUE_SECONDS, wordsOf } from './contract.js';

export const SCHEMA_VERSION = 1;
export const VERSION = '0.1.0';
export const GENERATOR = `transcript-studio/${VERSION}`;

/** Timings are stored at millisecond precision, the same as audio-studio's. */
export const TIME_PRECISION = 3;

/** The shortest word interpolation is allowed to produce, matching audio-studio. */
export const MIN_WORD_SECONDS = 0.02;

export function roundTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

/**
 * Sort, clamp and repair the chunks into a timeline.
 *
 * Returns the chunks plus the repairs that were needed. Clamping to `duration`
 * is only done when the duration is known (the page probes it before upload),
 * because a clip's last chunk routinely reaches a few milliseconds past the
 * decoded length and trimming a measured value to an approximate one is not an
 * improvement.
 */
export function repairChunks(chunks, { duration = 0 } = {}) {
  const warnings = [];
  const ordered = [...chunks].sort((left, right) => left.start - right.start || left.end - right.end);
  const known = Number.isFinite(duration) && duration > 0 ? roundTime(duration) : 0;

  let widened = 0;
  let clamped = 0;
  const out = ordered.map((chunk, index) => {
    const next = ordered[index + 1];
    const ceiling = known || Infinity;
    let start = Math.max(0, roundTime(chunk.start));
    let end = Math.max(start, roundTime(chunk.end));

    if (end - start < MIN_CUE_SECONDS) {
      // The smallest window that is still a cue - never a made-up read time, and
      // never past the next line, which starts where it starts.
      const target = Math.min(next ? next.start : Infinity, start + MIN_CUE_SECONDS, ceiling);
      if (target > start) {
        end = roundTime(target);
        widened += 1;
      }
    }

    if (end > ceiling) {
      end = ceiling;
      clamped += 1;
    }
    if (end < start) end = start;
    return { start, end, text: chunk.text };
  });

  if (widened) {
    warnings.push(
      `widened ${widened} zero-length chunk(s) to ${MIN_CUE_SECONDS}s; the service reported a cue that started and ended together`,
    );
  }
  if (clamped) {
    warnings.push(`clamped ${clamped} chunk(s) that ran past the recording's own duration`);
  }
  return { chunks: out, warnings };
}

/**
 * The whole native document.
 *
 * `text` is rebuilt from the chunks rather than trusted from the reply's own
 * `text` field: the reply prefixes each line with a music note, and concatenating
 * the raw field is how those notes end up in the middle of a lyric sheet.
 */
export function buildTranscript({ chunks, duration, source = {}, provider = {}, warnings = [], fetchedAt = new Date().toISOString() }) {
  const repaired = repairChunks(chunks, { duration });
  const clean = repaired.chunks;

  const words = clean.reduce((count, chunk) => count + wordsOf(chunk.text).length, 0);
  const speechDuration = roundTime(clean.reduce((total, chunk) => total + (chunk.end - chunk.start), 0));
  const known = roundTime(duration || 0);
  const allWarnings = [...warnings, ...repaired.warnings];

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: GENERATOR,
    provider: {
      name: 'aifreeforever',
      endpoint: `${provider.origin ?? 'https://aifreeforever.com'}${provider.apiPath ?? '/api/transcribe-audio'}`,
      page: provider.page ?? 'https://aifreeforever.com/transcribe-audio-to-text',
      language: provider.language ?? 'auto',
      predictionId: provider.predictionId ?? null,
      // The service does not say which model ran; saying so is more useful than a guess.
      model: null,
    },
    source: { ...source, duration: known },
    duration: known || (clean.length ? roundTime(clean[clean.length - 1].end) : 0),
    text: clean.map((chunk) => chunk.text).join(' '),
    chunks: clean.map((chunk, index) => ({ index: index + 1, start: chunk.start, end: chunk.end, text: chunk.text })),
    stats: {
      chunks: clean.length,
      words,
      speechDuration,
      speechRatio: known > 0 ? Math.round((speechDuration / known) * 10000) / 10000 : 0,
    },
    warnings: allWarnings,
    fetchedAt,
  };
}

/**
 * Split one chunk's words, spreading its measured window across them by length.
 *
 * Character length is a crude proxy for how long a word takes to sing, which is
 * the same proxy audio-studio's offline `fake` aligner uses - and the same
 * caveat applies: it is a layout inside a measured line, not a measurement of a
 * word. A word is never given less than a millisecond, and the last word ends
 * exactly on the chunk's end, so the words always tile the window.
 */
export function apportionWords(chunk) {
  const tokens = wordsOf(chunk.text);
  if (!tokens.length) return [];

  const start = chunk.start;
  const end = Math.max(chunk.end, start);
  const span = end - start;
  const total = tokens.reduce((count, token) => count + token.length, 0) || tokens.length;
  const words = [];

  let consumed = 0;
  let cursor = start;
  tokens.forEach((text, index) => {
    consumed += text.length;
    const last = index === tokens.length - 1;
    // Round to the millisecond first, then keep the word non-empty: rounding a
    // 4 ms slice of a one-second line is exactly where a zero-length word appears.
    let wordEnd = last ? end : roundTime(start + (span * consumed) / total);
    if (wordEnd <= cursor) wordEnd = roundTime(Math.min(end, cursor + Math.min(MIN_WORD_SECONDS, span / tokens.length || 0.001)));
    if (wordEnd > end) wordEnd = end;
    if (wordEnd < cursor) wordEnd = cursor;
    words.push({ text, start: roundTime(cursor), end: roundTime(wordEnd) });
    cursor = wordEnd;
  });

  return words;
}

/**
 * The same transcript in audio-studio's native `*.speech.json` shape.
 *
 * Deliberately marked: `alignment.aligner = 'proportional'` and
 * `alignment.interpolated = true`, with a note saying the hosted service reports
 * lines and these word windows were spread inside them. `audio-studio emit` and
 * `caption-studio` both read this file; neither should have to guess how good the
 * word timings are.
 */
export function toAudioStudioTranscript(doc) {
  const segments = doc.chunks
    .map((chunk) => {
      const words = apportionWords(chunk);
      if (!words.length) return null;
      return {
        start: chunk.start,
        end: chunk.end,
        text: words.map((word) => word.text).join(' '),
        words: words.map((word, index) => ({
          text: word.text,
          start: word.start,
          end: word.end,
          id: `w-${String(chunk.index).padStart(4, '0')}-${String(index + 1).padStart(3, '0')}`,
        })),
      };
    })
    .filter(Boolean);

  return {
    schemaVersion: 1,
    generator: GENERATOR,
    language: doc.provider.language === 'auto' ? 'en' : doc.provider.language,
    duration: doc.duration,
    source: { ...doc.source },
    engine: {
      name: doc.provider.name,
      endpoint: doc.provider.endpoint,
      model: doc.provider.model,
      predictionId: doc.provider.predictionId,
      language: doc.provider.language,
    },
    alignment: {
      aligner: 'proportional',
      interpolated: true,
      note: 'the hosted service reports line-level chunks; word windows are spread inside each measured line by character length',
    },
    validation: null,
    reference: null,
    stats: {
      segments: segments.length,
      words: segments.reduce((count, segment) => count + segment.words.length, 0),
      speechDuration: roundTime(segments.reduce((total, segment) => total + (segment.end - segment.start), 0)),
      speechRatio: 0,
    },
    segments,
    gaps: [],
    corrections: [],
    warnings: [...doc.warnings],
    meta: {
      provider: { ...doc.provider },
      fetchedAt: doc.fetchedAt,
      audioStudioAdapter: 'line-level chunks with interpolated word windows',
    },
  };
}

/**
 * The Veed-shaped master `caption-studio` imports.
 *
 * Same shape audio-studio's own emitter writes (`canvas` present → Veed v3,
 * `subtitles[].words[].{text,s,e}` read as the AI word stream), so the existing
 * importer needs no changes. `audioStudio` is this suite's audit namespace and is
 * ignored by the importer.
 */
export function toVeedMaster(doc, { projectId = 'transcript-studio', canvas = [1280, 720] } = {}) {
  const transcript = toAudioStudioTranscript(doc);
  return {
    version: '3.0',
    generator: GENERATOR,
    engine: transcript.engine,
    projectId,
    canvas: { width: canvas[0], height: canvas[1] },
    style: { font: 'Inter', fontSize: 0.036, posX: 0.772, posY: 0.848, align: 'center' },
    subtitles: transcript.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      words: segment.words.map((word) => ({ text: word.text, s: word.start, e: word.end })),
      styles: [],
    })),
    audioStudio: {
      alignment: transcript.alignment,
      warnings: transcript.warnings,
      source: transcript.source,
      language: transcript.language,
      duration: transcript.duration,
      provider: { ...doc.provider },
    },
  };
}
