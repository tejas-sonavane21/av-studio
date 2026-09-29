/**
 * fonts.test.js — the catalog and the loader's failure modes.
 *
 * Two things are worth pinning here:
 *
 * 1. **The catalog stays DOM-free.** `render/layout.js` imports `familyStack()` from it, and the
 *    layout engine must run in Node. A stray `document` reference in the registry would break every
 *    layout test, so importing this module at all is part of the assertion.
 * 2. **The loader never throws and never lies.** In Node there is no `document`, so it must report
 *    a clean failure rather than reject; in a browser, a family that is genuinely unavailable must
 *    report `ok: false` rather than pretend (which is how the old replica ended up measuring
 *    against a fallback face and producing a different layout).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_METRICS,
  FONT_REGISTRY,
  familyStack,
  fontFamilies,
  fontMetrics,
  getFont,
  nearestWeight,
} from '../../src/fonts/registry.js';
import {
  DEFAULT_TIMEOUT_MS,
  ensureFont,
  ensureFontsFor,
  fontRequestsFor,
  fontSpec,
  googleCssUrl,
  packagedUrl,
  resetFontCache,
} from '../../src/fonts/loader.js';
import { createDefaultStyle } from '../../src/model/schema.js';
import { createDemoDocument } from '../../src/model/demo.js';

test('the catalog covers the families the plan requires', () => {
  const required = [
    'Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Poppins', 'Bebas Neue', 'Anton',
    'Archivo', 'Oswald', 'Lato', 'Nunito', 'Source Sans 3',
  ];
  const families = fontFamilies();
  for (const f of required) assert.ok(families.includes(f), `missing family: ${f}`);
  assert.ok(families.length >= required.length + 1, 'at least one handwriting/display extra');
  assert.ok(FONT_REGISTRY.some((f) => f.category === 'handwriting'));
});

test('every entry is internally consistent', () => {
  for (const f of FONT_REGISTRY) {
    assert.equal(typeof f.family, 'string');
    assert.ok(Array.isArray(f.weights) && f.weights.length > 0, `${f.family} has weights`);
    assert.ok(f.stack.includes(f.family), `${f.family} stack must include itself first`);
    assert.ok(f.stack.includes('sans-serif') || f.stack.includes('cursive') || f.stack.includes('Impact'));
    for (const key of ['capHeight', 'xHeight', 'ascent', 'descent']) {
      const v = f.metrics[key];
      assert.ok(v > 0 && v < 2, `${f.family}.${key} plausible`);
    }
    // weights must be ascending so `nearestWeight` is meaningful
    const sorted = [...f.weights].sort((a, b) => a - b);
    assert.deepEqual(f.weights, sorted, `${f.family} weights ascending`);
  }
});

test('Inter carries the real, measured metrics from the plan', () => {
  const inter = getFont('Inter');
  assert.equal(inter.metrics.measured, true);
  assert.equal(inter.metrics.capHeight, 0.727);
  assert.equal(inter.metrics.xHeight, 0.52);
  assert.equal(inter.metrics.ascent, 0.969);
  assert.equal(inter.metrics.descent, 0.242);
  // everything else is honestly marked as an estimate
  assert.ok(FONT_REGISTRY.filter((f) => f.family !== 'Inter').every((f) => f.metrics.measured === false));
});

test('an unknown family degrades instead of throwing', () => {
  assert.equal(getFont('Nope Sans'), null);
  assert.equal(fontMetrics('Nope Sans'), FALLBACK_METRICS);
  assert.equal(familyStack('Nope Sans'), '"Nope Sans", system-ui, "Segoe UI", sans-serif');
  assert.equal(familyStack(undefined), 'system-ui, "Segoe UI", sans-serif');
  assert.equal(nearestWeight('Nope Sans', 850), 850);
});

test('familyStack is case-insensitive and always ends in a generic family', () => {
  assert.equal(familyStack('inter'), familyStack('Inter'));
  assert.ok(/"Inter"/.test(familyStack('INTER')));
  for (const f of fontFamilies()) {
    assert.ok(/sans-serif|cursive/.test(familyStack(f)), `${f} stack has a generic tail`);
  }
});

test('nearestWeight picks the closest shipped weight', () => {
  assert.equal(nearestWeight('Inter', 900), 900);
  assert.equal(nearestWeight('Inter', 850), 800);
  assert.equal(nearestWeight('Bebas Neue', 900), 400, 'single-weight families clamp');
});

test('fontSpec produces valid CSS font shorthands', () => {
  assert.ok(/^900 100px /.test(fontSpec('Inter', 900, false)));
  assert.ok(/^italic 900 100px /.test(fontSpec('Inter', 900, true)));
});

test('googleCssUrl and packagedUrl point where they should', () => {
  const url = googleCssUrl('Inter');
  assert.ok(url.startsWith('https://fonts.googleapis.com/css2?family='));
  assert.ok(url.includes('Inter'));
  assert.ok(url.includes('display=swap'));
  assert.equal(googleCssUrl('Nope Sans'), null);

  assert.ok(packagedUrl('Inter', 900).endsWith('/Inter-900.woff2'));
  assert.ok(packagedUrl('Inter', 900).includes('/src/fonts/packaged/'));
  assert.equal(packagedUrl('Inter', 555), null, 'no file for an unshipped weight');
  assert.equal(packagedUrl('Roboto', 400), null, 'no packaged file for other families yet');
});

test('fontRequestsFor collects every family/weight/style a document needs', () => {
  const doc = createDemoDocument();
  const requests = fontRequestsFor(doc);
  const keys = requests.map((r) => `${r.family}|${r.weight}|${r.italic ? 'i' : 'n'}`).sort();
  assert.deepEqual(keys, ['Inter|900|i', 'Inter|900|n'], 'Inter 900 roman + italic (emphasis)');

  // emphasis is italic, so a roman-only default still needs the italic face
  const overridden = createDefaultStyle();
  overridden.font = { ...overridden.font, family: 'Anton', weight: 400, italic: false };
  assert.deepEqual(
    fontRequestsFor({ defaults: overridden, blocks: [] }).map((r) => `${r.family}|${r.weight}|${r.italic ? 'i' : 'n'}`).sort(),
    ['Anton|400|i', 'Anton|400|n'],
  );

  // a document with no emphasis and no italic needs only the roman face
  const plain = createDefaultStyle();
  plain.emphasis = { ...plain.emphasis, italic: false };
  assert.deepEqual(
    fontRequestsFor({ defaults: plain, blocks: [] }).map((r) => `${r.family}|${r.weight}|${r.italic ? 'i' : 'n'}`),
    ['Inter|900|n'],
  );

  // a per-block font override is requested as well as the global one
  const doc2 = createDemoDocument();
  doc2.blocks[0].overrides = { font: { family: 'Bebas Neue', weight: 400 } };
  const keys2 = fontRequestsFor(doc2).map((r) => r.family);
  assert.ok(keys2.includes('Bebas Neue'), 'block overrides are requested');
  assert.ok(keys2.includes('Inter'), 'document defaults are still requested');
});

// ---------------------------------------------------------------------------
// the loader's failure modes (running in Node: there is no `document`)
// ---------------------------------------------------------------------------

test('the loader reports a clean failure when the Font Loading API is absent', async () => {
  resetFontCache();
  assert.equal(typeof globalThis.document, 'undefined', 'this test relies on a DOM-free Node');
  const result = await ensureFont('Inter', { weight: 900 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-font-loading-api');
});

test('ensureFont never rejects, even for a nonsense family', async () => {
  resetFontCache();
  const result = await ensureFont('', { weight: 123, italic: true, allowNetwork: false });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
});

test('ensureFontsFor reports per-family results and an overall verdict', async () => {
  resetFontCache();
  const doc = createDemoDocument();
  const { ok, results } = await ensureFontsFor(doc, { allowNetwork: false, timeoutMs: 10 });
  assert.equal(ok, false, 'nothing can load in Node');
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(typeof r.family, 'string');
  }
});

test('a memoised failure does not re-report differently', async () => {
  resetFontCache();
  const a = await ensureFont('Inter', { weight: 900 });
  const b = await ensureFont('Inter', { weight: 900 });
  assert.equal(b.ok, a.ok);
  // the second call may be served from the cache, but the verdict must be identical
  assert.equal(b.reason, a.reason);
  resetFontCache();
});

test('the default timeout is bounded', () => {
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 10000);
});
