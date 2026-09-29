/**
 * tools/range.js — parse a single HTTP `Range` header.
 *
 * Its own module (rather than a function inside `serve.mjs`) purely so it can be unit-tested:
 * `serve.mjs` calls `listen()` at import time, so importing it from a test would start a server.
 *
 * Byte ranges are not optional for this project — `<video>` seeking in Chrome requires 206
 * responses with a correct `Content-Range`, so without this the preview cannot be scrubbed and the
 * visual parity harness cannot seek to a timestamp.
 *
 * Supported forms (the ones browsers actually send for media): `bytes=a-b`, `bytes=a-`, `bytes=-n`.
 * Anything else is ignored (a normal 200 response is the correct answer for an unparseable header).
 */

/**
 * @param {string|undefined} header
 * @param {number} size  total resource size in bytes
 * @returns {{start: number, end: number}|null|'invalid'}
 *   `{start,end}` → 206; `null` → serve normally (200); `'invalid'` → 416.
 */
export function parseRange(header, size) {
  if (!header) return null;
  if (!Number.isFinite(size) || size <= 0) return 'invalid';

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;

  let start;
  let end;
  if (match[1] === '') {
    // suffix form: the LAST n bytes (`bytes=-500`)
    const suffix = Number(match[2]);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/** The `Content-Range` value for a satisfiable range. */
export function contentRange({ start, end }, size) {
  return `bytes ${start}-${end}/${size}`;
}
