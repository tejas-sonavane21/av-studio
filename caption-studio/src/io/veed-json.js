/**
 * io/veed-json.js — import/export Veed master JSON (extractor v1/v2/v3 output).
 *
 * Key normalisation (plan §8, v10 F5): style char-ranges are trimmed of surrounding
 * spaces rather than blindly shifted, which handles both the plain and the
 * leading-space conventions the extractor has produced over time.
 */

import { newBlockId, newWordId } from '../model/id.js';
import { createDefaultStyle } from '../model/schema.js';
import { normalizeDocument } from '../model/document.js';

const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);

export function detectVeedVersion(obj) {
  if (obj?.canvas) return 3;
  if (obj?.style?.posX != null) return 2;
  return 1;
}

/** Trim a style range to the actual non-space characters it covers. */
export function normalizeVeedStyles(styles, text) {
  return (styles || [])
    .map((st) => {
      const len = text.length;
      let from = Math.max(0, Math.min(len, (st.from ?? st.start ?? 0) | 0));
      let to = Math.max(0, Math.min(len, (st.to ?? st.end ?? 0) | 0));
      while (from < to && text[from] === ' ') from++;
      while (to > from && text[to - 1] === ' ') to--;
      return { from, to, id: st.id || 'auto-highlight', style: st.style || st.payload || {} };
    })
    .filter((st) => st.to > st.from);
}

export function parseVeedJSON(obj) {
  const version = detectVeedVersion(obj);
  const style = obj.style || {};

  const canvas = {
    width: num(obj.canvas?.targetWidth, num(obj.canvas?.width, 1280)),
    height: num(obj.canvas?.targetHeight, num(obj.canvas?.height, 720)),
    fps: 25,
  };

  const defaults = createDefaultStyle();
  if (style.font) defaults.font.family = style.font;
  if (Number.isFinite(Number(style.fontSize ?? style.size))) defaults.font.size = Number(style.fontSize ?? style.size);
  if (style.posX != null) defaults.anchor.posX = num(style.posX, defaults.anchor.posX);
  if (style.posY != null) defaults.anchor.posY = num(style.posY, defaults.anchor.posY);
  if (style.align) defaults.align = style.align;

  const subtitles = Array.isArray(obj.subtitles) ? obj.subtitles : [];
  const blocks = subtitles.map((sub) => {
    const words = (sub.words || []).map((w) => {
      const text = String(w.text ?? w.value ?? '');
      return {
        id: newWordId(),
        text,
        start: num(w.s ?? w.from),
        end: num(w.e ?? w.to),
        charFrom: 0,
        charTo: text.length,
        emphasis: false,
        emoji: w.emoji ?? null,
        confidence: null,
      };
    });
    const text = words.map((w) => w.text).join(' ');
    return {
      id: newBlockId(),
      start: num(sub.start ?? sub.from),
      end: num(sub.end ?? sub.to),
      text,
      overrides: {},
      styles: normalizeVeedStyles(sub.styles, text),
      words,
      placement: null,
      locked: false,
    };
  });
  blocks.sort((a, b) => a.start - b.start);

  const doc = {
    schemaVersion: 1,
    id: obj.projectId || 'veed-import',
    name: 'Veed import',
    canvas,
    media: { videoRef: null, duration: 0, audioRef: null },
    sources: { ai: { kind: 'veed-json', version }, truth: null },
    defaults,
    blocks,
    corrections: [],
    meta: { createdAt: Date.now(), updatedAt: Date.now(), app: 'caption-studio/veed-import' },
  };
  normalizeDocument(doc);
  return doc;
}

/** Best-effort export back to the Veed shape (round-tripping). */
export function serializeVeedJSON(doc) {
  return {
    version: '3.0',
    projectId: doc.id,
    canvas: { width: doc.canvas.width, height: doc.canvas.height },
    style: {
      font: doc.defaults.font.family,
      fontSize: doc.defaults.font.size,
      posX: doc.defaults.anchor.posX,
      posY: doc.defaults.anchor.posY,
      align: doc.defaults.align,
    },
    subtitles: doc.blocks.map((b) => ({
      start: b.start,
      end: b.end,
      styles: (b.styles || []).map((st) => ({ from: st.from, to: st.to, id: st.id, style: st.style })),
      words: b.words.map((w) => ({ text: w.text, s: w.start, e: w.end, emoji: w.emoji ?? null })),
    })),
  };
}
