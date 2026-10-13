/**
 * media-model.test.js — the overlay clips: their windows, their boxes, and the arithmetic the export
 * depends on.
 *
 * `model/media.js` is pure on purpose, because the two things a clip can get wrong are the two things
 * a person notices: *when* it appears (a window on the programme's clock) and *where* it lands (a box
 * on the frame that must never distort the media inside it). Both are decided here, so both are
 * checked here rather than by looking at a rendered frame.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BOX_WIDTH,
  MIN_BOX,
  MIN_CLIP,
  addMediaClip,
  boxForMedia,
  boxRect,
  clipDrawRect,
  clipLength,
  clipSourceTime,
  clipsAt,
  describeClip,
  ensureMedia,
  findClip,
  kindFromFile,
  mediaClips,
  moveMediaClip,
  normalizeBox,
  normalizeClip,
  normalizeClips,
  planClip,
  removeMediaClip,
  trimMediaClip,
  updateMediaClip,
} from '../../src/model/media.js';

const canvas = { width: 1920, height: 1080 };
const entry = { kind: 'image', name: 'logo.png', width: 400, height: 400, duration: 0 };
const video = { kind: 'video', name: 'b-roll.mp4', width: 1280, height: 720, duration: 4 };

const clip = (over = {}) =>
  normalizeClip({ id: 'c1', kind: 'image', name: 'logo.png', start: 2, end: 6, ...over });

// --------------------------------------------------------------------------- //
// what a file is
// --------------------------------------------------------------------------- //

test('a file is an image or a video by its type, or by its name when the type is missing', () => {
  assert.equal(kindFromFile({ type: 'image/png', name: 'a.png' }), 'image');
  assert.equal(kindFromFile({ type: 'video/mp4', name: 'a.mp4' }), 'video');
  // A browser that hands over no MIME still gives a name, and the name is usually right.
  assert.equal(kindFromFile({ name: 'logo.WEBP' }), 'image');
  assert.equal(kindFromFile({ name: 'clip.mov' }), 'video');
  assert.equal(kindFromFile({ type: 'audio/mpeg', name: 'song.mp3' }), null, 'audio is not layered yet');
  assert.equal(kindFromFile({ name: 'notes.txt' }), null);
  assert.equal(kindFromFile(null), null);
});

// --------------------------------------------------------------------------- //
// a clip's window
// --------------------------------------------------------------------------- //

test('a clip is refused rather than repaired when its window cannot mean anything', () => {
  assert.equal(normalizeClip(null), null);
  assert.equal(normalizeClip({ start: 3, end: 9 }), null, 'no kind is not a clip');
  assert.equal(normalizeClip({ kind: 'audio', start: 0, end: 5 }), null, 'audio clips are not layered');
  assert.equal(normalizeClip({ kind: 'image', start: 5, end: 5 }), null, 'a zero-length clip is a flicker');
  assert.equal(normalizeClip({ kind: 'image', start: 5, end: 5.05 }), null, `under ${MIN_CLIP}s is refused`);
});

test('a clip keeps its identity and gets sane defaults', () => {
  const made = normalizeClip({ id: 'keep-me', kind: 'video', name: 'b.mp4', start: -4, end: 3 });
  assert.equal(made.id, 'keep-me');
  assert.equal(made.start, 0, 'a negative start is clamped, not accepted');
  assert.equal(made.sourceIn, 0);
  assert.equal(made.fit, 'contain', 'contain by default — a clip is never stretched');
  assert.equal(made.opacity, 1);
  assert.ok(made.box.w > 0 && made.box.h > 0);
});

test('a list of clips is canonical: bad entries dropped, ordered by when they start', () => {
  const list = normalizeClips([
    { kind: 'image', name: 'late', start: 8, end: 10 },
    { kind: 'nonsense', start: 0, end: 2 },
    { kind: 'image', name: 'early', start: 1, end: 3 },
  ]);
  assert.deepEqual(list.map((c) => c.name), ['early', 'late']);
});

test('the clips at a time are the ones whose window covers it, and a boundary belongs to the later one', () => {
  const doc = { media: normalizeClips([{ kind: 'image', name: 'a', start: 1, end: 3 }]) };
  assert.equal(clipsAt(doc, 0.9).length, 0);
  assert.equal(clipsAt(doc, 1).length, 1);
  assert.equal(clipsAt(doc, 2.99).length, 1);
  assert.equal(clipsAt(doc, 3).length, 0, 'the end of a clip is not inside it');
  assert.deepEqual(clipsAt({}, 1), [], 'a document with no clips answers without throwing');
});

test('a clip is timed on the programme clock and reads its own file from its in-point', () => {
  const c = clip({ start: 10, end: 14, sourceIn: 1.5, kind: 'video', name: 'b-roll.mp4' });
  assert.equal(clipSourceTime(c, 10), 1.5, 'the first frame of the clip is its in-point');
  assert.equal(clipSourceTime(c, 12), 3.5);
  assert.equal(clipLength(c), 4);
  assert.match(describeClip(c), /b-roll\.mp4 — video, 4\.00s \(10\.00s → 14\.00s\)/);
});

test('a clip placed at the playhead takes its own length, or a default when it has none', () => {
  const videoClip = planClip({ entry: video, at: 12, canvas, limit: 100 });
  assert.equal(videoClip.start, 12);
  assert.equal(videoClip.end, 16, "a video brings its own length");

  const imageClip = planClip({ entry, at: 12, canvas, limit: 100 });
  assert.equal(imageClip.end, 17, 'an image has no length, so it gets a usable default');
  assert.equal(imageClip.kind, 'image');

  const atTheEnd = planClip({ entry: video, at: 98, canvas, limit: 100 });
  assert.equal(atTheEnd.end, 100, 'a clip is fitted into what is left of the programme');
  assert.ok(clipLength(atTheEnd) >= MIN_CLIP);
});

test('moving a clip keeps its length and cannot slide it before the programme starts', () => {
  const doc = { media: [clip({ start: 2, end: 6 })] };
  moveMediaClip(doc, 'c1', 3);
  assert.deepEqual([doc.media[0].start, doc.media[0].end], [5, 9]);

  moveMediaClip(doc, 'c1', -20);
  assert.deepEqual([doc.media[0].start, doc.media[0].end], [0, 4], 'clamped at zero, still four seconds long');
  assert.equal(clipLength(doc.media[0]), 4, 'a drag backwards must not become a trim');
});

test('trimming a clip head reveals its own frames instead of sliding them', () => {
  const doc = { media: [clip({ start: 2, end: 6, kind: 'video' })] };
  trimMediaClip(doc, 'c1', 'in', 3.5);
  assert.equal(doc.media[0].start, 3.5);
  assert.equal(doc.media[0].sourceIn, 1.5, "the clip's in-point advanced with the head");
  assert.equal(clipSourceTime(doc.media[0], 3.5), 1.5, 'and the same frame is still at the same moment');

  trimMediaClip(doc, 'c1', 'out', 5);
  assert.equal(doc.media[0].end, 5);
  assert.equal(doc.media[0].sourceIn, 1.5, 'the tail trim leaves the in-point alone');
});

test('a trim cannot turn a clip inside out', () => {
  const doc = { media: [clip({ start: 2, end: 6 })] };
  trimMediaClip(doc, 'c1', 'in', 99);
  // A tolerance, not a round number: `6 - 0.1` is `5.9000000000000004` and the length of the result is
  // `0.09999999999999964`, which is the shortest clip *intended*, not one a hair under it. The model
  // carries the same 1e-9 everywhere for that reason.
  assert.ok(clipLength(doc.media[0]) >= MIN_CLIP - 1e-9, `trimmed to ${clipLength(doc.media[0])}s`);
  assert.equal(doc.media[0].start, 6 - MIN_CLIP);
  trimMediaClip(doc, 'c1', 'out', -5);
  assert.equal(doc.media[0].end, doc.media[0].start + MIN_CLIP, 'the tail cannot cross the head');
});

test('a head trim never leaves the clip promising frames before its file begins', () => {
  const doc = { media: [clip({ start: 2, end: 6, kind: 'video' })] };
  trimMediaClip(doc, 'c1', 'in', 1);
  assert.equal(doc.media[0].sourceIn, 0, 'dragging the head earlier cannot ask for negative time');
  assert.equal(doc.media[0].start, 1);
});

test('adding, changing and removing clips keeps the list canonical', () => {
  const doc = {};
  assert.deepEqual(ensureMedia(doc), []);
  addMediaClip(doc, { id: 'b', kind: 'image', name: 'b', start: 9, end: 12 });
  addMediaClip(doc, { id: 'a', kind: 'image', name: 'a', start: 1, end: 3 });
  assert.deepEqual(mediaClips(doc).map((c) => c.id), ['a', 'b']);
  assert.equal(addMediaClip(doc, { kind: 'nonsense' }), null, 'a bad clip adds nothing');

  updateMediaClip(doc, 'a', { opacity: 0.5, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
  assert.equal(findClip(doc, 'a').opacity, 0.5);
  assert.equal(findClip(doc, 'a').id, 'a', 'the id survives an update');
  assert.equal(updateMediaClip(doc, 'nope', { opacity: 0.2 }), null);

  assert.equal(removeMediaClip(doc, 'a'), true);
  assert.equal(removeMediaClip(doc, 'a'), false, 'removing twice is not an error');
  assert.deepEqual(mediaClips(doc).map((c) => c.id), ['b']);
});

// --------------------------------------------------------------------------- //
// a clip's box
// --------------------------------------------------------------------------- //

test('a box is clamped into the frame and can never be inside out', () => {
  assert.deepEqual(normalizeBox({ x: -1, y: -1, w: 0.5, h: 0.5 }), { x: 0, y: 0, w: 0.5, h: 0.5 });
  assert.deepEqual(normalizeBox({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  const tiny = normalizeBox({ w: 0.001, h: 0.001 });
  assert.equal(tiny.w, MIN_BOX);
  assert.deepEqual(normalizeBox(undefined), normalizeBox({ w: DEFAULT_BOX_WIDTH, h: DEFAULT_BOX_WIDTH }));
});

test("a clip's first box has the media's own shape", () => {
  const square = boxForMedia({ width: 400, height: 400 }, canvas);
  assert.equal(square.w, DEFAULT_BOX_WIDTH);
  // 0.4 of 1920 px = 768 px across; a square is 768 px tall, which on a 1080 px frame is 0.711 of it.
  assert.ok(Math.abs(square.h - (0.4 * 1920) / 1080) < 1e-9);
  assert.equal(square.x, (1 - square.w) / 2, 'and it is centred');
  assert.equal(square.y, (1 - square.h) / 2);

  const wide = boxForMedia({ width: 1280, height: 720 }, canvas);
  const wideAspect = (wide.w * canvas.width) / (wide.h * canvas.height);
  assert.ok(Math.abs(wideAspect - 1280 / 720) < 1e-6, 'the box holds the media aspect');

  const portraitFrame = boxForMedia({ width: 400, height: 400 }, { width: 1080, height: 1920 });
  assert.ok(portraitFrame.h < square.h, 'the same clip is a shorter band on a portrait frame');
});

test('a file with no readable size still gets a box rather than a NaN', () => {
  const box = boxForMedia({ width: 0, height: 0 }, canvas);
  assert.equal(box.w, DEFAULT_BOX_WIDTH);
  assert.ok(Number.isFinite(box.h) && box.h > 0);
  assert.ok(Number.isFinite(boxForMedia(null, null).h), 'and so does no media on no canvas');
});

test('a box becomes pixels, and the media inside it keeps its shape', () => {
  const size = { width: 1000, height: 500 };
  assert.deepEqual(boxRect({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, size), {
    x: 500,
    y: 125,
    width: 250,
    height: 250,
  });

  // A square clip inside a 2:1 box (500×250 px) is letterboxed *sideways* inside it, never stretched.
  const drawn = clipDrawRect({ box: { x: 0, y: 0, w: 0.5, h: 0.5 }, fit: 'contain' }, { width: 200, height: 200 }, size);
  assert.equal(drawn.width, 250);
  assert.equal(drawn.height, 250);
  assert.equal(drawn.x, 125, 'centred inside the box it was given');
  assert.equal(drawn.y, 0);

  const covered = clipDrawRect({ box: { x: 0, y: 0, w: 0.5, h: 0.5 }, fit: 'cover' }, { width: 200, height: 200 }, size);
  assert.equal(covered.width, 500, 'cover fills the box instead');
  assert.equal(covered.height, 500);
  assert.equal(covered.x, 0);
  assert.equal(covered.y, -125, 'and hangs outside it, which is what cover means');
});

test('a clip with no readable size draws nothing rather than a stretched rectangle', () => {
  const drawn = clipDrawRect({ box: { x: 0, y: 0, w: 0.5, h: 0.5 } }, null, { width: 1000, height: 500 });
  assert.equal(drawn.width, 0);
  assert.equal(drawn.height, 0);
});
