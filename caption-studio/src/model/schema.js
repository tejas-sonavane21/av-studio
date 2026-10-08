/**
 * model/schema.js — canonical shapes, constants and factories.
 *
 * This module is the single source of truth for *what a caption document looks like*.
 * It imports nothing from the rest of the app (only util). Everything else depends on it.
 *
 * See IMPLEMENTATION-PLAN.md §5 for the full annotated data model.
 */

import { newBlockId, newWordId } from './id.js';
import { mergeDeep } from '../util/math.js';

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.1.0';

/** Veed's text display modes, ported from the real renderer (Knowledge Base §4). */
export const DISPLAY_MODES = [
  'NORMAL',
  'DROPSHADOW',
  'BLOCK',
  'LINE_BLOCK_ROUND',
  'LINE_BLOCK_HARD',
  'OUTLINE',
  'OUTLINED',
  'none',
];

export const GRAVITY = {
  // how a text box sits relative to its anchor point
  x: ['left', 'center', 'right'],
  y: ['top', 'center', 'bottom'],
};

export const ANCHOR_PRESETS = {
  'top-left': { posX: 0.1, posY: 0.12, gravity: 'center' },
  'top-center': { posX: 0.5, posY: 0.12, gravity: 'center' },
  'top-right': { posX: 0.9, posY: 0.12, gravity: 'center' },
  'middle-left': { posX: 0.1, posY: 0.5, gravity: 'center' },
  center: { posX: 0.5, posY: 0.5, gravity: 'center' },
  'middle-right': { posX: 0.9, posY: 0.5, gravity: 'center' },
  'bottom-left': { posX: 0.1, posY: 0.86, gravity: 'center' },
  'bottom-center': { posX: 0.5, posY: 0.86, gravity: 'center' },
  // The verified Veed original:
  'bottom-right': { posX: 0.772, posY: 0.848, gravity: 'center' },
};

/**
 * Document-wide defaults. These reproduce the verified Veed
 * `template-027-sub` ("auto-highlight") look exactly (see plan Appendix C).
 */
export function createDefaultStyle() {
  return {
    templateId: 'veed-auto-highlight',
    font: {
      family: 'Inter',
      weight: 900,
      size: 0.036, // fraction of canvas WIDTH (Veed parity — see plan §11.3)
      sizeUnit: 'w',
      italic: false,
      letterSpacing: 0,
      lineHeight: 1.15,
      case: 'none',
    },
    fill: { color: '#ffffff', opacity: 1 },
    stroke: { color: '#000000', width: 0 },
    // blur/offsetX/offsetY are px *at the 1280-wide reference* and are scaled by
    // canvasWidth/1280, so the look is exact at the reference size and proportional elsewhere
    // (see render/decorations.js `pxScaleFor`).
    shadow: {
      color: 'rgba(0,0,0,0.85)',
      blur: 10,
      offsetX: 3,
      offsetY: 3,
      onDecoration: false, // shadow suppressed on the underline
    },
    display: 'NORMAL',
    // How words appear: 'progressive' (Veed parity, word-by-word), 'all' (whole line at block
    // start) or 'active' (only the word being spoken). See render/time.js.
    reveal: 'progressive',
    // Normalized fraction of canvas **width** — Veed's own `getTextProps()` scales `wrapWidth` by
    // width exactly as it scales `fontSize`, so both are width-relative. 0.9 is v10's proven
    // overflow cap, which means every line v10 kept on one line still renders on one line
    // (parity) while genuinely longer text now wraps instead of being shrunk to fit.
    wrapWidth: 0.9,
    // The master switch for wrapping. On (the default) a caption is wrapped at `wrapWidth` — or at
    // the canvas edge when `wrapWidth` is 0 — so a line can never leave the frame. Off reproduces
    // the v10 replica: one line, however wide, overflow and all. It exists as its own flag rather
    // than as "wrapWidth 0" because 'no wrapping' and 'wrap at 90%' are two different intentions,
    // and a single slider cannot express both.
    autoWrap: true,
    maxLines: 3,
    // Background boxes for the BOX display modes and the `highlight` emphasis decoration.
    // Paddings and radius are em fractions of the font size (see render/decorations.js).
    box: { color: 'rgba(0,0,0,0.65)', opacity: 1, radius: 0.2, paddingX: 0.32, paddingY: 0.14 },
    align: 'center',
    // The verified Veed original sits on the `bottom-right` preset, and saying so explicitly is what
    // makes `veed-auto-highlight` a *complete* description of the default style — otherwise the
    // template would carry a `preset` the default style does not, and "is this document still on the
    // parity template?" could never be true for a fresh document.
    anchor: { ...ANCHOR_PRESETS['bottom-right'], preset: 'bottom-right' },
    animation: { in: 'reveal', inDur: 0.12, out: null, outDur: 0.1, loop: null },
    emphasis: {
      styleId: 'auto-highlight',
      decoration: 'underline', // 'underline' | 'sweep' | 'highlight' | 'none'
      decorationColor: '#22c55e',
      highlightColor: null, // falls back to the box colour when null
      italic: true,
      weightBoost: 0,
      // 'keyword' = the AI-keyword words (Veed). 'active' = the word being spoken (karaoke).
      source: 'keyword',
      // The underline (or sweep) is *drawn* over `drawDuration` seconds as its word appears, rather
      // than being painted whole. `animate: false` restores the static parity decoration. The length
      // is unchanged either way: the line still spans exactly the word it belongs to.
      animate: true,
      drawDuration: 0.4,
    },
    emoji: { enabled: false, size: 0.08 },
  };
}

/**
 * The frame ratios a caption project can be cut for — CapCut's vocabulary.
 *
 * These are **project settings**, not preview cosmetics: the document's canvas size is what the
 * preview is fitted to, what the layout measures against (font size is a fraction of *width* by
 * default) and what the burn-in export records at. Choosing 9:16 really does give a 9:16 file.
 *
 * The numbers are the delivery sizes each platform wants, and they are *targets*: `canvasForPreset`
 * scales them down to a loaded picture's own long edge, because inventing pixels the source does not
 * have is the one thing an export must never do.
 */
export const CANVAS_PRESETS = Object.freeze({
  '16:9': { width: 1920, height: 1080, label: '16:9 — YouTube, landscape' },
  '9:16': { width: 1080, height: 1920, label: '9:16 — Shorts, Reels, TikTok' },
  '4:5': { width: 1080, height: 1350, label: '4:5 — Instagram feed' },
  '1:1': { width: 1080, height: 1080, label: '1:1 — square' },
  '4:3': { width: 1440, height: 1080, label: '4:3 — classic' },
  '3:4': { width: 1080, height: 1440, label: '3:4 — portrait' },
  '21:9': { width: 2520, height: 1080, label: '21:9 — cinemascope' },
});

/** Video encoders want even dimensions; an odd one is a codec failure waiting to happen. */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The canvas a preset resolves to, given the picture it will be laid over.
 *
 * The preset's long edge is the target, but it is capped at the source's own long edge: a 1280×720
 * recording asked for 9:16 becomes 720×1280, not 1080×1920. The stored resolution then always
 * reflects real detail, and turning a landscape clip into a vertical one costs no upscaling.
 *
 * @param {string} id                              a `CANVAS_PRESETS` key
 * @param {object} [opts]
 * @param {{width:number,height:number}|null} [opts.source]  the loaded picture, if any
 * @param {number} [opts.fps=30]
 * @returns {{width:number,height:number,fps:number}|null}   null for an unknown preset id
 */
export function canvasForPreset(id, { source = null, fps = 30 } = {}) {
  const preset = CANVAS_PRESETS[id];
  if (!preset) return null;
  const aspect = preset.width / preset.height;
  const targetLong = Math.max(preset.width, preset.height);
  const sourceLong = Math.max(Number(source?.width) || 0, Number(source?.height) || 0);
  const scale = sourceLong > 0 ? Math.min(1, sourceLong / targetLong) : 1;
  const long = targetLong * scale;
  return {
    width: even(aspect >= 1 ? long : long * aspect),
    height: even(aspect >= 1 ? long / aspect : long),
    fps: Number(fps) > 0 ? Number(fps) : 30,
  };
}

/**
 * Which preset a canvas is (approximately) on, for reading the picker back out of the document.
 *
 * Tolerance matters because the presets' own pixel sizes are rounded (21:9 is 2520×1080, a ratio of
 * 2.3333… but not exactly 21/9) and because a loaded video's size is whatever the camera wrote. A
 * canvas matching nothing — a source clip's own odd shape — reports `'source'`, which is a real
 * choice in the picker ("keep the picture's own ratio") rather than a failure.
 */
export function presetIdFor(canvas, tolerance = 0.02) {
  const aspect = (Number(canvas?.width) || 0) / (Number(canvas?.height) || 0);
  if (!(aspect > 0)) return 'source';
  for (const [id, preset] of Object.entries(CANVAS_PRESETS)) {
    const target = preset.width / preset.height;
    if (Math.abs(target - aspect) <= tolerance * target) return id;
  }
  return 'source';
}

export function createWord(text, start = 0, end = 0, extra = {}) {
  return {
    id: newWordId(),
    text: String(text),
    start,
    end,
    charFrom: 0, // filled by rebuildBlockText()
    charTo: String(text).length,
    emphasis: false,
    emoji: null,
    confidence: null,
    ...extra,
  };
}

export function createBlock(start = 0, end = 0, words = [], extra = {}) {
  return {
    id: newBlockId(),
    start,
    end,
    text: '',
    overrides: {}, // sparse patch over document defaults
    styles: [], // [{ from, to, id, style }] char ranges into `text`
    words,
    placement: null, // optional per-block anchor override
    locked: false,
    ...extra,
  };
}

export function createDocument({
  name = 'Untitled',
  canvas = { width: 1280, height: 720, fps: 25 },
  media = { videoRef: null, duration: 0, audioRef: null },
  sources = { ai: null, truth: null },
  defaults = createDefaultStyle(),
  blocks = [],
} = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `proj_${Math.random().toString(36).slice(2, 10)}`,
    name,
    canvas,
    media,
    sources,
    defaults,
    blocks,
    corrections: [],
    meta: { createdAt: Date.now(), updatedAt: Date.now(), app: `caption-studio/${APP_VERSION}` },
  };
}

/**
 * The effective anchor for a block.
 *
 * Anchors are **atomic**: a position is a single value, so a block that supplies its own anchor —
 * as a `placement`, or as an explicit `overrides.anchor` — must not inherit the document's `preset`
 * id. Otherwise a block dragged to the middle would still claim to be `bottom-right`, and the
 * inspector's readout would contradict the canvas. `gravity` *is* inheritable, because a sparse
 * override like `{ posX: 0.2 }` still needs a vertical rule to mean anything.
 */
export function resolveAnchor(document, block) {
  const base = mergeDeep(createDefaultStyle().anchor, document?.defaults?.anchor);
  const own = block?.placement ?? block?.overrides?.anchor ?? null;
  if (!own) return base;
  const out = {
    ...base,
    posX: own.posX ?? base.posX,
    posY: own.posY ?? base.posY,
    gravity: own.gravity ?? base.gravity,
  };
  if (own.preset) out.preset = own.preset;
  else delete out.preset;
  return out;
}

/** Resolve the effective style for a block: document defaults ⊕ block overrides ⊕ placement. */
export function resolveStyle(document, block) {
  const style = mergeDeep(createDefaultStyle(), document?.defaults || {}, block?.overrides || {});
  style.anchor = resolveAnchor(document, block);
  return style;
}
