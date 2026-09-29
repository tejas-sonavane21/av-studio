/**
 * tests/helpers/fake-canvas.js — a deterministic stand-in for a `<canvas>` and its 2D context.
 *
 * Why this is worth having: the renderer is the only part of the app that normally needs a
 * browser, so without a fake context the whole draw pipeline (display modes, progressive reveal,
 * underline geometry, guide drawing) would be untestable here — and "the agent cannot see the
 * browser" is exactly why the plan put testability first.
 *
 * The fake context records every call and keeps the state the drawing code depends on
 * (`font`, `fillStyle`, `globalAlpha`, shadow, the transform). Text metrics are *deterministic and
 * documented* rather than approximated from a real font, so expected geometry can be computed by
 * hand:
 *
 *     0.5 × fontSize per non-space character, 0.25 × fontSize per space
 *
 * That is not Inter — it is a ruler. Tests assert *geometry*, not glyph shapes, so a simple ruler
 * is strictly better than a font: it makes the expected numbers exact.
 */

/** `'900 46.08px "Inter", …'` → 46.08 */
export function fontSizeFromCss(css) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(css));
  return m ? Number(m[1]) : 0;
}

/** The documented test metric. See the module comment. */
export function fakeMeasure(text, css) {
  const size = fontSizeFromCss(css);
  let w = 0;
  for (const ch of String(text)) w += ch === ' ' ? 0.25 : 0.5;
  return w * size;
}

export class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = []; // { op, args }
    this.font = '10px sans-serif';
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.shadowColor = 'transparent';
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.depth = 0;
    this.maxDepth = 0;
    this.transform = [1, 0, 0, 1, 0, 0];
    this.stateStack = [];
  }

  // --- recorded primitives -------------------------------------------------
  record(op, ...args) {
    this.calls.push({ op, args });
  }

  /** All recorded calls of one op. */
  ops(op) {
    return this.calls.filter((c) => c.op === op);
  }

  /**
   * Every drawn string, with the full state at paint time.
   * Position alone is rarely enough — the renderer tests also assert on the face (`font`), the
   * colour, the alpha (animations) and the shadow, so all of it is carried through here.
   */
  get drawnText() {
    return this.ops('fillText').map((c) => ({
      text: c.args[0],
      x: c.args[1],
      y: c.args[2],
      font: c.font,
      fillStyle: c.fillStyle,
      globalAlpha: c.globalAlpha,
      shadowColor: c.shadowColor,
      shadowBlur: c.shadowBlur,
      shadowOffsetX: c.shadowOffsetX,
      shadowOffsetY: c.shadowOffsetY,
      textAlign: c.textAlign,
      textBaseline: c.textBaseline,
    }));
  }

  get strokedText() {
    return this.ops('strokeText').map((c) => ({
      text: c.args[0],
      x: c.args[1],
      y: c.args[2],
      font: c.font,
      strokeStyle: c.strokeStyle,
      lineWidth: c.lineWidth,
      textBaseline: c.textBaseline,
    }));
  }

  get filledRects() {
    return this.ops('fillRect').map((c) => ({
      x: c.args[0],
      y: c.args[1],
      w: c.args[2],
      h: c.args[3],
      fillStyle: c.fillStyle,
      shadowColor: c.shadowColor,
    }));
  }

  /** Fill styles seen at the moment of each `fillRect` — used to check "shadow suppressed". */
  get fillRectStyles() {
    return this.filledRects.map((r) => r.fillStyle);
  }

  reset() {
    this.calls.length = 0;
    this.depth = 0;
    this.maxDepth = 0;
  }

  // --- state ---------------------------------------------------------------
  save() {
    this.stateStack.push({
      font: this.font,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
    this.depth++;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    this.record('save');
  }

  restore() {
    const s = this.stateStack.pop();
    if (s) Object.assign(this, s);
    this.depth = Math.max(0, this.depth - 1);
    this.record('restore');
  }

  setTransform(a, b, c, d, e, f) {
    this.transform = [a, b, c, d, e, f];
    this.record('setTransform', a, b, c, d, e, f);
  }

  translate(x, y) {
    this.record('translate', x, y);
  }

  scale(x, y) {
    this.record('scale', x, y);
  }

  setLineDash(d) {
    this.record('setLineDash', d);
  }

  // --- paths ---------------------------------------------------------------
  beginPath() {
    this.record('beginPath');
  }

  closePath() {
    this.record('closePath');
  }

  moveTo(x, y) {
    this.record('moveTo', x, y);
  }

  lineTo(x, y) {
    this.record('lineTo', x, y);
  }

  arcTo(x1, y1, x2, y2, r) {
    this.record('arcTo', x1, y1, x2, y2, r);
  }

  rect(x, y, w, h) {
    this.record('rect', x, y, w, h);
  }

  fill() {
    const c = { op: 'fill', args: [] };
    c.fillStyle = this.fillStyle;
    c.globalAlpha = this.globalAlpha;
    c.shadowColor = this.shadowColor;
    this.calls.push(c);
  }

  stroke() {
    this.record('stroke');
  }

  // --- painting ------------------------------------------------------------
  clearRect(x, y, w, h) {
    this.record('clearRect', x, y, w, h);
  }

  fillRect(x, y, w, h) {
    const c = { op: 'fillRect', args: [x, y, w, h] };
    c.fillStyle = this.fillStyle;
    c.shadowColor = this.shadowColor;
    this.calls.push(c);
  }

  fillText(text, x, y) {
    const c = { op: 'fillText', args: [text, x, y] };
    c.font = this.font;
    c.fillStyle = this.fillStyle;
    c.globalAlpha = this.globalAlpha;
    c.shadowColor = this.shadowColor;
    c.shadowBlur = this.shadowBlur;
    c.shadowOffsetX = this.shadowOffsetX;
    c.shadowOffsetY = this.shadowOffsetY;
    c.textAlign = this.textAlign;
    c.textBaseline = this.textBaseline;
    this.calls.push(c);
  }

  strokeText(text, x, y) {
    const c = { op: 'strokeText', args: [text, x, y] };
    c.font = this.font;
    c.strokeStyle = this.strokeStyle;
    c.lineWidth = this.lineWidth;
    c.textBaseline = this.textBaseline;
    this.calls.push(c);
  }

  drawImage() {
    this.record('drawImage', ...arguments);
  }

  measureText(text) {
    this.record('measureText', text);
    return { width: fakeMeasure(text, this.font) };
  }
}

/** A fake `<canvas>` whose `getContext('2d')` returns a `FakeContext`. */
export function createFakeCanvas(width = 1280, height = 720) {
  const canvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext(kind) {
      if (kind !== '2d') return null;
      canvas.__ctx ??= new FakeContext(canvas);
      return canvas.__ctx;
    },
  };
  return canvas;
}

/** A canvas that refuses to give a 2D context (for the error paths). */
export function createContextlessCanvas() {
  return { width: 100, height: 100, style: {}, getContext: () => null };
}
