/**
 * util/math.js — small pure helpers shared across modules.
 * No dependencies; safe to import from Node tests and the browser.
 */

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const lerp = (a, b, t) => a + (b - a) * t;

export const approxEqual = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** True for `{}`-like values (not arrays, not null). */
export function isPlainObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Deep-merge plain objects. Later sources win.
 * `null` and `undefined` mean "inherit" — they never overwrite (matches the document model:
 * per-block overrides are sparse patches and `null` = inherit).
 */
export function mergeDeep(...sources) {
  const out = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined) continue;
      if (isPlainObject(v)) {
        out[k] = mergeDeep(isPlainObject(out[k]) ? out[k] : {}, v);
      } else {
        out[k] = v; // arrays and scalars replace
      }
    }
  }
  return out;
}

/**
 * The largest rectangle with `src`'s shape that fits inside `dst`, centred on it.
 *
 * `mode: 'contain'` fits the whole thing (letterboxing); `'cover'` fills the box instead and lets
 * the overflow hang outside it. Both callers here mean contain — the full-screen preview box and the
 * video layer inside a frame of a different ratio — but `cover` is the other half of the same
 * question and costs one branch.
 *
 * Returns a zero-safe full-size rect when either shape is degenerate, so a caller can never divide
 * by zero or draw a NaN.
 */
export function fitRect(src, dst, { mode = 'contain' } = {}) {
  const sw = Math.max(0, Number(src?.width) || 0);
  const sh = Math.max(0, Number(src?.height) || 0);
  const dw = Math.max(0, Number(dst?.width) || 0);
  const dh = Math.max(0, Number(dst?.height) || 0);
  if (!(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return { x: 0, y: 0, width: dw, height: dh };
  const scale = mode === 'cover' ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { x: (dw - width) / 2, y: (dh - height) / 2, width, height };
}

/** Stable JSON stringify (sorted keys) — used to hash/compare config objects deterministically. */
export function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (isPlainObject(value)) {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value ?? null);
}

/** Clamp a list of numbers to be monotonically non-decreasing. */
export function enforceMonotonic(values, minStep = 0) {
  const out = values.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i] < out[i - 1] + minStep) out[i] = out[i - 1] + minStep;
  }
  return out;
}
