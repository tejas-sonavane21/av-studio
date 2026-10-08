/**
 * util/color.js — colours, as the UI needs to read them.
 *
 * The emphasis colour lives in the document as a CSS colour string, and it deliberately may be
 * anything the renderer accepts: `#22c55e`, `#fff`, `rgba(...)`, a named colour. An
 * `<input type="color">` cannot hold any of those — it holds exactly `#rrggbb` and silently becomes
 * black for anything else, which would show the user a colour the caption is not using.
 *
 * So the picked colour is converted *towards* the input, never the other way: the document keeps the
 * authoritative value and the input is given the nearest thing it can actually display. The reverse
 * (writing the input's value back on load) is what would flatten an `rgba()` underline to black.
 */

/** Is this a `#rgb` or `#rrggbb` string? The only shapes a colour input can hold. */
export function isHexColor(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value ?? '').trim());
}

/**
 * A value an `<input type="color">` can hold: `#rrggbb`, lower-cased.
 *
 * `#abc` is expanded (`#aabbcc`). Anything the input cannot represent — an alpha colour, a named
 * colour, an empty value — falls back, because a picker showing black would be a lie about the
 * document rather than a limitation of the picker.
 */
export function toHexColor(value, fallback = '#22c55e') {
  const s = String(value ?? '').trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(s);
  if (short) return `#${[...short[1]].map((c) => c + c).join('')}`;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return fallback;
}
