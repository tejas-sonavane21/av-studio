/**
 * templates/index.js — the template registry.
 *
 * A *template* is a named, complete style patch plus provenance. It is data, not code: no template
 * can do anything a hand-written style object could not, which is what keeps a user-edited style and
 * a template-produced style interchangeable (and therefore keeps export reproducible).
 *
 * Three rules make this registry trustworthy:
 *
 * 1. **One source of truth per template.** Each template lives in its own file under `defs/` and is
 *    listed here exactly once. Nothing in the app hard-codes a template's values.
 * 2. **Every template is validated at import.** `validateTemplate` checks the id, the origin, that
 *    the display/reveal/emphasis vocabularies are real, and — the useful one — that the font family
 *    actually exists in `fonts/registry.js`. A typo like `Montserat` fails loudly at module load
 *    instead of silently rendering a fallback face that "doesn't match".
 * 3. **The verified original is first.** `veed-auto-highlight` reproduces the frame-measured Veed
 *    reference and is the document default, so parity is the thing you get by accident.
 *
 * See IMPLEMENTATION-PLAN.md §10 for the template/styling design.
 */

import { DISPLAY_MODES } from '../model/schema.js';
import { getFont } from '../fonts/registry.js';
import { REVEAL_MODES, EMPHASIS_SOURCES } from '../render/time.js';

import veedAutoHighlight from './defs/veed-auto-highlight.js';
import veedBoldClean from './defs/veed-bold-clean.js';
import veedKaraoke from './defs/veed-karaoke.js';
import capcutBasicWhite from './defs/capcut-basic-white.js';
import capcutYellowPop from './defs/capcut-yellow-pop.js';
import capcutWhiteBox from './defs/capcut-white-box.js';
import capcutNeon from './defs/capcut-neon.js';
import cinematicElegant from './defs/cinematic-elegant.js';
import minimalLowerThird from './defs/minimal-lower-third.js';
import shortsImpact from './defs/shorts-impact.js';

/** Origins, in picker order. `veed` first because it is the verified reference. */
export const TEMPLATE_ORIGINS = ['veed', 'capcut', 'generic'];

/**
 * The starter set, in display order.
 *
 * Ordered Veed → CapCut → generic so the parity template is also the visually first option, and so
 * "which one matches the reference?" has an obvious default answer.
 */
export const TEMPLATES = [
  veedAutoHighlight,
  veedBoldClean,
  veedKaraoke,
  capcutBasicWhite,
  capcutYellowPop,
  capcutWhiteBox,
  capcutNeon,
  cinematicElegant,
  minimalLowerThird,
  shortsImpact,
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/**
 * Throw with a precise message if a template definition is malformed.
 * Called for every template at module load, so a broken def never reaches the renderer.
 */
export function validateTemplate(def, { where = 'template' } = {}) {
  const fail = (msg) => {
    throw new Error(`${where}: ${msg}`);
  };
  if (!def || typeof def !== 'object') fail('not an object');
  if (typeof def.id !== 'string' || !def.id) fail('missing a string `id`');
  if (!/^[a-z0-9-]+$/.test(def.id)) fail(`id "${def.id}" must be lower-case kebab-case`);
  if (typeof def.name !== 'string' || !def.name) fail(`"${def.id}" is missing a \`name\``);
  if (!TEMPLATE_ORIGINS.includes(def.origin)) {
    fail(`"${def.id}" has origin "${def.origin}"; expected one of ${TEMPLATE_ORIGINS.join(', ')}`);
  }
  const d = def.defaults;
  if (!d || typeof d !== 'object') fail(`"${def.id}" is missing \`defaults\``);

  if (d.display != null && !DISPLAY_MODES.includes(d.display)) {
    fail(`"${def.id}" display "${d.display}" is not one of ${DISPLAY_MODES.join(', ')}`);
  }
  if (d.reveal != null && !REVEAL_MODES.includes(d.reveal)) {
    fail(`"${def.id}" reveal "${d.reveal}" is not one of ${REVEAL_MODES.join(', ')}`);
  }
  if (d.emphasis?.source != null && !EMPHASIS_SOURCES.includes(d.emphasis.source)) {
    fail(`"${def.id}" emphasis.source "${d.emphasis.source}" is not one of ${EMPHASIS_SOURCES.join(', ')}`);
  }
  // The check that earns its keep: a misspelled family would otherwise degrade to a fallback face
  // and present as the classic "the font doesn't match" bug, with nothing in the logs.
  if (d.font?.family != null && !getFont(d.font.family)) {
    fail(`"${def.id}" uses unknown font family "${d.font.family}" (see fonts/registry.js)`);
  }
  if (d.font?.sizeUnit != null && !['w', 'h'].includes(d.font.sizeUnit)) {
    fail(`"${def.id}" font.sizeUnit "${d.font.sizeUnit}" must be 'w' (canvas width) or 'h' (height)`);
  }
  if (d.wrapWidth != null && !(d.wrapWidth > 0 && d.wrapWidth <= 1)) {
    fail(`"${def.id}" wrapWidth ${d.wrapWidth} must be in (0, 1] — it is a fraction of canvas width`);
  }
  return def;
}

// Validate eagerly. A malformed template is a build-time error, not a runtime surprise.
for (const def of TEMPLATES) validateTemplate(def, { where: 'templates/index.js' });

/** All template ids, in picker order. */
export function templateIds() {
  return TEMPLATES.map((t) => t.id);
}

/** One template by id, or `null`. */
export function getTemplate(id) {
  if (!id) return null;
  return BY_ID.get(String(id)) ?? null;
}

/** True if `id` names a real template. */
export function hasTemplate(id) {
  return BY_ID.has(String(id));
}

/**
 * A template's defaults, or `null` for an unknown id.
 * Returns the frozen definition object — never a copy — so callers cannot mutate the registry.
 */
export function templateDefaults(id) {
  return getTemplate(id)?.defaults ?? null;
}

/** Templates grouped by origin, in `TEMPLATE_ORIGINS` order. Origins with no templates are omitted. */
export function templatesByOrigin() {
  const out = [];
  for (const origin of TEMPLATE_ORIGINS) {
    const items = TEMPLATES.filter((t) => t.origin === origin);
    if (items.length) out.push({ origin, templates: items });
  }
  return out;
}

/**
 * Lightweight metadata for a picker: no style internals, plus a `swatch` describing how to preview
 * the template in a few CSS values.
 *
 * The swatch is *derived from the template's own defaults* rather than hand-written beside them, so
 * a picker tile can never drift out of sync with what the template actually renders.
 */
export function templateSwatch(id) {
  const def = getTemplate(id);
  if (!def) return null;
  const d = def.defaults ?? {};
  const box = d.box?.color ?? null;
  // Only treat the box as the swatch background when a display mode actually paints it.
  const boxVisible = box && ['BLOCK', 'LINE_BLOCK_ROUND', 'LINE_BLOCK_HARD'].includes(d.display ?? '');
  return {
    id: def.id,
    name: def.name,
    origin: def.origin,
    description: def.description ?? '',
    fill: d.fill?.color ?? '#ffffff',
    stroke: d.stroke?.width > 0 ? (d.stroke.color ?? null) : null,
    strokeWidth: d.stroke?.width ?? 0,
    background: boxVisible ? box : null,
    fontFamily: d.font?.family ?? null,
    fontWeight: d.font?.weight ?? null,
    uppercase: d.font?.case === 'upper',
    anchorPreset: d.anchor?.preset ?? null,
    emphasis: d.emphasis?.decoration ?? 'none',
    emphasisColor: d.emphasis?.decorationColor ?? null,
    emphasisSource: d.emphasis?.source ?? 'keyword',
    reveal: d.reveal ?? 'progressive',
  };
}

/** Every swatch, in picker order. */
export function allSwatches() {
  return TEMPLATES.map((t) => templateSwatch(t.id));
}
