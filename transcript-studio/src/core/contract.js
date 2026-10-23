/**
 * core/contract.js — the page's rules, in one place.
 *
 * Everything here was read off the real tool rather than guessed:
 *
 *   * `AudioTranscribeInterface` accepts `.mp3`, `.wav`, `.flac` only, refuses
 *     anything over 25 MB and anything not between 1 s and 300 s long, and
 *     says so in the page's own words - those strings are copied below so this
 *     client can fail with the same message before spending a minute of queue;
 *   * the request is `multipart/form-data` with exactly two fields, `audio`
 *     (the file) and `language` (a code from the page's own select, `auto` by
 *     default), posted to `/api/transcribe-audio`;
 *   * the reply is `{success, chunks: [{text, timestamp: [start, end]}], text,
 *     predictionId}` with timings in **seconds**.
 *
 * The reply is not clean. Its chunks arrive prefixed with the music-note emoji
 * (the service decorates sung lines), it can contain a chunk whose text is only
 * that emoji, and it occasionally reports a chunk that starts and ends at the
 * same instant. `parseResponse` normalises all three, and records what it had
 * to do, because a transcript that silently loses a line is worse than one that
 * says which line it dropped.
 */

export const SERVICE = Object.freeze({
  name: 'aifreeforever',
  origin: 'https://aifreeforever.com',
  pageUrl: 'https://aifreeforever.com/transcribe-audio-to-text',
  apiPath: '/api/transcribe-audio',
  /** The header the page sends: a Cloudflare Turnstile token, obtained by the page itself. */
  tokenHeader: 'x-turnstile-token',
});

/** The page's own limits, verbatim from `AudioTranscribeInterface`. */
export const LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  minSeconds: 1,
  maxSeconds: 300,
  extensions: Object.freeze(['.mp3', '.wav', '.flac']),
  mimeTypes: Object.freeze(['audio/mpeg', 'audio/wav', 'audio/flac']),
});

/** The language codes the page offers. `auto` is the default there and here. */
export const LANGUAGES = Object.freeze([
  ['auto', 'Auto Detect'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['tr', 'Turkish'],
  ['pl', 'Polish'],
  ['nl', 'Dutch'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
  ['fi', 'Finnish'],
]);

/** Below this a cue is not a cue: the file would carry `00:12,000 --> 00:12,000`. */
export const MIN_CUE_SECONDS = 0.04;

export class ContractError extends Error {
  constructor(message, { hint = '', code = 'contract' } = {}) {
    super(message);
    this.name = 'ContractError';
    this.hint = hint;
    this.code = code;
  }

  toString() {
    return this.hint ? `${this.message} - ${this.hint}` : this.message;
  }
}

/** The extension of a name, lowercased. `''` when there is none. */
export function extensionOf(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  return dot === -1 ? '' : text.slice(dot).toLowerCase();
}

/**
 * Refuse a file this service cannot take, before uploading it.
 *
 * `size` may be `undefined` when the caller only has a name (the browser flow
 * reads the size off the file object and the CLI off the stat); a missing size
 * is not a reason to pretend the file is fine, so the caller passes it.
 */
export function checkFile({ name, size } = {}) {
  if (!name) throw new ContractError('no audio file was given', { code: 'no-file' });
  const extension = extensionOf(name);
  if (!LIMITS.extensions.includes(extension)) {
    throw new ContractError(
      `"${name}" is not an MP3, WAV or FLAC file`,
      { hint: 'the free transcriber accepts .mp3, .wav and .flac only', code: 'extension' },
    );
  }
  if (size === undefined || size === null) {
    throw new ContractError(`could not read the size of "${name}"`, { code: 'size' });
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new ContractError(`"${name}" is empty`, { code: 'size' });
  }
  if (size > LIMITS.maxBytes) {
    const mb = (size / (1024 * 1024)).toFixed(2);
    throw new ContractError(
      `"${name}" is ${mb} MB; the service accepts at most 25 MB`,
      { hint: 'compress it or cut a shorter clip', code: 'size' },
    );
  }
  return { extension, size };
}

/** Refuse a duration the page would refuse, in the page's own wording. */
export function checkDuration(seconds, { name = 'the audio' } = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ContractError(
      `could not read the duration of ${name}`,
      { hint: 'is it a valid MP3, WAV or FLAC file?', code: 'duration' },
    );
  }
  if (seconds < LIMITS.minSeconds) {
    throw new ContractError(
      `${name} is shorter than 1 second`,
      { hint: 'the service needs at least one second of audio', code: 'duration' },
    );
  }
  if (seconds > LIMITS.maxSeconds) {
    throw new ContractError(
      `${name} is ${Math.round(seconds)} s; the service accepts at most ${LIMITS.maxSeconds / 60} minutes`,
      { hint: 'cut a shorter clip; the free tool is a 5-minute tool', code: 'duration' },
    );
  }
  return seconds;
}

/** A language code the service knows, or a refusal naming the valid ones. */
export function checkLanguage(code) {
  const value = String(code ?? '').trim().toLowerCase() || 'auto';
  if (!LANGUAGES.some(([allowed]) => allowed === value)) {
    throw new ContractError(
      `unknown language ${JSON.stringify(code)}`,
      { hint: `expected one of: ${LANGUAGES.map(([allowed]) => allowed).join(', ')}`, code: 'language' },
    );
  }
  return value;
}

/**
 * The music-note decorations, and friends.
 *
 * `Extended_Pictographic` covers the note, the sparkles and the rest without a
 * hand-maintained list; the variation selector and the zero-width joiner are
 * what turn a sequence of pictographs into one glyph, so they go with them.
 */
const DECORATION = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]+/gu;

/** Strip the service's decorations and collapse whitespace. Never returns `null`. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(DECORATION, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/**
 * Turn the service's JSON into chunks this suite can trust.
 *
 * Faithful where it can be: the text is cleaned, never reworded. The only
 * repairs are structural - a chunk with no words left after cleaning is
 * dropped (counted), timings that are not finite numbers are dropped
 * (counted), and chunks are sorted by start because the service does not
 * promise an order. The zero-length repair happens later, in `transcript.js`,
 * where the whole timeline is available.
 */
export function parseResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ContractError('the service returned something that is not JSON', { code: 'response' });
  }
  if (payload.success === false) {
    throw new ContractError(payload.error || 'the service refused the request', { code: 'service' });
  }
  if (!Array.isArray(payload.chunks)) {
    throw new ContractError(
      'the service returned no chunks',
      { hint: `keys: ${Object.keys(payload).join(', ') || '(none)'}`, code: 'response' },
    );
  }

  const warnings = [];
  const chunks = [];
  let droppedEmpty = 0;
  let droppedTiming = 0;

  for (const raw of payload.chunks) {
    const text = cleanText(raw?.text);
    const [start, end] = Array.isArray(raw?.timestamp) ? raw.timestamp : [];
    const a = Number(start);
    const b = Number(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
      droppedTiming += 1;
      continue;
    }
    if (!text) {
      droppedEmpty += 1;
      continue;
    }
    chunks.push({
      start: Math.min(a, b),
      end: Math.max(a, b),
      text,
    });
  }

  if (droppedEmpty) {
    warnings.push(`dropped ${droppedEmpty} chunk(s) that carried only the service's decorations`);
  }
  if (droppedTiming) {
    warnings.push(`dropped ${droppedTiming} chunk(s) with no usable timestamp`);
  }
  if (!chunks.length) {
    throw new ContractError(
      'the service returned no usable chunks',
      { hint: 'the file may be silent, or the tool may have changed its reply shape', code: 'empty' },
    );
  }

  const sorted = chunks.every((chunk, index) => index === 0 || chunk.start >= chunks[index - 1].start);
  if (!sorted) {
    chunks.sort((left, right) => left.start - right.start);
    warnings.push('chunks arrived out of order; they were sorted by start');
  }

  const text = cleanText(chunks.map((chunk) => chunk.text).join(' '));
  return {
    chunks,
    text,
    predictionId: payload.predictionId ? String(payload.predictionId) : null,
    warnings,
  };
}

/** Every word of a cleaned chunk line, punctuation kept on the word it belongs to. */
export function wordsOf(text) {
  return String(text ?? '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}
