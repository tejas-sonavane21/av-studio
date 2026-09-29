/**
 * fonts/registry.js — the font family catalog. **Pure data + pure helpers; no DOM.**
 *
 * `render/layout.js` imports `familyStack()` from here, and the layout module must stay usable in
 * Node tests, so this file must never touch `document`/`window`. Loading lives in `loader.js`.
 *
 * ## `metrics`
 *
 * Metrics are fractions of the em and are used to place baselines, underlines and box paddings
 * without per-font hacks (plan §11.2). Values for **Inter are the real, known ones** (plan §11.2,
 * i.e. `capHeight 0.727`, `xHeight 0.52`, `ascent 0.969`, `descent 0.242`) and are marked
 * `measured: true`. The others are typographically reasonable estimates marked `measured: false`;
 * Phase 4 measures them for real with an offscreen canvas and stores the result. Anything that
 * needs to be *exact for parity* must therefore read Inter's metrics, not an estimate.
 */

/** Used when a family is unknown. Deliberately generic rather than pretending to be right. */
export const FALLBACK_METRICS = Object.freeze({
  capHeight: 0.7,
  xHeight: 0.5,
  ascent: 0.95,
  descent: 0.25,
  measured: false,
});

/**
 * One entry per family.
 *
 * - `stack`  — the CSS `font-family` fallback list. Bundled/packaged faces are named exactly the
 *              same as `family`, so listing `family` first is also what makes a locally installed
 *              copy work with no network at all.
 * - `sources`— in preference order: `packaged` (a woff2 dropped into `fonts/packaged/`),
 *              `google` (opt-in network), `system` (whatever the OS has).
 * - `googleQuery` — the `family=` fragment for the Google Fonts CSS2 API, when one exists.
 */
export const FONT_REGISTRY = [
  {
    family: 'Inter',
    category: 'sans',
    weights: [400, 500, 700, 800, 900],
    italics: true,
    // The Veed parity face. `Inter-900.woff2` / `Inter-900-italic.woff2` are the names the loader
    // looks for in `fonts/packaged/` — drop them in for exact offline parity.
    packaged: { 400: 'Inter-400.woff2', 900: 'Inter-900.woff2' },
    googleQuery: 'Inter:ital,wght@0,400;0,900;1,900',
    stack: '"Inter", "Inter Tight", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    metrics: { capHeight: 0.727, xHeight: 0.52, ascent: 0.969, descent: 0.242, measured: true },
  },
  {
    family: 'Roboto',
    category: 'sans',
    weights: [400, 500, 700, 900],
    italics: true,
    googleQuery: 'Roboto:ital,wght@0,400;0,900;1,900',
    stack: '"Roboto", system-ui, Arial, sans-serif',
    metrics: { capHeight: 0.711, xHeight: 0.528, ascent: 0.927, descent: 0.244, measured: false },
  },
  {
    family: 'Open Sans',
    category: 'sans',
    weights: [400, 600, 700, 800],
    italics: true,
    googleQuery: 'Open+Sans:ital,wght@0,400;0,800;1,800',
    stack: '"Open Sans", system-ui, "Segoe UI", sans-serif',
    metrics: { capHeight: 0.714, xHeight: 0.535, ascent: 1.068, descent: 0.293, measured: false },
  },
  {
    family: 'Montserrat',
    category: 'sans',
    weights: [400, 600, 700, 800, 900],
    italics: true,
    googleQuery: 'Montserrat:ital,wght@0,400;0,900;1,900',
    stack: '"Montserrat", system-ui, "Segoe UI", sans-serif',
    metrics: { capHeight: 0.7, xHeight: 0.517, ascent: 0.968, descent: 0.251, measured: false },
  },
  {
    family: 'Poppins',
    category: 'sans',
    weights: [400, 600, 700, 800, 900],
    italics: true,
    googleQuery: 'Poppins:ital,wght@0,400;0,900;1,900',
    stack: '"Poppins", system-ui, "Segoe UI", sans-serif',
    metrics: { capHeight: 0.7, xHeight: 0.548, ascent: 1.05, descent: 0.35, measured: false },
  },
  {
    family: 'Bebas Neue',
    category: 'display',
    weights: [400],
    italics: false,
    googleQuery: 'Bebas+Neue',
    stack: '"Bebas Neue", "Anton", Impact, "Arial Narrow", sans-serif',
    metrics: { capHeight: 0.72, xHeight: 0.52, ascent: 0.9, descent: 0.2, measured: false },
  },
  {
    family: 'Anton',
    category: 'display',
    weights: [400],
    italics: false,
    googleQuery: 'Anton',
    stack: '"Anton", Impact, "Arial Narrow", sans-serif',
    metrics: { capHeight: 0.73, xHeight: 0.53, ascent: 1.02, descent: 0.28, measured: false },
  },
  {
    family: 'Archivo',
    category: 'sans',
    weights: [400, 500, 700, 900],
    italics: true,
    googleQuery: 'Archivo:ital,wght@0,400;0,900;1,900',
    stack: '"Archivo", system-ui, "Segoe UI", sans-serif',
    metrics: { capHeight: 0.71, xHeight: 0.52, ascent: 0.95, descent: 0.25, measured: false },
  },
  {
    family: 'Oswald',
    category: 'sans',
    weights: [400, 500, 700],
    italics: false,
    googleQuery: 'Oswald:wght@400;700',
    stack: '"Oswald", "Arial Narrow", Impact, sans-serif',
    metrics: { capHeight: 0.72, xHeight: 0.53, ascent: 1.09, descent: 0.29, measured: false },
  },
  {
    family: 'Lato',
    category: 'sans',
    weights: [400, 700, 900],
    italics: true,
    googleQuery: 'Lato:ital,wght@0,400;0,900;1,900',
    stack: '"Lato", system-ui, "Segoe UI", sans-serif',
    metrics: { capHeight: 0.72, xHeight: 0.51, ascent: 0.987, descent: 0.213, measured: false },
  },
  {
    family: 'Nunito',
    category: 'sans',
    weights: [400, 700, 900],
    italics: true,
    googleQuery: 'Nunito:ital,wght@0,400;0,900;1,900',
    stack: '"Nunito", system-ui, "Segoe UI", sans-serif',
    metrics: { capHeight: 0.71, xHeight: 0.51, ascent: 1.01, descent: 0.29, measured: false },
  },
  {
    family: 'Source Sans 3',
    category: 'sans',
    weights: [400, 600, 700, 900],
    italics: true,
    googleQuery: 'Source+Sans+3:ital,wght@0,400;0,900;1,900',
    stack: '"Source Sans 3", "Source Sans Pro", system-ui, sans-serif',
    metrics: { capHeight: 0.66, xHeight: 0.486, ascent: 0.984, descent: 0.273, measured: false },
  },
  {
    family: 'Caveat',
    category: 'handwriting',
    weights: [400, 700],
    italics: false,
    googleQuery: 'Caveat:wght@400;700',
    stack: '"Caveat", "Segoe Script", cursive',
    metrics: { capHeight: 0.7, xHeight: 0.45, ascent: 1.1, descent: 0.35, measured: false },
  },
  {
    family: 'Bangers',
    category: 'display',
    weights: [400],
    italics: false,
    googleQuery: 'Bangers',
    stack: '"Bangers", Impact, "Comic Sans MS", cursive',
    metrics: { capHeight: 0.72, xHeight: 0.5, ascent: 1.0, descent: 0.28, measured: false },
  },
];

const BY_FAMILY = new Map(FONT_REGISTRY.map((f) => [f.family.toLowerCase(), f]));

export function getFont(family) {
  return BY_FAMILY.get(String(family ?? '').toLowerCase()) ?? null;
}

export function fontFamilies() {
  return FONT_REGISTRY.map((f) => f.family);
}

/** The CSS `font-family` list for a family. Unknown families degrade to a generic sans stack. */
export function familyStack(family) {
  const entry = getFont(family);
  if (entry) return entry.stack;
  const name = String(family ?? '').trim();
  return name ? `"${name}", system-ui, "Segoe UI", sans-serif` : 'system-ui, "Segoe UI", sans-serif';
}

/** Metrics for a family, falling back to generic values for unknown families. */
export function fontMetrics(family) {
  return getFont(family)?.metrics ?? FALLBACK_METRICS;
}

/** The nearest supported weight a family actually ships, or the requested one if nothing is known. */
export function nearestWeight(family, weight = 900) {
  const entry = getFont(family);
  if (!entry || !entry.weights?.length) return weight;
  return entry.weights.reduce((best, w) =>
    Math.abs(w - weight) < Math.abs(best - weight) ? w : best,
  entry.weights[0]);
}
