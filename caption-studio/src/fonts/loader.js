/**
 * fonts/loader.js — get a font family onto the page, or give up quickly and say so.
 *
 * Three sources, tried in order:
 *
 *   1. **packaged** — a woff2 in `fonts/packaged/` (see `registry.js` for the exact filenames).
 *      Fully offline; this is the parity path. We ship no binaries yet, so this usually misses.
 *   2. **Google Fonts** (opt-in, `allowNetwork`) — exactly what the v10 replica did
 *      (`Inter:ital,wght@0,900;1,900`), so enabling it reproduces v10's rendering and is on by
 *      default in the preview.
 *   3. **system** — whatever the OS already has under that family name.
 *
 * ## Two rules this module exists to enforce
 *
 * - **Never hang.** A fonts CDN that stalls must not freeze the app. Every attempt races a timeout
 *   (plan §11.3), so a failed load costs a bounded delay, never a stuck promise.
 * - **Never lie.** `document.fonts.load(spec)` resolves successfully even when *no matching face
 *   exists* (it returns an empty array), so it is not evidence that a font loaded. We verify with
 *   `document.fonts.check(spec)` and report `ok: false` when the family is genuinely unavailable —
 *   which is what lets the UI say "using a fallback face" instead of silently measuring with
 *   Arial and producing a different layout.
 *
 * The renderer never measures before `ensureFonts()` resolves (plan §11.3): measuring with a
 * fallback and then swapping the face is exactly the "the font doesn't match" class of bug.
 */

import { familyStack, getFont } from './registry.js';

const PACKAGED_DIR = new URL('./packaged/', import.meta.url).href;

/** `ok` results, keyed by font-spec. */
const resolved = new Map();
const injectedLinks = new Map();

export const DEFAULT_TIMEOUT_MS = 4000;

/** `'italic 900 100px Inter'` — a valid CSS `font` shorthand for the Font Loading API. */
export function fontSpec(family, weight = 900, italic = false) {
  return `${italic ? 'italic ' : ''}${weight} 100px ${familyStack(family)}`;
}

/** Google Fonts CSS2 URL for a family, or null when the family has no Google source. */
export function googleCssUrl(family, { weight = 900, italic = false } = {}) {
  const entry = getFont(family);
  if (!entry?.googleQuery) return null;
  // `googleQuery` carries the full axis list; ask for the whole family once and cache the link.
  return `https://fonts.googleapis.com/css2?family=${entry.googleQuery}&display=swap`;
}

/** Which weights/italics a family can serve. Used to pick a sensible axis pair for the link. */
export function packagedUrl(family, weight, italic = false) {
  const entry = getFont(family);
  const file = entry?.packaged?.[weight];
  if (!file) return null;
  if (italic) return null; // separate italic filenames are not shipped yet
  return `${PACKAGED_DIR}${file}`;
}

const withTimeout = (promise, ms) =>
  Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);

/**
 * Load one family/weight/italic combination.
 *
 * @returns {Promise<{ok: boolean, via?: 'packaged'|'google'|'system'|'cached', reason?: string}>}
 *          Never rejects.
 */
export async function ensureFont(family, options = {}) {
  const { weight = 900, italic = false, allowNetwork = true, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const key = `${family}|${weight}|${italic ? 'i' : 'n'}`;

  const cached = resolved.get(key);
  if (cached) return { ...cached, via: 'cached' };

  if (typeof document === 'undefined' || !document.fonts) {
    return finish(key, { ok: false, reason: 'no-font-loading-api' });
  }

  const spec = fontSpec(family, weight, italic);

  // 1. packaged woff2
  const url = packagedUrl(family, weight, italic);
  if (url) {
    const ok = await withTimeout(loadFromUrl(family, weight, italic, url), timeoutMs);
    if (ok && isAvailable(spec)) return finish(key, { ok: true, via: 'packaged' });
  }

  // 2. Google Fonts (opt-in)
  if (allowNetwork) {
    const cssUrl = googleCssUrl(family, { weight, italic });
    if (cssUrl) {
      const ok = await withTimeout(loadStylesheet(cssUrl).then(() => load(spec)), timeoutMs);
      if (ok && isAvailable(spec)) return finish(key, { ok: true, via: 'google' });
    }
  }

  // 3. an installed system face under the same name
  const systemOk = await withTimeout(load(spec), Math.min(timeoutMs, 1000));
  if (systemOk && isAvailable(spec)) return finish(key, { ok: true, via: 'system' });

  return finish(key, {
    ok: false,
    reason: allowNetwork ? 'unavailable' : 'offline-and-not-installed',
  });
}

/**
 * `document.fonts.check()` is the only reliable "is this family actually usable" test.
 * It returns true when *any* face (webfont or installed) satisfies the spec.
 */
export function isAvailable(spec) {
  try {
    return document.fonts.check(spec, 'BESbswy0123');
  } catch {
    return false;
  }
}

async function load(spec) {
  try {
    await document.fonts.load(spec, 'BESbswy0123');
    return true;
  } catch {
    return false;
  }
}

async function loadFromUrl(family, weight, italic, url) {
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) return false;
    const face = new FontFace(family, await res.arrayBuffer(), {
      weight: String(weight),
      style: italic ? 'italic' : 'normal',
    });
    await face.load();
    document.fonts.add(face);
    return true;
  } catch {
    return false;
  }
}

function loadStylesheet(href) {
  if (injectedLinks.has(href)) return injectedLinks.get(href);
  const promise = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
    link.onload = () => resolve(true);
    link.onerror = () => resolve(false);
    document.head.appendChild(link);
  }).catch(() => false);
  injectedLinks.set(href, promise);
  return promise;
}

function finish(key, result) {
  resolved.set(key, result);
  return result;
}

/**
 * Everything that must be loaded before laying out this document: each distinct
 * (family, weight, italic) actually referenced. Emphasis text is set in italic (that is part of
 * the verified look), so the italic face of every referenced weight is requested too.
 */
export function fontRequestsFor(doc) {
  const seen = new Map();
  const add = (font, emphasisItalic) => {
    if (!font?.family) return;
    const weight = font.weight ?? 900;
    const styles = new Set([!!font.italic]);
    if (emphasisItalic) styles.add(true);
    for (const italic of styles) {
      seen.set(`${font.family}|${weight}|${italic ? 'i' : 'n'}`, {
        family: font.family,
        weight,
        italic,
      });
    }
  };
  const defaultItalic = doc?.defaults?.emphasis?.italic;
  add(doc?.defaults?.font, defaultItalic);
  for (const block of doc?.blocks ?? []) {
    add(block?.overrides?.font ?? doc?.defaults?.font, block?.overrides?.emphasis?.italic ?? defaultItalic);
  }
  return [...seen.values()];
}

/**
 * Load every font a document needs.
 * @returns {Promise<{ok: boolean, results: Array<{family: string, weight: number, ok: boolean, via?: string}>}>}
 */
export async function ensureFontsFor(doc, options = {}) {
  const requests = fontRequestsFor(doc);
  const results = await Promise.all(
    requests.map(async (r) => ({ ...r, ...(await ensureFont(r.family, { weight: r.weight, italic: r.italic, ...options })) })),
  );
  return { ok: results.every((r) => r.ok), results };
}

/** Reset the memoised load results (tests, and the "reload fonts" action). */
export function resetFontCache() {
  resolved.clear();
}

export { PACKAGED_DIR };
