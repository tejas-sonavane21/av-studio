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
