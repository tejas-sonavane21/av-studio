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
  MEDIA_FITS,
  MIN_BOX,
  MIN_CLIP,
  FULL_CROP,
  MIN_CROP,
  MIN_CROP_PX,
  CROP_ASPECTS,
  addMediaClip,
  boxForMedia,
  boxRect,
  centerClipBox,
  clipContentAspect,
  clipDrawRect,
  clipLength,
  clipPixelAspect,
  clipSourceTime,
  clipsAt,
  cropAspect,
  cropAspectId,
  cropEdgesPx,
  cropFromEdgesPx,
  cropFromPixels,
  cropMediaClip,
  cropPixels,
  cropSourceRect,
  fitCropAspect,
  moveCrop,
  resizeCrop,
  describeClip,
  drawOrder,
  duplicateClip,
  isFullCrop,
  normalizeCrop,
  resetClipCrop,
  ensureMedia,
  findClip,
  fitClipToFrame,
  flipMediaClip,
  kindFromFile,
  layerPosition,
  mediaClips,
  moveMediaClip,
  reorderClip,
  topLayer,
  normalizeBox,
  normalizeClip,
  normalizeClips,
  normalizeRotation,
  planClip,
  removeMediaClip,
  resetMediaClip,
  rotateMediaClip,
  setClipBox,
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

// --------------------------------------------------------------------------- //
// turning, mirroring and stretching one
// --------------------------------------------------------------------------- //

test('a rotation is wrapped into one half turn either way, and upright is exactly zero', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(45), 45);
  assert.equal(normalizeRotation(270), -90, 'a three-quarter turn is a quarter turn the other way');
  assert.equal(normalizeRotation(540), 180);
  assert.equal(normalizeRotation(-180), 180, 'and the half turn is stored one way round');
  assert.equal(normalizeRotation(-90), -90);
  assert.equal(normalizeRotation(-450), -90, 'a whole turn is not a rotation');
  assert.equal(normalizeRotation('nonsense'), 0);
  assert.equal(normalizeRotation(1e-12), 0, 'a rounding error is not a rotation');
  // Two clips that look identical store the same number: the point of wrapping rather than clamping.
  assert.equal(normalizeRotation(-90), normalizeRotation(270));
});

test('a clip carries its turn, its mirrors and its fit, and refuses a fit it does not know', () => {
  const turned = clip({ rotation: 370, flipX: true, fit: 'cover' });
  assert.equal(turned.rotation, 10);
  assert.equal(turned.flipX, true);
  assert.equal(turned.flipY, false, 'a mirror is per axis, and off unless asked for');
  assert.equal(turned.fit, 'cover');
  assert.deepEqual([...MEDIA_FITS], ['contain', 'cover', 'stretch']);
  assert.equal(clip({ fit: 'stretch' }).fit, 'stretch', 'stretch is a setting, not an accident');
  assert.equal(clip({ fit: 'squash' }).fit, 'contain', 'an unknown fit falls back rather than being trusted');
  // Booleans are not truthy-shaped: `flipX: 'yes'` is not a mirror, because nothing writes a string.
  assert.equal(clip({ flipX: 'yes' }).flipX, false);
});

test('stretch fills the box exactly, and is the only fit that can change a shape', () => {
  const size = { width: 1000, height: 500 };
  const square = { width: 200, height: 200 };
  const stretched = clipDrawRect({ box: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 }, fit: 'stretch' }, square, size);
  assert.deepEqual(stretched, { x: 100, y: 100, width: 400, height: 200 });
  const contained = clipDrawRect({ box: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 }, fit: 'contain' }, square, size);
  assert.deepEqual(contained, { x: 200, y: 100, width: 200, height: 200 }, 'contain letterboxes instead');
  // Stretch needs no measurement: the box *is* the rectangle, so an unmeasured file still fills it —
  // which is what was asked for, and the one case where an unknown size is not a reason to draw nothing.
  assert.deepEqual(
    clipDrawRect({ box: { x: 0, y: 0, w: 0.5, h: 0.5 }, fit: 'stretch' }, null, size),
    { x: 0, y: 0, width: 500, height: 250 },
  );
});

test('a box can be placed, turned, mirrored and put back, through the model', () => {
  const doc = { media: [clip()] };
  setClipBox(doc, 'c1', { x: 0.2, y: 0.3, w: 0.5, h: 0.25 });
  assert.deepEqual(findClip(doc, 'c1').box, { x: 0.2, y: 0.3, w: 0.5, h: 0.25 });
  setClipBox(doc, 'c1', { x: 99, y: -5, w: 0.5, h: 0.25 });
  assert.deepEqual(findClip(doc, 'c1').box, { x: 0.5, y: 0, w: 0.5, h: 0.25 }, 'the model keeps it on the frame');

  rotateMediaClip(doc, 'c1', 30);
  assert.equal(findClip(doc, 'c1').rotation, 30);
  rotateMediaClip(doc, 'c1', 405);
  assert.equal(findClip(doc, 'c1').rotation, 45, 'the angle is absolute, and a whole turn is dropped');
  rotateMediaClip(doc, 'c1', -90);
  assert.equal(findClip(doc, 'c1').rotation, -90);
  rotateMediaClip(doc, 'c1', 0);
  assert.equal(findClip(doc, 'c1').rotation, 0, 'and upright is one exact number');

  flipMediaClip(doc, 'c1', 'x');
  assert.equal(findClip(doc, 'c1').flipX, true);
  flipMediaClip(doc, 'c1', 'x');
  assert.equal(findClip(doc, 'c1').flipX, false, 'a mirror button toggles');
  flipMediaClip(doc, 'c1', 'y');
  assert.equal(findClip(doc, 'c1').flipY, true);
  assert.equal(findClip(doc, 'c1').flipX, false, 'and each axis is its own');

  assert.equal(rotateMediaClip(doc, 'nope', 30), null);
  assert.equal(flipMediaClip(doc, 'nope', 'x'), null);
  assert.equal(setClipBox(doc, 'nope', { w: 1, h: 1 }), null);
});

test('fit-to-frame, centre and reset are the three ways back to somewhere sensible', () => {
  const doc = { media: [clip()] };
  fitClipToFrame(doc, 'c1', { mode: 'contain' });
  assert.deepEqual(findClip(doc, 'c1').box, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(findClip(doc, 'c1').fit, 'contain', 'contain fits the whole picture inside the frame');
  fitClipToFrame(doc, 'c1', { mode: 'cover' });
  assert.equal(findClip(doc, 'c1').fit, 'cover', 'cover fills it and crops');

  setClipBox(doc, 'c1', { x: 0.05, y: 0.05, w: 0.2, h: 0.2 });
  centerClipBox(doc, 'c1');
  assert.deepEqual(findClip(doc, 'c1').box, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });

  rotateMediaClip(doc, 'c1', 45);
  flipMediaClip(doc, 'c1', 'x');
  updateMediaClip(doc, 'c1', { opacity: 0.4 });
  resetMediaClip(doc, 'c1', { media: entry, canvas });
  const back = findClip(doc, 'c1');
  assert.deepEqual(back.box, boxForMedia(entry, canvas), 'the box a dropped file gets');
  assert.equal(back.rotation, 0);
  assert.equal(back.flipX, false);
  assert.equal(back.opacity, 1);
  assert.equal(back.fit, 'contain');
  assert.equal(back.start, 2, 'and resetting the look does not move the clip in time');
});

test('a shape is held in pixels, which is the only ratio that means anything on screen', () => {
  const squareBox = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  assert.equal(clipPixelAspect({ box: squareBox }, { width: 1920, height: 1080 }), 16 / 9);
  assert.equal(clipPixelAspect({ box: squareBox }, { width: 1080, height: 1920 }), 9 / 16, 'the same box, a phone');
  assert.equal(clipPixelAspect({ box: { w: 0, h: 0 } }, canvas), 1, 'a degenerate box is not a division by zero');
});

// --------------------------------------------------------------------------- //
// the stack: which clip is on top where two overlap
// --------------------------------------------------------------------------- //

test('a new clip lands on top of the stack, and the stack is what draws', () => {
  const doc = { media: [], canvas };
  addMediaClip(doc, clip({ id: 'c1', start: 0, end: 5 }));
  addMediaClip(doc, clip({ id: 'c2', start: 1, end: 4 }));
  assert.equal(topLayer(doc), 1, 'the second clip is above the first');
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['c1', 'c2']);

  // Reordering renumbers rather than trading values, so the layers stay 0..n-1 after any number of moves.
  reorderClip(doc, 'c1', 'front');
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['c2', 'c1']);
  assert.deepEqual(mediaClips(doc).map((c) => c.layer).sort(), [0, 1]);
  assert.deepEqual(layerPosition(doc, 'c1'), { index: 2, count: 2 });

  // `up` at the top is a no-op rather than an error, so holding the button down cannot break anything.
  reorderClip(doc, 'c1', 'up');
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['c2', 'c1']);
  reorderClip(doc, 'c1', 'back');
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['c1', 'c2']);
  reorderClip(doc, 'c1', 'down');
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['c1', 'c2'], 'already at the back');
});

test('the stack is stored, not inferred from the clock', () => {
  // Two clips on the same second: the one added later is on top, however the list is sorted by time.
  const doc = { media: [], canvas };
  addMediaClip(doc, clip({ id: 'late', start: 3, end: 8 }));
  addMediaClip(doc, clip({ id: 'early', start: 1, end: 9 }));
  assert.deepEqual(mediaClips(doc).map((c) => c.id), ['early', 'late'], 'the list is still in time order');
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['late', 'early'], 'and the stack is not');
  // What is painted at a moment comes out bottom-to-top, which is the order a painter needs.
  assert.deepEqual(clipsAt(doc, 4).map((c) => c.id), ['late', 'early']);
  assert.deepEqual(clipsAt(doc, 0.5), [], 'nothing that early');
});

test('a clip from before layers existed has no layer recorded, and draws in list order', () => {
  const stored = [
    { id: 'a', kind: 'image', name: 'a.png', start: 0, end: 3 },
    { id: 'b', kind: 'image', name: 'b.png', start: 1, end: 4 },
  ];
  const list = normalizeClips(stored);
  assert.deepEqual(list.map((c) => c.layer), [null, null], 'null, not 0: no layer was ever chosen');
  assert.deepEqual(drawOrder(list).map((c) => c.id), ['a', 'b'], 'and it still draws as it always did');
  assert.equal(topLayer({ media: list }), 0);
  // A move through the stack is what gives them real numbers, from then on.
  reorderClip({ media: list }, 'b', 'front');
  assert.deepEqual(list.map((c) => c.layer).sort(), [0, 1]);
});

test('a duplicate is its own clip: own id, own layer, and the same window and box', () => {
  const doc = { media: [], canvas };
  addMediaClip(doc, clip({ id: 'c1', start: 2, end: 6, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, rotation: 30 }));
  const copy = duplicateClip(doc, 'c1');
  assert.ok(copy && copy.id !== 'c1', 'the copy has an id of its own');
  assert.deepEqual(copy.box, findClip(doc, 'c1').box);
  assert.equal(copy.rotation, 30);
  assert.equal(copy.start, 2);
  assert.equal(copy.end, 6);
  assert.equal(copy.layer, 1, 'and it goes above the original');
  // Editing one leaves the other alone, which is the whole point of a copy rather than a second name for
  // one clip.
  updateMediaClip(doc, copy.id, { opacity: 0.5 });
  assert.equal(findClip(doc, 'c1').opacity, 1);
  removeMediaClip(doc, copy.id);
  assert.equal(findClip(doc, 'c1').opacity, 1, 'and removing the copy removes the copy');
  assert.equal(mediaClips(doc).length, 1);
});

test('a clip that arrives with a layer keeps it, and one that does not goes on top', () => {
  const doc = { media: [], canvas };
  addMediaClip(doc, clip({ id: 'c1', start: 0, end: 4 }));
  // A relink or an undo hands back the clip it took out, layer and all: it must not jump to the top.
  addMediaClip(doc, { ...findClip(doc, 'c1'), id: 'c9', layer: 0, start: 9, end: 12 });
  assert.equal(findClip(doc, 'c9')?.layer, 0);
  assert.deepEqual(drawOrder(mediaClips(doc)).map((c) => c.id), ['c1', 'c9']);
});

// --------------------------------------------------------------------------- //
// the crop: which part of the file is shown
// --------------------------------------------------------------------------- //

test('a crop is on the file, and the picture it leaves is fitted without distorting it', () => {
  const doc = { media: [], canvas };
  addMediaClip(doc, clip({ id: 'c1' }));
  assert.deepEqual(findClip(doc, 'c1').crop, { x: 0, y: 0, w: 1, h: 1 }, 'the whole file until it is cut');
  assert.equal(isFullCrop(findClip(doc, 'c1').crop), true);

  // The left half of a 400x400 file is 200x400 — twice as tall as it is wide — and no box can change that.
  cropMediaClip(doc, 'c1', { x: 0, w: 0.5 });
  const c = findClip(doc, 'c1');
  assert.deepEqual(c.crop, { x: 0, y: 0, w: 0.5, h: 1 });
  assert.equal(isFullCrop(c.crop), false);
  assert.equal(clipContentAspect(c, entry), 0.5, 'the shape to hold is the crop, not the file');

  const size = { width: 1920, height: 1080 };
  const box = boxRect(c.box, size);
  const rect = clipDrawRect(c, entry, size);
  assert.equal(Math.round(rect.height), Math.round(box.height), 'the crop is fitted to the box as always');
  assert.equal(Math.round(rect.width), Math.round(box.height / 2), 'and its own shape decides the rest');

  // In the file's own pixels, which is exactly what the nine-argument drawImage is handed.
  assert.deepEqual(cropSourceRect(c.crop, entry), { x: 0, y: 0, width: 200, height: 400 });
  assert.deepEqual(cropSourceRect(c.crop, { width: 0, height: 0 }), { x: 0, y: 0, width: 0, height: 0 },
    'a file nobody has measured has no source rectangle to take');
});

test('a crop is clamped into the file, so a drag past the edge cannot blank the clip', () => {
  // The floor is a *fraction* so the model can hold a crop for an unmeasured file; the panel and the
  // preview work in whole pixels and apply `MIN_CROP_PX` on top. It is deliberately small (0.5%): 2% of
  // a 4000 px screenshot is 80 px, which is too coarse to cut a logo out of one.
  const floored = normalizeCrop({ x: -1, y: 2, w: 5, h: 0 });
  assert.deepEqual({ x: floored.x, y: floored.y, w: floored.w }, { x: 0, y: 1 - MIN_CROP, w: 1 });
  // A tolerance on the height rather than equality: it is `1 - y`, and a binarily tiny MIN_CROP is a
  // subtraction that does not land back on itself exactly.
  assert.ok(Math.abs(floored.h - MIN_CROP) < 1e-12, `the height floored at ${floored.h}`);
  // x = 0.9 leaves a tenth of the file's width, so a request for half of it is cut back to that tenth.
  // (Compared with a tolerance because a tenth is not a binary fraction: `1 - 0.9` is 0.0999..98.)
  const tight = normalizeCrop({ x: 0.9, y: 0, w: 0.5, h: 1 });
  assert.deepEqual({ x: tight.x, y: tight.y, h: tight.h }, { x: 0.9, y: 0, h: 1 });
  assert.ok(Math.abs(tight.w - 0.1) < 1e-9, `the width was clipped to the tenth left: ${tight.w}`);
  assert.deepEqual(normalizeCrop(undefined), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(normalizeCrop({ x: 0.5, w: 0.5 }), { x: 0.5, y: 0, w: 0.5, h: 1 });
});

test('resetting a clip puts the whole file back, and a copy carries the crop', () => {
  const doc = { media: [], canvas };
  addMediaClip(doc, clip({ id: 'c1' }));
  cropMediaClip(doc, 'c1', { x: 0.25, w: 0.5 });
  const copy = duplicateClip(doc, 'c1');
  assert.deepEqual(copy.crop, { x: 0.25, y: 0, w: 0.5, h: 1 }, 'a copy is a copy of the crop too');

  resetClipCrop(doc, 'c1');
  assert.deepEqual(findClip(doc, 'c1').crop, FULL_CROP);
  assert.deepEqual(findClip(doc, copy.id).crop, { x: 0.25, y: 0, w: 0.5, h: 1 }, 'and the copy keeps its own');

  cropMediaClip(doc, 'c1', { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  resetMediaClip(doc, 'c1', { media: entry, canvas });
  assert.deepEqual(findClip(doc, 'c1').crop, FULL_CROP, 'reset means the picture as it arrived');
});

// --------------------------------------------------------------------------- //
// the crop in whole file pixels: the numbers the panel shows and the handles cut on
// --------------------------------------------------------------------------- //

const FILE = { width: 800, height: 400 };

test('a crop is edited and read back in whole file pixels, never in half ones', () => {
  // A fraction of a 3840 px picture is not a number a person can check; the pixel rectangle is. Reading
  // it rounds, so the same 800×400 region is named the same way twice and `drawImage` is handed integers.
  assert.deepEqual(cropPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, FILE), { x: 200, y: 200, w: 400, h: 200 });
  assert.deepEqual(cropPixels({ x: 0.1234, y: 0.4321, w: 0.3333, h: 0.2222 }, FILE), {
    x: Math.round(0.1234 * 800),
    y: Math.round(0.4321 * 400),
    w: Math.round(0.3333 * 800),
    h: Math.round(0.2222 * 400),
  });
  assert.deepEqual(cropPixels(FULL_CROP, { width: 0, height: 0 }), { x: 0, y: 0, w: 0, h: 0 }, 'nothing to name yet');

  // And the other way: fractions that, multiplied back out, are exactly the pixels asked for.
  assert.deepEqual(cropPixels(cropFromPixels({ x: 100, y: 50, width: 200, height: 100 }, FILE), FILE), {
    x: 100,
    y: 50,
    w: 200,
    h: 100,
  });
  // A rectangle named the way the model names it (`w`/`h`) is read too: `cropPixels` answers in that
  // spelling, and a helper that takes it back must not read its size as zero.
  assert.deepEqual(cropPixels(cropFromPixels({ x: 100, y: 50, w: 200, h: 100 }, FILE), FILE), {
    x: 100,
    y: 50,
    w: 200,
    h: 100,
  });
  // A crop cannot be smaller than `MIN_CROP_PX`, and its origin is slid back inside the file — never
  // shrunk to fit, because "too far right" is a position and not a size.
  assert.deepEqual(cropPixels(cropFromPixels({ x: 0, y: 0, width: 1, height: 1 }, FILE), FILE), {
    x: 0,
    y: 0,
    w: MIN_CROP_PX,
    h: MIN_CROP_PX,
  });
  assert.deepEqual(cropPixels(cropFromPixels({ x: 9999, y: -50, width: 200, height: 100 }, FILE), FILE), {
    x: 600,
    y: 0,
    w: 200,
    h: 100,
  });
});

test('a ratio picker fits the largest rectangle of that shape inside the crop already framed', () => {
  const square = cropPixels(fitCropAspect(FULL_CROP, FILE, 1), FILE);
  assert.deepEqual(square, { x: 200, y: 0, w: 400, h: 400 }, 'a square from a 2:1 file is as tall as the file');
  assert.equal(cropAspect(fitCropAspect(FULL_CROP, FILE, 1), FILE), 1);

  // "Inside the current crop" is the whole point: the framing a person has lined up is kept, and only
  // its shape changes. Half the file, square: the largest square inside the left half.
  const half = cropPixels(fitCropAspect({ x: 0, y: 0, w: 0.5, h: 1 }, FILE, 1), FILE);
  assert.deepEqual(half, { x: 0, y: 0, w: 400, h: 400 });
  // And a free ratio is not a fit: it changes nothing.
  assert.deepEqual(fitCropAspect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, FILE, 0), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
});

test('the picker says what the rectangle is, and Original wins over a named ratio that matches it', () => {
  assert.equal(cropAspectId(FULL_CROP, FILE), 'source');
  assert.equal(cropAspectId({ x: 0.25, y: 0, w: 0.5, h: 1 }, FILE), '1:1');
  assert.equal(cropAspectId({ x: 0, y: 0, w: 0.5, h: 0.5 }, FILE), 'source', 'a half-width, half-height crop is still the file\u2019s shape');
  assert.equal(cropAspectId({ x: 0, y: 0, w: 0.3, h: 1 }, FILE), 'free', 'a shape nobody picked says Free');
  assert.equal(cropAspectId(FULL_CROP, { width: 0, height: 0 }), 'free', 'an unmeasured file has no shape to compare');
  // Every entry in the picker is reachable by its own ratio, so the list cannot drift from the maths.
  for (const entry of CROP_ASPECTS.filter((item) => item.ratio)) {
    assert.equal(cropAspectId(fitCropAspect(FULL_CROP, FILE, entry.ratio), FILE), entry.id, entry.id);
  }
});

test('typing a size resizes from the top-left, and a held ratio makes the other side follow', () => {
  const resized = cropPixels(resizeCrop(FULL_CROP, FILE, { width: 200 }, { ratio: 1 }), FILE);
  assert.deepEqual(resized, { x: 0, y: 0, w: 200, h: 200 }, 'the origin stays put — a typed number grows rightwards');
  const fromHeight = cropPixels(resizeCrop(FULL_CROP, FILE, { height: 100 }, { ratio: 16 / 9 }), FILE);
  assert.deepEqual(fromHeight, { x: 0, y: 0, w: 178, h: 100 }, 'and the width follows the height, rounded to a pixel');
  // Near an edge a resize stops at the edge instead of jumping the crop back to the other one.
  const nearEdge = cropPixels(resizeCrop({ x: 0.5, y: 0, w: 0.5, h: 1 }, FILE, { width: 1000 }), FILE);
  assert.deepEqual(nearEdge, { x: 400, y: 0, w: 400, h: 400 }, 'the right edge is the last column, not a re-fit');
});

test('a crop can be moved without being resized, and it stops at the file', () => {
  const start = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  assert.deepEqual(cropPixels(moveCrop(start, FILE, 100, 50), FILE), { x: 300, y: 150, w: 400, h: 200 });
  assert.deepEqual(cropPixels(moveCrop(start, FILE, -9999, 9999), FILE), { x: 0, y: 200, w: 400, h: 200 }, 'edges clamp, size holds');
  assert.deepEqual(cropPixels(moveCrop(start, { width: 0, height: 0 }, 100, 50), FILE), { x: 200, y: 100, w: 400, h: 200 }, 'an unmeasured file moves nothing');
});

test('edges are the unit a drag works in, so the edges that are not dragged do not creep', () => {
  assert.deepEqual(cropEdgesPx({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, FILE), { left: 200, top: 200, right: 600, bottom: 300 });
  // One edge moved; the other three are exactly where they were.
  assert.deepEqual(
    cropEdgesPx(cropFromEdgesPx({ left: 120, top: 200, right: 600, bottom: 300 }, FILE), FILE),
    { left: 120, top: 200, right: 600, bottom: 300 },
  );
  // An edge dragged off the file clamps there, and the edge that was not dragged stays where it was.
  assert.deepEqual(
    cropEdgesPx(cropFromEdgesPx({ left: -50, top: 200, right: 600, bottom: 300 }, FILE), FILE),
    { left: 0, top: 200, right: 600, bottom: 300 },
  );
  // Dragging an edge *past* its opposite is a zero-width crop, and the answer is the pixel floor rather
  // than an inside-out rectangle: the dragged edge is kept and the opposite one is pushed off it.
  assert.deepEqual(
    cropEdgesPx(cropFromEdgesPx({ left: 700, top: 200, right: 600, bottom: 300 }, FILE), FILE),
    { left: 700, top: 200, right: 700 + MIN_CROP_PX, bottom: 300 },
  );
});

test('an exported crop takes whole pixels out of the file, so its edges are never resampled', () => {
  // 0.3333 of 800 is 266.64: a source rectangle that is a third of a pixel wide is an edge the encoder
  // would have to blur on every frame. The source rectangle is rounded; the picture is what it is.
  assert.deepEqual(cropSourceRect({ x: 0.1, y: 0.2, w: 0.3333, h: 0.4444 }, FILE), { x: 80, y: 80, width: 267, height: 178 });
});
