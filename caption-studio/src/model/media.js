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
 * and the media is fitted *inside* it — `contain` by default, never stretched. Storing a centre point
 * and an aspect instead would make "resize without distorting" a rule every caller had to remember;
 * storing a box makes distortion impossible by construction, because the drawing code has nothing to
 * distort with. `boxForMedia()` is what turns a file's own size into a box that already has the right
 * shape, so the common case (drop a logo on, it looks like the logo) needs no dragging at all.
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

/** The shortest a clip may be. Below this it is a flicker, not a shot. */
export const MIN_CLIP = 0.1;

/** The smallest box a clip may be squeezed to, as a fraction of the frame. */
export const MIN_BOX = 0.04;

/** How wide a clip's box is when it is first added, as a fraction of the frame width. */
export const DEFAULT_BOX_WIDTH = 0.4;

/** How long a clip is when its own file has no length to copy (an image, or a broken container). */
export const DEFAULT_CLIP_SECONDS = 5;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

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
    fit: value.fit === 'cover' ? 'cover' : 'contain',
    opacity: clamp(finite(value.opacity) ? value.opacity : 1, 0, 1),
  };
}

/** A whole list, canonical: bad entries dropped, sorted by start (which is also z-order). Pure. */
export function normalizeClips(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeClip)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
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

/** The clips covering `t`, bottom-to-top. Half-open `[start, end)`, like the cut ranges. Pure. */
export function clipsAt(doc, t) {
  const time = Number(t) || 0;
  return mediaClips(doc).filter((clip) => time >= clip.start && time < clip.end);
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

/** Add a clip. Returns the stored clip, or `null` when it could not be one. */
export function addMediaClip(doc, clip) {
  const next = normalizeClip(clip);
  if (!next || !doc) return null;
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
 * was dragged.
 */
export function clipDrawRect(clip, media, size) {
  const box = boxRect(clip?.box, size);
  const width = Number(media?.width) || 0;
  const height = Number(media?.height) || 0;
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
