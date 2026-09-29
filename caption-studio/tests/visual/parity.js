/**
 * tests/visual/parity.js — measure a rendered frame and compare it with a reference frame.
 *
 * ## Why measurement instead of a screenshot
 *
 * The point of this harness is to answer one question with evidence rather than inference:
 * **does our caption actually land where Veed's does?** A human squinting at two images cannot
 * settle that reliably, and an automated agent cannot look at images at all. So both frames are
 * reduced to numbers that *are* meaningful:
 *
 *   - the **lime underline** is an extremely specific signal. `#22c55e` essentially never occurs in
 *     this video's content, so a lime cluster in the caption band means "there is a caption here",
 *     and its bounding box gives the emphasised word's exact span, baseline offset and thickness.
 *   - the **near-white cluster** inside the same band gives the glyph extent (cap height, and
 *     whether the caption is one line or two).
 *
 * That is enough to catch the failure this was built for: if the font size were off by Veed's
 * ×1.78, the underline span and the glyph extent would be off by the same factor, immediately.
 *
 * Thresholds are deliberately loose in absolute terms (a couple of percent of the frame) because
 * video compression smears the underline and glyph rasterisation differs; what they catch is
 * *structural* disagreement, not sub-pixel noise.
 */

/** The verified underline colour, from the locked spec. */
export const LIME = { r: 34, g: 197, b: 94 };

/** Search band for captions, as fractions of the frame (generous around posX 0.772 / posY 0.848). */
export const CAPTION_BAND = { xFrom: 0.3, xTo: 1.0, yFrom: 0.5, yTo: 1.0 };

/** Minimum pixel count for a cluster to count as real (compression leaves stray specks). */
export const MIN_CLUSTER = 40;

function isLime(r, g, b, a, tol = 95) {
  if (a < 120) return false;
  // green must dominate both other channels, and the colour must be close to the reference
  if (!(g > r + 40 && g > b + 40)) return false;
  const dr = r - LIME.r;
  const dg = g - LIME.g;
  const db = b - LIME.b;
  return Math.sqrt(dr * dr + dg * dg + db * db) <= tol;
}

function isWhite(r, g, b, a) {
  if (a < 200) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 235 && max - min <= 22; // near-neutral and very bright
}

function emptyCluster() {
  return { count: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

function addTo(cluster, x, y) {
  cluster.count++;
  if (x < cluster.x0) cluster.x0 = x;
  if (y < cluster.y0) cluster.y0 = y;
  if (x > cluster.x1) cluster.x1 = x;
  if (y > cluster.y1) cluster.y1 = y;
}

/** Finite-ify a cluster and derive its box metrics. */
function finish(cluster) {
  const exists = cluster.count > 0;
  return {
    count: cluster.count,
    x0: exists ? cluster.x0 : null,
    y0: exists ? cluster.y0 : null,
    x1: exists ? cluster.x1 : null,
    y1: exists ? cluster.y1 : null,
    width: exists ? cluster.x1 - cluster.x0 + 1 : 0,
    height: exists ? cluster.y1 - cluster.y0 + 1 : 0,
    cx: exists ? (cluster.x0 + cluster.x1 + 1) / 2 : null,
    cy: exists ? (cluster.y0 + cluster.y1 + 1) / 2 : null,
  };
}

/**
 * Scan an ImageData for the lime underline and the near-white glyphs.
 *
 * @param {ImageData} image
 * @param {object} [rect]  pixel rect to restrict to (default: the whole frame)
 * @returns {{lime: object, white: object, scanned: number}}
 */
export function analyseImageData(image, rect = null) {
  const { data, width, height } = image;
  const x0 = Math.max(0, Math.floor(rect?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(rect?.y0 ?? 0));
  const x1 = Math.min(width - 1, Math.ceil(rect?.x1 ?? width - 1));
  const y1 = Math.min(height - 1, Math.ceil(rect?.y1 ?? height - 1));

  const lime = emptyCluster();
  const white = emptyCluster();
  let scanned = 0;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 120) continue;
      scanned++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isLime(r, g, b, a)) addTo(lime, x, y);
      else if (isWhite(r, g, b, a)) addTo(white, x, y);
    }
  }
  return { lime: finish(lime), white: finish(white), scanned, rect: { x0, y0, x1, y1 } };
}

/**
 * Whole-frame statistics. Exists to distinguish the two very different reasons a reference frame can
 * lack a caption: **there is no caption in it**, or **the frame is blank** (a decode/present
 * failure). Without this, a blank canvas silently reads as "the reference has no captions" — which
 * is exactly the wrong conclusion to draw.
 */
export function frameStats(image) {
  const { data } = image;
  let nonBlack = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * 7) {
    const a = data[i + 3] / 255;
    const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * a;
    if (luma > 12) nonBlack++;
    sum += luma;
    n++;
  }
  return {
    sampled: n,
    nonBlack,
    nonBlackFraction: n ? nonBlack / n : 0,
    meanLuma: n ? sum / n : 0,
    blank: n ? nonBlack / n < 0.02 : true,
  };
}

/** The caption band as a pixel rect. */
export function bandRect(width, height, band = CAPTION_BAND) {
  return {
    x0: width * band.xFrom,
    x1: width * band.xTo,
    y0: height * band.yFrom,
    y1: height * band.yTo,
  };
}

/**
 * Measure one frame: both the full frame and the caption band.
 * The full frame is kept for diagnosis ("is the caption somewhere unexpected?").
 */
export function measureFrame(ctx, width, height, { band = CAPTION_BAND } = {}) {
  const full = ctx.getImageData(0, 0, width, height);
  const rect = bandRect(width, height, band);
  return {
    full: analyseImageData(full),
    band: analyseImageData(full, rect),
    stats: frameStats(full),
    width,
    height,
  };
}

/**
 * How many caption lines does a glyph cluster imply?
 * Uses the measured cap height against the frame height; 1-2 lines is all this needs to tell apart.
 */
export function estimateLines(cluster, height) {
  if (!cluster.count) return 0;
  const rel = cluster.height / height;
  if (rel < 0.065) return 1;
  if (rel < 0.16) return 2;
  return 3;
}

/**
 * Compare a reference frame with ours.
 *
 * `rel` deltas are fractions of the frame's width (x) or height (y), so a verdict is size-independent.
 */
export function compareFrames(reference, ours, { height, tolerances = {} } = {}) {
  const tol = {
    x: 0.03, // 3 % of frame width
    y: 0.02, // 2 % of frame height
    span: 0.05, // 5 % of frame width for the underline's own span
    ...tolerances,
  };

  const refLime = reference.band.lime;
  const ourLime = ours.band.lime;
  const refWhite = reference.band.white;
  const ourWhite = ours.band.white;

  const notes = [];
  const failures = [];

  const refHasCaption = refLime.count >= MIN_CLUSTER || refWhite.count >= MIN_CLUSTER * 4;
  const ourHasCaption = ourLime.count >= MIN_CLUSTER || ourWhite.count >= MIN_CLUSTER * 4;

  if (!refHasCaption) {
    return {
      status: 'no-reference-caption',
      refHasCaption,
      ourHasCaption,
      notes: ['the reference frame contains no caption (no lime underline, no white glyph cluster)'],
      failures: [],
      deltas: {},
    };
  }
  if (!ourHasCaption) {
    return {
      status: 'fail',
      refHasCaption,
      ourHasCaption,
      notes: [],
      failures: ['the reference has a caption but our render has none in the same band'],
      deltas: {},
    };
  }

  const deltas = {
    limeX0: (ourLime.x0 - refLime.x0) / ours.width,
    limeX1: (ourLime.x1 - refLime.x1) / ours.width,
    limeY: (ourLime.cy - refLime.cy) / ours.height,
    limeThickness: (ourLime.height - refLime.height) / ours.height,
    limeSpan: (ourLime.width - refLime.width) / ours.width,
    whiteX0: whiteDelta(refWhite, ourWhite, 'x0', ours.width),
    whiteY: whiteDelta(refWhite, ourWhite, 'y0', ours.height),
    whiteHeight: whiteDelta(refWhite, ourWhite, 'height', ours.height),
  };

  const check = (name, value, limit) => {
    if (value === null) return;
    if (Math.abs(value) > limit) {
      failures.push(`${name} off by ${(value * 100).toFixed(1)}% (limit ${(limit * 100).toFixed(0)}%)`);
    }
  };

  check('underline left edge', deltas.limeX0, tol.x);
  check('underline right edge', deltas.limeX1, tol.x);
  check('underline height (vertical)', deltas.limeY, tol.y);
  check('underline span', deltas.limeSpan, tol.span);
  check('glyph top', deltas.whiteY, tol.y);
  check('glyph extent', deltas.whiteHeight, tol.y);

  // A factor-of-1.78 font-size error shows up as ~78 % off; call that out by name.
  if (deltas.limeSpan !== null && Math.abs(deltas.limeSpan) > 0.25) {
    const ratio = refLime.width > 0 ? ourLime.width / refLime.width : 0;
    notes.push(
      `underline span ratio is ${ratio.toFixed(2)}× the reference — strongly suggests a font-size unit error`,
    );
  }
  if (refWhite.height && ourWhite.height) {
    const ratio = ourWhite.height / refWhite.height;
    notes.push(`glyph height ratio ${ratio.toFixed(2)}× (reference ${refWhite.height}px, ours ${ourWhite.height}px)`);
  }

  const lines = { reference: estimateLines(refWhite, ours.height), ours: estimateLines(ourWhite, ours.height) };
  if (lines.reference && lines.ours && lines.reference !== lines.ours) {
    failures.push(`line count differs: reference ${lines.reference}, ours ${lines.ours} (wrapping mismatch)`);
  }

  return {
    status: failures.length ? 'fail' : 'pass',
    refHasCaption,
    ourHasCaption,
    lines,
    deltas,
    notes,
    failures,
    reference: { lime: refLime, white: refWhite },
    ours: { lime: ourLime, white: ourWhite },
  };
}

function whiteDelta(refWhite, ourWhite, key, divisor) {
  if (!refWhite.count || !ourWhite.count) return null;
  return (ourWhite[key] - refWhite[key]) / divisor;
}
