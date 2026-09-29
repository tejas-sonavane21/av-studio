/**
 * render/emoji.js — emoji as image stickers (plan §9.7).
 *
 * **Default OFF**, mirroring the source video: the extracted Veed JSON carries `emoji` tags on
 * some words, but the verified render has `emojiEnabled: false`, so nothing is drawn. Earlier
 * replica versions drew them anyway and that was one of the things the frame-by-frame analysis
 * rejected.
 *
 * When a template *does* enable them, Veed renders an emoji as a PNG sticker with `zIndex 999`,
 * not as a text glyph — a text glyph would take the caption's font, colour and shadow and would
 * render as a monochrome/fallback box on Windows. We mirror that: an `<img>` per codepoint,
 * aspect-corrected, placed above the word.
 *
 * Everything here degrades silently: an image that is missing, blocked or still loading is skipped
 * for that frame (`draw` never awaits), so a failed sticker can never break a caption render and
 * can never produce a broken glyph.
 */

/** Veed's sticker geometry: `size = 0.08 × canvas`, aspect preserved. */
export const DEFAULT_EMOJI = Object.freeze({ enabled: false, size: 0.08, offsetEm: 1.35 });

/** Codepoint filename, e.g. `👦` → `1f466.png`, `🇬🇧` → `1f1ec-1f1e7.png`. */
export function emojiCodepoint(emoji) {
  return [...String(emoji)]
    .map((c) => c.codePointAt(0).toString(16))
    .join('-');
}

export function emojiUrl(emoji, { resolution = 64, baseUrl = 'https://static-assets.veed.io/emoji/' } = {}) {
  return `${baseUrl}images-${resolution}/${emojiCodepoint(emoji)}.png`;
}

/**
 * Create an emoji layer. Holds only an image cache; no canvas state.
 */
export function createEmojiLayer({ allowNetwork = true, resolution = 64 } = {}) {
  const images = new Map(); // url → { img, loaded, failed }
  const canUseImages = typeof Image !== 'undefined';

  function request(url) {
    let entry = images.get(url);
    if (entry || !canUseImages) return entry ?? null;
    if (!allowNetwork) {
      entry = { img: null, loaded: false, failed: true };
      images.set(url, entry);
      return entry;
    }
    entry = { img: null, loaded: false, failed: false };
    images.set(url, entry);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      entry.img = img;
      entry.loaded = true;
    };
    img.onerror = () => {
      entry.failed = true;
    };
    img.src = url;
    return entry;
  }

  return {
    /** Warm the cache for every emoji in a block. Safe to call for blocks not yet on screen. */
    preload(block) {
      for (const w of block?.words ?? []) {
        if (w.emoji) request(emojiUrl(w.emoji, { resolution }));
      }
    },

    /**
     * Draw the emoji stickers for one block.
     *
     * @param {object} layout  resolved layout (fragments carry `x`, `y`, `width`)
     * @param {object} style   resolved style (`style.emoji.enabled` gates everything)
     */
    draw(ctx, layout, block, states, style, { canvasWidth = 1280 } = {}) {
      const emoji = { ...DEFAULT_EMOJI, ...(style.emoji ?? {}) };
      if (!emoji.enabled || !canUseImages) return 0;
      const size = emoji.size * canvasWidth;
      let drawn = 0;
      for (const line of layout.lines) {
        for (const frag of line.fragments) {
          const word = block.words[frag.wordIndex];
          if (!word?.emoji || !states[frag.wordIndex]?.revealed) continue;
          const entry = request(emojiUrl(word.emoji, { resolution }));
          if (!entry?.loaded || !entry.img) continue;
          const natural = entry.img.naturalWidth || entry.img.width || 1;
          const naturalH = entry.img.naturalHeight || entry.img.height || 1;
          const w = size;
          const h = (size * naturalH) / natural;
          const x = frag.x + frag.width / 2 - w / 2;
          const y = frag.y - layout.effFontSize * emoji.offsetEm - h / 2;
          ctx.save();
          ctx.shadowColor = 'transparent';
          ctx.drawImage(entry.img, x, y, w, h);
          ctx.restore();
          drawn++;
        }
      }
      return drawn;
    },

    /** How many distinct emoji have successfully loaded (diagnostics). */
    get loadedCount() {
      let n = 0;
      for (const e of images.values()) if (e.loaded) n++;
      return n;
    },
    clear() {
      images.clear();
    },
  };
}
