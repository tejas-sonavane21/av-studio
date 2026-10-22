/**
 * model/media.js — the clips that sit **over** the picture.
 *
 * The timeline stores kept ranges of one source file (see `model/timeline.js`), which is what keeps
 * captions, cuts and the transport on a single clock. An overlay clip is a different kind of thing: its
 * own file, its own window on the programme's clock, and a box on the frame. So it lives in its own
 * list on the document (`doc.media`) rather than in the two cut tracks, and it is timed with the same
 * numbers a caption is — `start`/`end` on the source clock — so nothing about the timing changes.
 *
 *   source clock   |===============================================|
 *   caption        |        [=====]        [========]             |
 *   clip           |   [=========]                                        a picture layer
 *   clip           |                        [============]
 *
 * Two decisions are worth stating up front, because both are visible on screen.
 *
 * **The box is a box, not a position.** A clip carries `box: {x, y, w, h}` as fractions of the frame,
 * and the media is fitted *inside* it — `contain` by default, and stretched only when the user says so
 * (see `MEDIA_FITS`). Storing a centre point and an aspect instead would make "resize without
 * distorting" a rule every caller had to remember; storing a box makes distortion a setting rather than
 * an accident, because a box dragged to any shape at all still draws the media at its own ratio.
 * `boxForMedia()` is what turns a file's own size into a box that already has the right shape, so the
 * common case (drop a logo on, it looks like the logo) needs no dragging at all.
 *
 * A clip also carries `rotation` and the two flips, because the preview's handles can turn and mirror
 * one — and the export has to draw the frame the preview showed. They are stored as an angle about the
 * box's own centre rather than as a matrix, so a project file stays readable and `rotation: 0` is one
 * value rather than a range of near-identities.
 *
 * **A crop is a rectangle on the *file*, and it is not a mask.** `crop: {x, y, w, h}` is in fractions of
 * the media's own pixels, so "the top half of the shot" means the same thing whatever the box is doing
 * or how the frame is shaped. What is drawn is that piece of the file, fitted into the box by `fit` like
 * any other picture — which is what makes a crop a *re-frame* rather than a hole: the part that is left
 * fills the box, and `drawMediaClips` hands the same source rectangle to `drawImage` on both the preview
 * and the export, so the two cannot disagree about which pixels survived.
 *
 * **`layer` is the stacking order, and it is not the clock.** Two clips that overlap in time also
 * overlap on the frame, and which one wins is a decision the user makes ("put the badge over the banner")
 * rather than one the clock makes for them. Keeping the list sorted by time would make stacking a
 * side-effect of when a clip happens to start, so `layer` is stored per clip and `drawOrder()` is what
 * every painter and hit test reads. A project written before clips had layers reads as all-zero layers,
 * which draws in list order — exactly what it drew when it was saved.
 *
 * **A clip is silent.** Its own soundtrack is not mixed into the programme — the master track loaded
 * under Sources is the programme's sound, and mixing a second stream would need a real mixer on both
 * the preview and the export path. Rather than half-do it, the UI says so plainly; when clips get
 * their own sound, this file will grow a `volume`/`muted` pair and both paths will honour it together.
 *
 * Everything here is pure, so the arithmetic the export depends on is unit-tested in Node.
 */

import { newSegmentId } from './id.js';
import { clamp, fitRect, isPlainObject } from '../util/math.js';

/** What can be layered over the picture today. Audio is deliberately absent — see the module note. */
export const MEDIA_KINDS = Object.freeze(['image', 'video']);

/**
 * How a clip's media is put into its box.
 *
 * `contain` and `cover` both come from `fitRect`, which preserves the media's own shape — the box may
 * be any shape at all and the picture inside it still cannot be distorted, which is what makes dragging
 * a handle safe. `stretch` is the third answer and it is a deliberate one: the media is drawn into the
 * box exactly, whatever that does to its shape. It is here because a person who wants a 16:9 clip to
 * become a square banner has no other way to ask for it, and an editor that refuses is an editor they
 * work around. Nothing else in this file infers it: a box never *becomes* stretched because a handle
 * was dragged, and `contain` stays the default.
 */
export const MEDIA_FITS = Object.freeze(['contain', 'cover', 'stretch']);

/** The shortest a clip may be. Below this it is a flicker, not a shot. */
export const MIN_CLIP = 0.1;

/** The smallest box a clip may be squeezed to, as a fraction of the frame. */
export const MIN_BOX = 0.04;

/** How wide a clip's box is when it is first added, as a fraction of the frame width. */
export const DEFAULT_BOX_WIDTH = 0.4;

/** How long a clip is when its own file has no length to copy (an image, or a broken container). */
export const DEFAULT_CLIP_SECONDS = 5;

/**
 * The whole file, uncropped. The default, and the value a reset puts back.
 *
 * Frozen because it is handed out as-is in a couple of places and a crop object that some caller could
 * scribble on would be a crop that changes under the renderer's feet.
 */
export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/**
 * The smallest crop, as a fraction of the media. Below this it is a speck, not a picture.
 *
 * A *fraction* floor rather than a pixel one, because the model has to hold a crop for a file nobody
 * has measured yet. It is deliberately far below `MIN_CROP_PX` so that it never becomes the real floor:
 * wherever the file's size is known (the panel and the preview) the whole-pixel minimum governs, and a
 * 0.05% strip of a 4000 px picture — 2 px — is smaller than the 8 px a hand can still grab. The earlier
 * 2% floor was 80 px on the same file, which is too coarse to cut a logo out of a screenshot.
 */
export const MIN_CROP = 0.0005;

/**
 * The smallest crop, in the file's own pixels.
 *
 * Eight pixels is the smallest region that can still be seen and grabbed: below it a crop is a line,
 * and a line is something a hand cannot recover by dragging. Every pixel-editing path (the panel's
 * fields, the preview's handles) refuses to go under it, so "as small as it goes" is one number rather
 * than a different fraction on every file.
 */
export const MIN_CROP_PX = 8;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * A rotation in degrees, wrapped into `(-180, 180]`. Pure.
 *
 * Wrapped rather than clamped, because -90 and 270 are the same angle and two clips that look
 * identical should store the same number; and a forty-turn drag should not leave `14400` in a project
 * file. Zero is exact, so "not rotated" is one value and not a range that `=== 0` misses.
 */
export function normalizeRotation(value) {
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return 0;
  let wrapped = (((degrees + 180) % 360) + 360) % 360 - 180;
  // The half-open end is (-180, 180] rather than [-180, 180): 180 and -180 are the same half-turn and
  // only one of them is stored.
  if (wrapped === -180) wrapped = 180;
  return Math.abs(wrapped) < 1e-9 ? 0 : wrapped;
}

/** The media type a file is, or `null` when it is not one this studio can layer. Pure. */
export function kindFromFile(file) {
  const type = String(file?.type ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  // A browser that does not know the MIME still gives the name, and the name is usually right.
  const name = String(file?.name ?? '').toLowerCase();
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/.test(name)) return 'image';
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/.test(name)) return 'video';
  return null;
}

/**
 * A crop rectangle, in fractions of the media's own pixels. Pure.
 *
 * Clamped to the file and never inside out, because a crop that runs off the edge of the picture is not
 * a crop: the source rectangle handed to `drawImage` would be partly outside the image, and browsers
 * answer that by drawing nothing at all — a clip that vanishes because a slider went one step too far.
 */
export function normalizeCrop(value) {
  const c = isPlainObject(value) ? value : {};
  const x = clamp(finite(c.x) ? c.x : 0, 0, 1 - MIN_CROP);
  const y = clamp(finite(c.y) ? c.y : 0, 0, 1 - MIN_CROP);
  const w = clamp(finite(c.w) ? c.w : 1, MIN_CROP, 1 - x);
  const h = clamp(finite(c.h) ? c.h : 1, MIN_CROP, 1 - y);
  return { x, y, w, h };
}

/** Whether a crop is the whole file. Exact, so "is it cropped" needs no tolerance. Pure. */
export function isFullCrop(crop) {
  return crop?.x === 0 && crop?.y === 0 && crop?.w === 1 && crop?.h === 1;
}

/**
 * The aspect ratios a crop can be held to, as the list the panel's picker shows. Pure data.
 *
 * `free` and `source` are not numbers: free is "no constraint", and source is the file's own ratio,
 * which is what "Original" means and which cannot be written down without the file. The rest are the
 * ratios a person actually asks for — a square avatar, the two verticals the shorts apps publish, and
 * the cinema width.
 */
export const CROP_ASPECTS = Object.freeze([
  Object.freeze({ id: 'free', label: 'Free' }),
  Object.freeze({ id: 'source', label: 'Original' }),
  Object.freeze({ id: '1:1', label: '1:1', ratio: 1 }),
  Object.freeze({ id: '16:9', label: '16:9', ratio: 16 / 9 }),
  Object.freeze({ id: '9:16', label: '9:16', ratio: 9 / 16 }),
  Object.freeze({ id: '4:3', label: '4:3', ratio: 4 / 3 }),
  Object.freeze({ id: '3:4', label: '3:4', ratio: 3 / 4 }),
  Object.freeze({ id: '3:2', label: '3:2', ratio: 3 / 2 }),
  Object.freeze({ id: '2:3', label: '2:3', ratio: 2 / 3 }),
  Object.freeze({ id: '21:9', label: '21:9', ratio: 21 / 9 }),
]);

/** A media's size, as whole pixels, or zeros. Pure. */
function mediaPixels(media) {
  return {
    width: Math.max(0, Math.round(Number(media?.width) || 0)),
    height: Math.max(0, Math.round(Number(media?.height) || 0)),
  };
}

/**
 * The crop as a rectangle **in whole file pixels** — the numbers the panel shows and the handles cut on.
 *
 * Stored as fractions (so a project file does not depend on one decode of one file), but edited and
 * displayed as pixels, because a fraction of a 3840 px file is not a number anyone can act on. The
 * rectangle is rounded and clamped to the file, so a crop read back out of here is always a region the
 * `drawImage` call can actually take — no half pixels, and never an edge past the last column.
 *
 * A media nobody has measured answers `0×0×0×0`: there are no pixels to name yet.
 */
export function cropPixels(crop, media) {
  const { width, height } = mediaPixels(media);
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const c = normalizeCrop(crop);
  const x = clamp(Math.round(c.x * width), 0, Math.max(0, width - 1));
  const y = clamp(Math.round(c.y * height), 0, Math.max(0, height - 1));
  const w = clamp(Math.round(c.w * width), 1, width - x);
  const h = clamp(Math.round(c.h * height), 1, height - y);
  return { x, y, w, h };
}

/**
 * Fractions from a crop **given in whole file pixels**. Pure.
 *
 * The inverse of `cropPixels`, plus the clamping that makes it safe as an edit: the size is held to the
 * file and never under `minPx`, and the origin is then slid back inside — so typing `3800` into X on a
 * 3840 px file leaves the crop where it fits rather than asking `drawImage` for columns that are not
 * there. A crop with no measured file is left alone.
 */
export function cropFromPixels(rect, media, { minPx = MIN_CROP_PX } = {}) {
  const { width, height } = mediaPixels(media);
  if (!(width > 0) || !(height > 0)) return normalizeCrop(null);
  const minW = Math.min(Math.max(1, Math.round(minPx)), width);
  const minH = Math.min(Math.max(1, Math.round(minPx)), height);
  // `width`/`height`, and `w`/`h` too: the model names rectangles `w`/`h` everywhere, and the canvas API
  // names them `width`/`height`. Accepting both means a caller holding `cropPixels()`'s answer does not
  // silently ask for a zero-sized crop and get the floor.
  const w = clamp(Math.round(Number(rect?.width ?? rect?.w) || 0) || minW, minW, width);
  const h = clamp(Math.round(Number(rect?.height ?? rect?.h) || 0) || minH, minH, height);
  const x = clamp(Math.round(Number(rect?.x) || 0), 0, width - w);
  const y = clamp(Math.round(Number(rect?.y) || 0), 0, height - h);
  return normalizeCrop({ x: x / width, y: y / height, w: w / width, h: h / height });
}

/** The pixel aspect of a crop — its ratio **as pixels**, which is the only ratio that ever matters. */
export function cropAspect(crop, media) {
  const p = cropPixels(crop, media);
  return p.w > 0 && p.h > 0 ? p.w / p.h : 0;
}

/**
 * Which picker entry a crop is currently on. Pure.
 *
 * Measured rather than remembered: a crop that happens to be 16:9 says 16:9, and one a handle was
 * dragged to says Free — which is the only honest answer, and the reason the ratio is not a stored
 * setting that could disagree with the rectangle it describes. `source` is checked before the named
 * ratios because a file's own shape is the answer a person chose when they picked "Original".
 */
export function cropAspectId(crop, media, { tolerance = 0.015 } = {}) {
  const aspect = cropAspect(crop, media);
  if (!(aspect > 0)) return 'free';
  const { width, height } = mediaPixels(media);
  const source = width > 0 && height > 0 ? width / height : 0;
  const near = (value) => value > 0 && Math.abs(aspect / value - 1) <= tolerance;
  if (near(source)) return 'source';
  const match = CROP_ASPECTS.find((entry) => entry.ratio && near(entry.ratio));
  return match ? match.id : 'free';
}

/**
 * The largest crop of `ratio` that fits inside the current crop, centred on it. Pure.
 *
 * Inside the *current* crop rather than inside the file on purpose: picking a ratio is a question about
 * the framing the user already chose ("make this a square"), and re-framing the whole file would throw
 * away the edges they had just lined up. The result is whole pixels, so the shape can be a pixel off a
 * perfect ratio — which is what any real image is.
 */
export function fitCropAspect(crop, media, ratio) {
  const { width, height } = mediaPixels(media);
  if (!(Number(ratio) > 0) || !(width > 0) || !(height > 0)) return normalizeCrop(crop);
  const p = cropPixels(crop, media);
  if (!(p.w > 0) || !(p.h > 0)) return normalizeCrop(crop);
  let w = p.w;
  let h = w / ratio;
  if (h > p.h) {
    h = p.h;
    w = h * ratio;
  }
  // The file is the outer bound: a ratio picker cannot ask for a crop larger than the picture.
  if (w > width) {
    w = width;
    h = w / ratio;
  }
  if (h > height) {
    h = height;
    w = h * ratio;
  }
  w = Math.max(Math.min(MIN_CROP_PX, width), Math.round(w));
  h = Math.max(Math.min(MIN_CROP_PX, height), Math.round(h));
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return cropFromPixels({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h }, media);
}

/**
 * Slide the crop window inside the file, by whole pixels. Pure.
 *
 * This is the gesture a precise crop needs and a set of inset sliders cannot express: keeping the shape
 * and moving the frame. The size never changes, and the window stops at the file's edges rather than
 * shrinking, because a pan that quietly resized the crop would be a different edit than the one asked
 * for.
 */
export function moveCrop(crop, media, dxPx = 0, dyPx = 0) {
  const { width, height } = mediaPixels(media);
  if (!(width > 0) || !(height > 0)) return normalizeCrop(crop);
  const p = cropPixels(crop, media);
  return cropFromPixels(
    {
      x: p.x + Math.round(Number(dxPx) || 0),
      y: p.y + Math.round(Number(dyPx) || 0),
      width: p.w,
      height: p.h,
    },
    media,
  );
}

/**
 * Resize the crop from its **top-left corner**, in whole pixels. Pure.
 *
 * `width`/`height` are the dimension the user typed or dragged; an omitted one stays as it is. With a
 * `ratio` the other dimension follows the one that was asked for, which is what a locked picker means —
 * and the origin stays put, so a number typed into W grows the crop rightwards instead of re-centring
 * it under the pointer.
 */
export function resizeCrop(crop, media, { width = null, height = null } = {}, { ratio = 0 } = {}) {
  const { width: fileWidth, height: fileHeight } = mediaPixels(media);
  if (!(fileWidth > 0) || !(fileHeight > 0)) return normalizeCrop(crop);
  const p = cropPixels(crop, media);
  const minW = Math.min(MIN_CROP_PX, fileWidth);
  const minH = Math.min(MIN_CROP_PX, fileHeight);
  // `null`/`undefined` mean "this dimension was not asked about" — `Number(null)` is `0`, which would
  // read as a request for a zero-wide crop and then clamp to the floor. One of the two must be a real
  // number for the call to mean anything; the other follows it, or stays as it was.
  const asked = (value) => (value === null || value === undefined || String(value).trim() === '' ? NaN : Number(value));
  const askW = asked(width);
  const askH = asked(height);
  let w = Number.isFinite(askW) ? askW : p.w;
  let h = Number.isFinite(askH) ? askH : p.h;
  if (Number(ratio) > 0) {
    if (Number.isFinite(askW) && !Number.isFinite(askH)) h = w / ratio;
    else if (Number.isFinite(askH) && !Number.isFinite(askW)) w = h * ratio;
    else if (Number.isFinite(askW) && Number.isFinite(askH)) h = w / ratio;
  }
  // Grown from the top-left, so the most either dimension may be is what is left of the file. This is
  // the difference between "resize" and "re-fit": widening a crop near the right edge stops at the edge
  // rather than jumping the crop back to the left one.
  w = clamp(Math.round(w), minW, Math.max(minW, fileWidth - p.x));
  h = clamp(Math.round(h), minH, Math.max(minH, fileHeight - p.y));
  if (Number(ratio) > 0) {
    if (w / h > ratio) h = Math.max(minH, Math.round(w / ratio));
    else w = Math.max(minW, Math.round(h * ratio));
    w = Math.min(w, Math.max(minW, fileWidth - p.x));
    h = Math.min(h, Math.max(minH, fileHeight - p.y));
  }
  return cropFromPixels({ x: p.x, y: p.y, width: w, height: h }, media);
}

/** The crop's four edges, in whole file pixels. `right`/`bottom` are exclusive, like `drawImage`. Pure. */
export function cropEdgesPx(crop, media) {
  const p = cropPixels(crop, media);
  return { left: p.x, top: p.y, right: p.x + p.w, bottom: p.y + p.h };
}

/**
 * Fractions from four pixel edges, clamped into the file with a pixel floor on each dimension. Pure.
 *
 * Edges rather than an origin and a size because that is how a drag on a handle is measured: the edges
 * that are not being dragged must land on exactly the pixels they started on, or a corner drag would
 * creep the opposite corner of the crop by a pixel per gesture.
 */
export function cropFromEdgesPx(edges, media, { minPx = MIN_CROP_PX } = {}) {
  const { width, height } = mediaPixels(media);
  if (!(width > 0) || !(height > 0)) return normalizeCrop(null);
  const minW = Math.min(Math.max(1, Math.round(minPx)), width);
  const minH = Math.min(Math.max(1, Math.round(minPx)), height);
  const left = clamp(Math.round(Number(edges?.left) || 0), 0, width - minW);
  const top = clamp(Math.round(Number(edges?.top) || 0), 0, height - minH);
  const right = clamp(Math.round(Number(edges?.right) || 0), left + minW, width);
  const bottom = clamp(Math.round(Number(edges?.bottom) || 0), top + minH, height);
  return normalizeCrop({
    x: left / width,
    y: top / height,
    w: (right - left) / width,
    h: (bottom - top) / height,
  });
}

/**
 * The crop as a rectangle **in the file's own pixels** — what `drawImage` needs. Pure.
 *
 * A media whose size is not known yet answers `0×0`: there is no source rectangle to take from a file
 * nobody has measured, and every caller skips a zero-sized draw. The rectangle is rounded to whole
 * pixels and never runs past the file: the source of a draw is a discrete grid, and a half-pixel source
 * is a resampled edge on every output frame — which is exactly the softness a pixel-precise crop is
 * meant to avoid.
 */
export function cropSourceRect(crop, media) {
  const width = Math.max(0, Math.round(Number(media?.width) || 0));
  const height = Math.max(0, Math.round(Number(media?.height) || 0));
  if (!(width > 0) || !(height > 0)) return { x: 0, y: 0, width: 0, height: 0 };
  const p = cropPixels(crop, media);
  return { x: p.x, y: p.y, width: p.w, height: p.h };
}

/**
 * The pixel aspect of what a clip actually shows: its crop, not its file. Pure.
 *
 * This is the ratio a shape-locked resize holds and the one the picture is fitted into the box by, and
 * the two must be the same number — a crop that changed the box's shape instead of the content's would
 * stretch the picture the first time someone used it.
 */
export function clipContentAspect(clip, media) {
  const width = (Number(media?.width) || 0) * normalizeCrop(clip?.crop).w;
  const height = (Number(media?.height) || 0) * normalizeCrop(clip?.crop).h;
  return width > 0 && height > 0 ? width / height : 0;
}

/** A box, clamped to the frame and never inside out. Pure. */
export function normalizeBox(value) {
  const box = isPlainObject(value) ? value : {};
  const w = clamp(finite(box.w) ? box.w : DEFAULT_BOX_WIDTH, MIN_BOX, 1);
  const h = clamp(finite(box.h) ? box.h : DEFAULT_BOX_WIDTH, MIN_BOX, 1);
  const x = clamp(finite(box.x) ? box.x : (1 - w) / 2, 0, 1 - w);
  const y = clamp(finite(box.y) ? box.y : (1 - h) / 2, 0, 1 - h);
  return { x, y, w, h };
}

/**
 * The box a file's own shape deserves, centred on the frame. Pure.
 *
 * A 4000×4000 logo on a 16:9 frame would be a square box; a 16:9 clip is a wide one. The box is
 * derived from the frame's own shape as well as the media's, because "40% of the width" means a very
 * different number of pixels in portrait and landscape — and getting that wrong is what makes an
 * inset look stretched on one ratio and tiny on the other.
 */
export function boxForMedia(media, canvas, { width = DEFAULT_BOX_WIDTH } = {}) {
  const mw = Math.max(0, Number(media?.width) || 0);
  const mh = Math.max(0, Number(media?.height) || 0);
  const cw = Math.max(0, Number(canvas?.width) || 0);
  const ch = Math.max(0, Number(canvas?.height) || 0);
  const w = clamp(width, MIN_BOX, 1);
  // Degenerate sizes fall back to the box itself rather than to NaN: a clip whose file could not be
  // measured is still drawn (as a placeholder box), not dropped.
  // A box `w` wide holds `w * canvasWidth` pixels across; at the media's own aspect that is
  // `(w * canvasWidth) / (mediaWidth / mediaHeight)` pixels tall, which as a fraction of the frame's
  // height is the expression below. A file whose size could not be read falls back to a square box
  // rather than to NaN: a placeholder is drawn, and nothing is silently dropped.
  const usable = mw > 0 && mh > 0 && cw > 0 && ch > 0;
  const aspect = usable ? mw / mh : 1;
  const height = usable ? clamp((w * cw) / (aspect * ch), MIN_BOX, 1) : w;
  return normalizeBox({ x: (1 - w) / 2, y: (1 - height) / 2, w, h: height });
}

/**
 * One clip, in canonical form — or `null` when the value cannot be one.
 *
 * A clip with no usable window is refused rather than repaired into something arbitrary: the caller
 * that added it can say why, and a clip drawn at a made-up time is worse than no clip.
 */
export function normalizeClip(value) {
  if (!isPlainObject(value)) return null;
  const kind = MEDIA_KINDS.includes(value.kind) ? value.kind : null;
  if (!kind) return null;
  const start = Math.max(0, finite(value.start) ? value.start : 0);
  const end = finite(value.end) ? value.end : start + MIN_CLIP;
  // The tolerance is not decoration. Trimming an edge clamps to exactly `MIN_CLIP`, and `6 - 5.9`
  // in binary floating point is `0.09999999999999964` — so a trim to the shortest allowed clip was
  // rejected as too short and silently did nothing at all.
  if (!(end - start >= MIN_CLIP - 1e-9)) return null;
  return {
    id: String(value.id || newSegmentId()),
    kind,
    name: String(value.name || (kind === 'image' ? 'image' : 'video')),
    start,
    end,
    // Where in the clip's *own* file its first frame is. Trimming a clip's head advances this, which
    // is what makes a head trim reveal rather than slide (see `trimMediaClip`).
    sourceIn: Math.max(0, finite(value.sourceIn) ? value.sourceIn : 0),
    box: normalizeBox(value.box),
    fit: MEDIA_FITS.includes(value.fit) ? value.fit : 'contain',
    opacity: clamp(finite(value.opacity) ? value.opacity : 1, 0, 1),
    // Clockwise degrees about the box's own centre. Zero for everything that has not been rotated, and
    // the same `0` a rotation back to square produces, so "is this clip rotated" needs no tolerance.
    rotation: normalizeRotation(value.rotation),
    // A mirror about the box's centre, per axis. Separate from `rotation` because a mirrored clip is
    // not a rotated one: the two read differently in the panel, and there is no angle that means
    // "flipped".
    flipX: value.flipX === true,
    flipY: value.flipY === true,
    // Which part of the file is shown. The whole file unless someone asked for less, so a project from
    // before cropping existed reads as uncropped — which is what it was.
    crop: normalizeCrop(value.crop),
    // Stacking order on the frame: 0 is the bottom. `null` means *no layer was ever recorded* — a clip
    // from before this field existed, or one a caller has just made and not placed yet — and everything
    // that reads it treats `null` as 0. That distinction is what lets `addMediaClip` put a new clip on
    // top while a clip handed back with `layer: 0` (a relink, an undo) stays exactly where it was.
    layer: finite(value.layer) ? Math.max(0, Math.round(value.layer)) : null,
  };
}

/**
 * A whole list, canonical: bad entries dropped, sorted by start. Pure.
 *
 * Sorted by *time*, because that is what the timeline lane, the clip list and "which clips are on at
 * `t`" all want to read. Stacking is `layer`'s job and is applied by `drawOrder()` where it matters.
 */
export function normalizeClips(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeClip)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The same clips, bottom layer first — the order a painter draws them in, and the order a hit test has
 * to search backwards through. Pure.
 *
 * The tie-break is the *list* index rather than the start time: a caller that has already put the list
 * in some order (the lane sorts by time, a project file is whatever was saved) should get that order
 * back for equal layers, so a list that has never been restacked draws exactly as it is stored.
 */
export function drawOrder(clips) {
  return (Array.isArray(clips) ? clips : [])
    .filter(Boolean)
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => (Number(a.clip.layer) || 0) - (Number(b.clip.layer) || 0) || a.index - b.index)
    .map((entry) => entry.clip);
}

/** The layer a new clip should land on: above everything already on the frame. Pure. */
export function topLayer(doc) {
  return mediaClips(doc).reduce((top, clip) => Math.max(top, Number(clip.layer) || 0), -1);
}

/**
 * Move a clip up or down the stack. `direction` is `up`, `down`, `front` or `back`. Pure (mutates `doc`).
 *
 * The stack is *renumbered* rather than the two clips trading places: after a drop of five clips the
 * layers would otherwise be 0, 1, 7, 8, 40, which is unreadable in a project file and makes "is this
 * the top one" a question about numbers nobody chose. `up`/`down` move by one place and are clamped at
 * the ends, so holding a button down is not an error.
 */
export function reorderClip(doc, id, direction) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  const ordered = drawOrder(mediaClips(doc));
  const from = ordered.findIndex((c) => c.id === clip.id);
  if (from < 0) return null;
  const last = ordered.length - 1;
  const to =
    direction === 'front' ? last : direction === 'back' ? 0 : direction === 'up' ? Math.min(last, from + 1) : Math.max(0, from - 1);
  if (to !== from) {
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
  }
  ordered.forEach((c, index) => {
    c.layer = index;
  });
  doc.media = normalizeClips(mediaClips(doc));
  return findClip(doc, clip.id);
}

/** Where a clip sits in the stack, one-based, and how many clips there are: `{ index, count }`. Pure. */
export function layerPosition(doc, id) {
  const ordered = drawOrder(mediaClips(doc));
  const index = ordered.findIndex((clip) => clip.id === id);
  return { index: index < 0 ? 0 : index + 1, count: ordered.length };
}

/**
 * A copy of a clip, on the same window and the same box, one layer above it. Pure.
 *
 * Its own id and its own layer, so the copy is a clip rather than a second view of one: nothing in the
 * document is shared between them, and moving or trimming the copy leaves the original alone. The
 * *bytes* are not part of the document (see `editor/media-library.js`), so the caller is the one that
 * has to register the file for the new id.
 */
export function duplicateClip(doc, id) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  const copy = normalizeClip({ ...clip, id: undefined, layer: topLayer(doc) + 1 });
  if (!copy) return null;
  ensureMedia(doc).push(copy);
  doc.media = normalizeClips(doc.media);
  return findClip(doc, copy.id);
}

/** Make sure a document has a clip list. An existing one is left as it is. */
export function ensureMedia(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (!Array.isArray(doc.media)) doc.media = [];
  return doc.media;
}

/** The clips of a document, canonical. Never throws on a document that has none. Pure. */
export function mediaClips(doc) {
  return Array.isArray(doc?.media) ? doc.media.filter(Boolean) : [];
}

/**
 * The clips covering `t`, bottom-to-top. Half-open `[start, end)`, like the cut ranges. Pure.
 *
 * Bottom-to-top because every caller paints them in the order it gets: the layer draws them one after
 * another, and the overlay's hit test walks the same list backwards to find the top one.
 */
export function clipsAt(doc, t) {
  const time = Number(t) || 0;
  return drawOrder(mediaClips(doc).filter((clip) => time >= clip.start && time < clip.end));
}

/** The clip with this id, or `null`. Pure. */
export function findClip(doc, id) {
  return mediaClips(doc).find((clip) => clip.id === id) ?? null;
}

/**
 * A clip for a file that was just loaded, placed at the playhead. Pure — the DOM work of reading the
 * file's size happens in `editor/media-library.js`, and this decides what that means for the programme.
 *
 * Its length is the media's own when the media has one, clipped to what is left of the programme; an
 * image (which has no length) gets `DEFAULT_CLIP_SECONDS`. A clip added at the very end of the
 * programme still gets a window rather than being refused: the user can drag it back, and refusing
 * would mean the button appears to do nothing.
 */
export function planClip({ entry, at = 0, canvas = null, limit = 0, id = null } = {}) {
  const start = Math.max(0, Number(at) || 0);
  const own = Math.max(0, Number(entry?.duration) || 0);
  const wanted = own > 0 ? own : DEFAULT_CLIP_SECONDS;
  const room = Number(limit) > 0 ? Math.max(MIN_CLIP, Number(limit) - start) : wanted;
  const length = Math.max(MIN_CLIP, Math.min(wanted, room));
  return normalizeClip({
    id: id ?? undefined,
    kind: entry?.kind === 'video' ? 'video' : 'image',
    name: entry?.name ?? 'clip',
    start,
    end: start + length,
    box: boxForMedia(entry, canvas),
  });
}

/**
 * Add a clip. Returns the stored clip, or `null` when it could not be one.
 *
 * A clip dropped on the programme goes on **top** of the stack, which is what dropping one over another
 * looks like it should do. A clip that arrives with a layer of its own (a project being re-opened, a
 * relink, an undo) keeps it.
 */
export function addMediaClip(doc, clip) {
  if (!doc) return null;
  const explicit = isPlainObject(clip) && finite(clip.layer);
  const next = normalizeClip(explicit ? clip : { ...clip, layer: topLayer(doc) + 1 });
  if (!next) return null;
  ensureMedia(doc).push(next);
  doc.media = normalizeClips(doc.media);
  return findClip(doc, next.id);
}

/** Change a clip in place. `id`, `kind` and `name` are kept; everything else is what was asked for. */
export function updateMediaClip(doc, id, patch = {}) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  const next = normalizeClip({ ...clip, ...patch, id: clip.id, kind: clip.kind, name: clip.name });
  if (!next) return clip;
  Object.assign(clip, next);
  doc.media = normalizeClips(doc.media);
  return findClip(doc, id);
}

export function removeMediaClip(doc, id) {
  const before = mediaClips(doc).length;
  if (!doc) return false;
  doc.media = mediaClips(doc).filter((clip) => clip.id !== id);
  return doc.media.length !== before;
}

/**
 * Slide a clip along the clock, keeping its length. Clamped at zero — a clip cannot start before the
 * programme does, and silently dropping the part that would have gone negative is how a drag backwards
 * turns into a mystery trim.
 */
export function moveMediaClip(doc, id, delta) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  const shift = Number(delta) || 0;
  const start = Math.max(0, clip.start + shift);
  return updateMediaClip(doc, id, { start, end: start + (clip.end - clip.start) });
}

/**
 * Move one edge of a clip. Pure arithmetic in `updateMediaClip`'s hands.
 *
 * The head is the interesting one: trimming it **advances the clip's own in-point by the same amount**,
 * so the frames that are left stay exactly where they were. That is what a trim means in every editor
 * a person has used — the alternative (keeping `sourceIn` and moving the window) would make the media
 * slide inside its own box, which reads as the clip moving when it was supposed to shrink.
 */
export function trimMediaClip(doc, id, edge, seconds) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  const value = Number(seconds);
  if (!finite(value)) return clip;
  if (edge === 'in') {
    const start = clamp(value, 0, clip.end - MIN_CLIP);
    const delta = start - clip.start;
    return updateMediaClip(doc, id, { start, sourceIn: Math.max(0, clip.sourceIn + delta) });
  }
  const end = Math.max(value, clip.start + MIN_CLIP);
  return updateMediaClip(doc, id, { end });
}

// ---------------------------------------------------------------------------
// the box and the rotation, as edits
// ---------------------------------------------------------------------------
//
// The preview's direct manipulation (`editor/canvas-overlay.js`) computes a *box* or an *angle* and
// calls one of these; it never writes to a clip itself. That is the same split the caption layer has —
// geometry in one place, the document in another — and it is what makes a drag, a panel slider and an
// imported project all end up as the same edit.

/** Put a clip's box somewhere. The box is normalized by the model, so an out-of-frame drag is safe. */
export function setClipBox(doc, id, box) {
  return updateMediaClip(doc, id, { box: normalizeBox(box) });
}

/** Turn a clip. Degrees, clockwise, about its own centre. */
export function rotateMediaClip(doc, id, degrees) {
  return updateMediaClip(doc, id, { rotation: normalizeRotation(degrees) });
}

/** Mirror a clip about its centre, on one axis. Toggles, because that is what a mirror button is. */
export function flipMediaClip(doc, id, axis = 'x') {
  const clip = findClip(doc, id);
  if (!clip) return null;
  const key = axis === 'y' ? 'flipY' : 'flipX';
  return updateMediaClip(doc, id, { [key]: !clip[key] });
}

/**
 * Fit a clip to the whole frame, the way CapCut's "fit to screen" does.
 *
 * Both answers are the same full-frame box; what differs is `fit`. `contain` fits the whole picture
 * inside the frame (letterboxed, nothing cropped), `cover` fills the frame with it (nothing letterboxed,
 * the overhang cropped). Neither changes the media's shape — only `stretch` can, and it is never chosen
 * here.
 */
export function fitClipToFrame(doc, id, { mode = 'contain' } = {}) {
  return updateMediaClip(doc, id, {
    box: { x: 0, y: 0, w: 1, h: 1 },
    fit: mode === 'cover' ? 'cover' : 'contain',
  });
}

/** Centre a clip's box on the frame, keeping its size. */
export function centerClipBox(doc, id) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  return updateMediaClip(doc, id, {
    box: { ...clip.box, x: (1 - clip.box.w) / 2, y: (1 - clip.box.h) / 2 },
  });
}

/**
 * Put a clip back the way it arrived: the box a dropped file gets, upright, unflipped, opaque.
 *
 * The box needs the media's own size and the frame's, because that is what `boxForMedia` derives the
 * shape from — the document has the frame, the media library has the file, and neither of them has
 * both, which is why they are arguments rather than state read in here.
 */
export function resetMediaClip(doc, id, { media = null, canvas = null } = {}) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  return updateMediaClip(doc, id, {
    box: boxForMedia(media ?? { width: 0, height: 0 }, canvas),
    fit: 'contain',
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    // The whole file back: "reset" has to mean the picture as it arrived, and a crop left behind would be
    // the one setting still quietly cutting the shot.
    crop: FULL_CROP,
  });
}

/**
 * Crop a clip: which part of its own file is shown, as fractions of that file.
 *
 * A patch rather than four arguments, because the preview's crop handles and the panel's sliders both
 * compute a rectangle and neither should have to know the other's order. Normalised on the way in, so a
 * drag past the edge of the picture clamps there instead of asking `drawImage` for pixels that are not in
 * the file.
 */
export function cropMediaClip(doc, id, patch = {}) {
  const clip = findClip(doc, id);
  if (!clip) return null;
  return updateMediaClip(doc, id, { crop: normalizeCrop({ ...clip.crop, ...patch }) });
}

/** The whole file back. Pure arithmetic in `updateMediaClip`'s hands. */
export function resetClipCrop(doc, id) {
  return updateMediaClip(doc, id, { crop: FULL_CROP });
}

/**
 * The aspect ratio, in **pixels**, a clip's box currently has — what a shape-locked resize preserves.
 *
 * Fractions and pixels are different ratios on any frame that is not square: a box 0.5 wide and 0.5 tall
 * is 16:9 on a 1920×1080 frame and 9:16 on a phone. Every shape question on screen is a pixel question,
 * so this is the number the overlay is handed and the number it hands back.
 */
export function clipPixelAspect(clip, size) {
  const w = (Number(clip?.box?.w) || 0) * (Number(size?.width) || 0);
  const h = (Number(clip?.box?.h) || 0) * (Number(size?.height) || 0);
  return w > 0 && h > 0 ? w / h : 1;
}

/** A clip's length in seconds. Pure. */
export function clipLength(clip) {
  return Math.max(0, (Number(clip?.end) || 0) - (Number(clip?.start) || 0));
}

/** How far into its own file a clip is at source time `t`. Pure. */
export function clipSourceTime(clip, t) {
  return Math.max(0, (Number(clip?.sourceIn) || 0) + ((Number(t) || 0) - (Number(clip?.start) || 0)));
}

/** The pixel rectangle a box covers on a frame of `size`. Pure. */
export function boxRect(box, size) {
  const w = Math.max(0, Number(size?.width) || 0);
  const h = Math.max(0, Number(size?.height) || 0);
  const b = normalizeBox(box);
  return { x: b.x * w, y: b.y * h, width: b.w * w, height: b.h * h };
}

/**
 * Where a clip is actually painted on a frame — the box, with the media fitted inside it. Pure.
 *
 * `contain` is the default and the reason the shape cannot be wrong: the drawn rectangle comes from
 * `fitRect`, which preserves the media's aspect ratio, so a clip is never stretched however its box
 * was dragged. `stretch` is the one setting that hands the box to `drawImage` whole (see `MEDIA_FITS`),
 * and it is the only path through this function that can change a picture's shape.
 */
export function clipDrawRect(clip, media, size) {
  const box = boxRect(clip?.box, size);
  // The picture that has to be fitted is the *crop*, not the file: it is what the clip actually shows, and
  // it is the shape the fit has to preserve.
  const crop = normalizeCrop(clip?.crop);
  const width = (Number(media?.width) || 0) * crop.w;
  const height = (Number(media?.height) || 0) * crop.h;
  // Stretch needs no measurement at all: the box *is* the drawn rectangle. It is taken before the guard
  // below so that a media whose own size is unknown still fills its box when stretch was asked for —
  // stretched pixels of an unmeasured file are what the user asked for, and an empty rectangle would be
  // this function quietly overriding them. (Nothing is painted until the file decodes either way: an
  // element with no frame yet draws nothing, and the caller's `try` around `drawImage` is what says so.)
  if (clip?.fit === 'stretch') {
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  // A media whose size is not known yet — an element whose metadata has not arrived, a file that could
  // not be decoded — draws **nothing**. `fitRect` would answer this case with the whole box, which
  // would stretch an unknown picture to fill it; an empty rectangle is the honest answer, and every
  // caller skips a zero-sized draw.
  if (!(width > 0) || !(height > 0) || !(box.width > 0) || !(box.height > 0)) {
    return { x: box.x, y: box.y, width: 0, height: 0 };
  }
  const fitted = fitRect(
    { width, height },
    { width: box.width, height: box.height },
    { mode: clip?.fit === 'cover' ? 'cover' : 'contain' },
  );
  return { x: box.x + fitted.x, y: box.y + fitted.y, width: fitted.width, height: fitted.height };
}

/** One line describing a clip, for a tooltip or a row. Pure. */
export function describeClip(clip) {
  const name = clip?.name || 'clip';
  if (!clip) return name;
  return `${name} — ${clip.kind}, ${clipLength(clip).toFixed(2)}s (${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s)`;
}
