/**
 * model/timeline.js — which parts of the loaded media the programme actually keeps.
 *
 * The timeline is a list of **kept ranges of the source**, not a list of clips with positions. That
 * choice follows from what this studio is: the captions are timed against the source recording, so
 * the only clock that can line a caption up with the picture is the source clock. Storing clip
 * positions would introduce a *second* clock — and the moment the two disagree, a caption is drawn
 * over the wrong frame.
 *
 * So a cut is a *gap* in the source, not a ripple. Trimming the head of a three-minute clip leaves a
 * clip that still starts where it did; the removed part is simply no longer used:
 *
 *   source   |===============================================|
 *   kept     |       [=========)        [=====================|
 *   gaps              ^ removed               ^ removed
 *
 * Everything downstream reads the same two numbers per range — `srcIn` and `srcOut` — and maps
 * between them with the functions below:
 *
 *   * the **timeline strip** draws the ranges (and dims a caption that fell in a gap);
 *   * the **preview** skips a gap while playing, so a cut is a cut and not a wait;
 *   * the **export** walks the ranges, so the file is shorter by exactly the amount removed.
 *
 * Every function here is pure and dependency-free, so the arithmetic that decides what the exported
 * file contains is unit-tested in Node rather than eyeballed in a browser.
 */

import { newSegmentId } from './id.js';

/** The two tracks a project has. Both are cuts of the same single source file. */
export const TIMELINE_TRACKS = Object.freeze(['video', 'audio']);

/** The shortest a range may be trimmed to. Below this a range is noise, not a clip. */
export const MIN_RANGE = 0.05;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** The whole of a `duration`-long source, as a single range. Pure. */
export function fullRanges(duration) {
  const end = Math.max(0, Number(duration) || 0);
  if (!(end > 0)) return [];
  return [{ id: newSegmentId(), srcIn: 0, srcOut: end }];
}

/** One range, or `null` when the value is not a usable one. Pure. */
export function normalizeRange(value) {
  if (!value || typeof value !== 'object') return null;
  const srcIn = Math.max(0, finite(value.srcIn) ? value.srcIn : 0);
  const srcOut = finite(value.srcOut) ? value.srcOut : srcIn;
  if (!(srcOut - srcIn >= MIN_RANGE)) return null;
  return { id: String(value.id || newSegmentId()), srcIn, srcOut };
}

/**
 * A whole range list, sorted and made disjoint. Pure.
 *
 * Ranges are kept disjoint by *trimming* the overlap rather than by merging it away: two ranges that
 * overlap describe a region the user asked to keep and a region they did not, and quietly fusing them
 * would restore something that was deleted. A malformed file therefore loses the overlap, not the cut.
 */
export function normalizeRanges(value) {
  const sorted = (Array.isArray(value) ? value : [])
    .map(normalizeRange)
    .filter(Boolean)
    .sort((a, b) => a.srcIn - b.srcIn);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const srcIn = Math.max(range.srcIn, last.srcOut);
      if (!(range.srcOut - srcIn >= MIN_RANGE)) continue;
      out.push({ ...range, srcIn });
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/**
 * Make sure a document has a timeline, filling in the tracks that are missing.
 *
 * A track is only *created* here; an existing one is left exactly as it is, even when it is empty.
 * That distinction matters: `[]` is a real state ("this track has been cut away entirely"), and a
 * loader that could not tell it apart from "never set up" would resurrect a deleted track every time
 * the file was opened.
 *
 * @param {object} doc
 * @param {{video?:number, audio?:number}} [durations]
 * @returns {{video:object, audio:object}|null}
 */
export function ensureTimeline(doc, durations = {}) {
  if (!doc || typeof doc !== 'object') return null;
  const previous = doc.timeline && typeof doc.timeline === 'object' ? doc.timeline : {};
  const next = {};
  for (const track of TIMELINE_TRACKS) {
    const entry = previous[track];
    if (entry && Array.isArray(entry.ranges)) {
      next[track] = { sourceDuration: Math.max(0, Number(entry.sourceDuration) || 0), ranges: normalizeRanges(entry.ranges) };
    } else {
      const duration = Math.max(0, Number(durations[track]) || 0);
      next[track] = { sourceDuration: duration, ranges: fullRanges(duration) };
    }
  }
  doc.timeline = next;
  return next;
}

/** Put one track back to the whole source — what loading a new file into it means. */
export function resetTrack(doc, track, duration) {
  if (!doc) return null;
  ensureTimeline(doc);
  const end = Math.max(0, Number(duration) || 0);
  doc.timeline[track] = { sourceDuration: end, ranges: fullRanges(end) };
  return doc.timeline[track];
}

/** Replace one track's ranges (already-computed ones, normalized before assignment). */
export function setTrackRanges(doc, track, ranges) {
  if (!doc || !TIMELINE_TRACKS.includes(track)) return null;
  ensureTimeline(doc);
  doc.timeline[track] = {
    sourceDuration: doc.timeline[track]?.sourceDuration ?? 0,
    ranges: normalizeRanges(ranges),
  };
  return doc.timeline[track];
}

/**
 * A track's kept ranges.
 *
 * A document with no timeline at all — an older project, a unit test, a document built by hand —
 * reads as "the whole source", which is exactly what it meant before cuts existed. That fallback is
 * why every caller can ask without first checking whether a timeline is present.
 */
export function trackRanges(doc, track, duration = 0) {
  const entry = doc?.timeline?.[track];
  if (entry && Array.isArray(entry.ranges)) return entry.ranges;
  return fullRanges(duration);
}

export function rangeLength(range) {
  return Math.max(0, (Number(range?.srcOut) || 0) - (Number(range?.srcIn) || 0));
}

/** How long a track's kept material is, which is how long the export of it is. Pure. */
export function outputDuration(ranges) {
  return (Array.isArray(ranges) ? ranges : []).reduce((sum, range) => sum + rangeLength(range), 0);
}

/** The far end of a range list, i.e. how much of the source it reaches. Pure. */
export function totalSourceEnd(ranges) {
  return (Array.isArray(ranges) ? ranges : []).reduce(
    (max, range) => Math.max(max, Number(range?.srcOut) || 0),
    0,
  );
}

/** Is any part of the source missing? A whole-source track reports `false`. Pure. */
export function isTrimmed(ranges, duration = 0) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (list.length !== 1) return true;
  const [only] = list;
  return Math.abs(only.srcIn) > 1e-6 || Math.abs(only.srcOut - (Number(duration) || 0)) > 1e-6;
}

/** The index of the range holding source time `t`, or -1. Ranges are half-open [in, out). Pure. */
export function rangeIndexAt(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  for (let i = 0; i < list.length; i += 1) {
    if (t >= list[i].srcIn && t < list[i].srcOut) return i;
  }
  return -1;
}

/** True when `t` sits inside the source but outside every kept range. Pure. */
export function inGap(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (!list.length) return true;
  if (t < list[0].srcIn) return true;
  if (t >= totalSourceEnd(list)) return false; // past the end is the end, not a gap
  return rangeIndexAt(list, t) === -1;
}

/**
 * The source time playback should move to when it finds itself in a gap. Pure.
 *
 * Returns `t` unchanged when it is already inside a kept range, the next range's start when it is in
 * a gap, and `null` when there is nothing left to play.
 */
export function nextKeptSource(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  for (const range of list) {
    if (t < range.srcIn) return range.srcIn;
    if (t < range.srcOut) return t;
  }
  return null;
}

/** The last kept source time at or before `t`, used when seeking backwards into a gap. Pure. */
export function previousKeptSource(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  let best = null;
  for (const range of list) {
    if (range.srcIn <= t) best = Math.min(t, range.srcOut - 1e-3);
  }
  return best;
}

/** Where source time `t` lands in the exported programme, or `null` if it was cut away. Pure. */
export function sourceToOutput(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  let acc = 0;
  for (const range of list) {
    if (t < range.srcIn) return null;
    if (t <= range.srcOut) return acc + (t - range.srcIn);
    acc += rangeLength(range);
  }
  return null;
}

/** Where programme time `t` came from in the source, clamped into the last range past the end. Pure. */
export function outputToSource(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (!list.length) return null;
  let acc = 0;
  for (const range of list) {
    const length = rangeLength(range);
    if (t < acc + length) return range.srcIn + (t - acc);
    acc += length;
  }
  const last = list[list.length - 1];
  return last.srcOut;
}

// ---------------------------------------------------------------------------
// edits — each returns a *new* range list
// ---------------------------------------------------------------------------

/** Split the range holding `t` into two, so the halves can be cut independently. Pure. */
export function splitAt(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  const index = rangeIndexAt(list, t);
  if (index < 0) return list.map((r) => ({ ...r }));
  const range = list[index];
  if (!(t - range.srcIn >= MIN_RANGE && range.srcOut - t >= MIN_RANGE)) return list.map((r) => ({ ...r }));
  return [
    ...list.slice(0, index).map((r) => ({ ...r })),
    { ...range, srcOut: t },
    { ...range, id: newSegmentId(), srcIn: t },
    ...list.slice(index + 1).map((r) => ({ ...r })),
  ];
}

/** Everything before `t` is gone. Pure. */
export function cutBefore(ranges, t) {
  return normalizeRanges(
    (Array.isArray(ranges) ? ranges : [])
      .filter((range) => range.srcOut > t)
      .map((range) => ({ ...range, srcIn: Math.max(range.srcIn, t) })),
  );
}

/** Everything from `t` on is gone. Pure. */
export function cutAfter(ranges, t) {
  return normalizeRanges(
    (Array.isArray(ranges) ? ranges : [])
      .filter((range) => range.srcIn < t)
      .map((range) => ({ ...range, srcOut: Math.min(range.srcOut, t) })),
  );
}

/** Drop the whole range holding `t`. Pure. */
export function removeAt(ranges, t) {
  const list = Array.isArray(ranges) ? ranges : [];
  const index = rangeIndexAt(list, t);
  if (index < 0) return list.map((r) => ({ ...r }));
  return list.filter((_, i) => i !== index).map((r) => ({ ...r }));
}

/**
 * Move one edge of one range. Pure.
 *
 * Clamped against the neighbouring range rather than only against the source, because two ranges that
 * cross would describe a cut that no longer exists. `duration` is the source length, so the far end
 * cannot be dragged past the material that is actually there.
 */
export function trimEdge(ranges, index, edge, value, duration = 0) {
  const list = (Array.isArray(ranges) ? ranges : []).map((r) => ({ ...r }));
  const range = list[index];
  if (!range) return list;
  const previousEnd = index > 0 ? list[index - 1].srcOut : 0;
  const nextStart = index < list.length - 1 ? list[index + 1].srcIn : Number(duration) || Infinity;
  if (edge === 'in') {
    range.srcIn = Math.min(Math.max(Number(value) || 0, previousEnd), range.srcOut - MIN_RANGE);
  } else {
    range.srcOut = Math.max(Math.min(Number(value) || 0, nextStart), range.srcIn + MIN_RANGE);
  }
  return normalizeRanges(list);
}

// ---------------------------------------------------------------------------
// captions against the cut
// ---------------------------------------------------------------------------

/** How much of `[start, end)` the ranges keep. Pure. */
export function keptOverlap(ranges, start, end) {
  const from = Number(start) || 0;
  const to = Number(end) || 0;
  if (!(to > from)) return 0;
  let kept = 0;
  for (const range of Array.isArray(ranges) ? ranges : []) {
    kept += Math.max(0, Math.min(to, range.srcOut) - Math.max(from, range.srcIn));
  }
  return kept;
}

/**
 * Is this caption still on screen after the cut?
 *
 * A caption counts as kept when *most* of it survives, so a caption that barely clips the edge of a
 * removed region is not silently thrown away — and one that mostly fell into the gap is, because it
 * would otherwise appear over a picture that is not there.
 */
export function captionKept(ranges, block, cover = 0.5) {
  const start = Number(block?.start) || 0;
  const end = Number(block?.end) || 0;
  if (!(end > start)) return false;
  return keptOverlap(ranges, start, end) >= (end - start) * cover;
}

/** The ids of the captions the cut removed — what the strip dims and the export drops. Pure. */
export function droppedCaptionIds(doc) {
  const ranges = trackRanges(doc, 'video', 0);
  if (!ranges.length) return new Set((doc?.blocks ?? []).map((b) => b.id));
  const dropped = new Set();
  for (const block of doc?.blocks ?? []) {
    if (!captionKept(ranges, block)) dropped.add(block.id);
  }
  return dropped;
}
