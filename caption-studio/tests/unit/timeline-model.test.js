/**
 * timeline-model.test.js — the cut arithmetic: what the exported file contains.
 *
 * This is the module that decides how long the export is and which frame each output frame came from,
 * so the arithmetic is pinned here rather than left to the browser run to notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_RANGE,
  captionKept,
  cutAfter,
  cutBefore,
  droppedCaptionIds,
  ensureTimeline,
  fullRanges,
  inGap,
  isTrimmed,
  keptOverlap,
  nextKeptSource,
  normalizeRanges,
  outputDuration,
  outputToSource,
  rangeIndexAt,
  removeAt,
  resetTrack,
  sourceToOutput,
  splitAt,
  totalSourceEnd,
  trackRanges,
  trimEdge,
} from '../../src/model/timeline.js';

test('a full source reads as one range covering all of it', () => {
  const ranges = fullRanges(12);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].srcIn, 0);
  assert.equal(ranges[0].srcOut, 12);
  assert.deepEqual(fullRanges(0), [], 'a source with no length keeps nothing');
  assert.equal(isTrimmed(ranges, 12), false);
  assert.equal(isTrimmed(ranges, 11), true, 'a range that no longer matches the source is a cut');
  assert.equal(isTrimmed([], 12), true);
});

test('normalizeRanges sorts, drops the unusable, and trims an overlap instead of merging it', () => {
  const ranges = normalizeRanges([
    { id: 'b', srcIn: 5, srcOut: 9 },
    { id: 'a', srcIn: 0, srcOut: 6 },
    { id: 'n', srcIn: 3, srcOut: 3.01 },
    { id: 'junk', srcIn: 'x', srcOut: null },
  ]);
  assert.deepEqual(
    ranges.map((r) => [r.srcIn, r.srcOut]),
    [
      [0, 6],
      [6, 9],
    ],
    'the overlap is trimmed off the later range, so nothing deleted comes back',
  );
  assert.ok(ranges.every((r) => r.id), 'every survivor has an id');
});

test('a track with no timeline reads as the whole source, and an emptied one reads as nothing', () => {
  const doc = {};
  assert.deepEqual(trackRanges(doc, 'video', 7).map((r) => [r.srcIn, r.srcOut]), [[0, 7]]);
  ensureTimeline(doc, { video: 7, audio: 3 });
  assert.deepEqual(trackRanges(doc, 'video', 7).map((r) => [r.srcIn, r.srcOut]), [[0, 7]]);
  doc.timeline.video = { sourceDuration: 7, ranges: [] };
  assert.deepEqual(trackRanges(doc, 'video', 7), [], 'a cleared track stays cleared');
});

test('ensureTimeline creates a missing track but never resurrects an emptied one', () => {
  const doc = { timeline: { video: { sourceDuration: 7, ranges: [] } } };
  ensureTimeline(doc, { video: 7, audio: 4 });
  assert.deepEqual(doc.timeline.video.ranges, [], 'the deliberate cut survives a reload');
  assert.equal(doc.timeline.audio.ranges.length, 1, 'the track that was never set up is filled in');
  assert.equal(doc.timeline.audio.sourceDuration, 4);
});

test('resetTrack puts a track back to the whole source', () => {
  const doc = { timeline: { video: { sourceDuration: 9, ranges: [] }, audio: { sourceDuration: 9, ranges: [] } } };
  resetTrack(doc, 'video', 9);
  assert.deepEqual(doc.timeline.video.ranges.map((r) => [r.srcIn, r.srcOut]), [[0, 9]]);
  assert.deepEqual(doc.timeline.audio.ranges, [], 'and touches only the track it was asked about');
});

test('splitting a range leaves one clip of two, and refuses to split at an edge', () => {
  const ranges = fullRanges(10);
  const split = splitAt(ranges, 4);
  assert.deepEqual(split.map((r) => [r.srcIn, r.srcOut]), [
    [0, 4],
    [4, 10],
  ]);
  assert.notEqual(split[0].id, split[1].id, 'the halves are separate clips');
  assert.deepEqual(splitAt(ranges, 0).map((r) => r.srcOut), [10], 'the very start is not a cut point');
  assert.deepEqual(splitAt(ranges, 10).map((r) => r.srcOut), [10], 'nor is the very end');
  assert.deepEqual(splitAt([], 3), [], 'nothing to split is not an error');
});

test('cut before and cut after remove exactly one side of the playhead', () => {
  const two = splitAt(fullRanges(10), 4);
  assert.deepEqual(cutBefore(two, 2).map((r) => [r.srcIn, r.srcOut]), [
    [2, 4],
    [4, 10],
  ]);
  assert.deepEqual(cutAfter(two, 2).map((r) => [r.srcIn, r.srcOut]), [[0, 2]]);
  // Across a gap they drop whole clips, which is what "cut everything to the left" means.
  const gapped = removeAt(two, 6); // the playhead was over the second half, so only [0,4) is left
  assert.deepEqual(gapped.map((r) => [r.srcIn, r.srcOut]), [[0, 4]]);
  assert.deepEqual(cutBefore(gapped, 2).map((r) => [r.srcIn, r.srcOut]), [[2, 4]]);
  assert.deepEqual(cutAfter(gapped, 2).map((r) => [r.srcIn, r.srcOut]), [[0, 2]]);
  assert.deepEqual(cutAfter(gapped, 0), [], 'cutting at the very start removes the clip entirely');
});

test('removeAt deletes the clip the playhead is over, and only that one', () => {
  const two = splitAt(fullRanges(10), 4);
  assert.deepEqual(removeAt(two, 1).map((r) => [r.srcIn, r.srcOut]), [[4, 10]]);
  assert.deepEqual(removeAt(two, 7).map((r) => [r.srcIn, r.srcOut]), [[0, 4]]);
  assert.deepEqual(removeAt(two, 99).map((r) => [r.srcIn, r.srcOut]), [
    [0, 4],
    [4, 10],
  ], 'a playhead past the end changes nothing');
});

test('trimEdge moves one edge and cannot cross its neighbours', () => {
  const two = splitAt(fullRanges(10), 5);
  const trimmed = trimEdge(two, 0, 'out', 8, 10);
  assert.deepEqual(trimmed.map((r) => [r.srcIn, r.srcOut]), [
    [0, 5],
    [5, 10],
  ], 'the second clip blocks the first from growing into it');
  const head = trimEdge(two, 1, 'in', 2, 10);
  assert.deepEqual(head.map((r) => [r.srcIn, r.srcOut]), [
    [0, 5],
    [5, 10],
  ], 'nor may it cross the clip before it');
  const inward = trimEdge(two, 0, 'out', 3, 10);
  assert.deepEqual(inward[0].srcOut, 3);
  const floor = trimEdge(two, 0, 'out', -5, 10);
  assert.ok(inward[0].srcOut - inward[0].srcIn >= MIN_RANGE);
  assert.ok(floor[0].srcOut >= MIN_RANGE, 'a clip cannot be trimmed to nothing');
});

test('the gap map answers where playback should be', () => {
  // keeps [0,4) and [6,10); [4,6) was cut away
  const gapped = normalizeRanges([
    { id: 'a', srcIn: 0, srcOut: 4 },
    { id: 'b', srcIn: 6, srcOut: 10 },
  ]);
  assert.equal(rangeIndexAt(gapped, 1), 0);
  assert.equal(rangeIndexAt(gapped, 6), 1);
  assert.equal(rangeIndexAt(gapped, 5), -1, 'the removed middle belongs to no clip');
  assert.equal(inGap(gapped, 1), false);
  assert.equal(inGap(gapped, 5), true);
  assert.equal(inGap(gapped, 12), false, 'past the end is the end, not a gap');
  assert.equal(nextKeptSource(gapped, 5), 6, 'a gap jumps forward to the next kept moment');
  assert.equal(nextKeptSource(gapped, 1), 1, 'a kept moment is left alone');
  assert.equal(nextKeptSource(gapped, 20), null, 'nothing left to play');
  assert.equal(nextKeptSource([{ id: 'a', srcIn: 0, srcOut: 4 }], 6), null);
});

test('output duration is the kept material, and the maps agree with it', () => {
  const ranges = normalizeRanges([
    { id: 'a', srcIn: 2, srcOut: 5 },
    { id: 'b', srcIn: 8, srcOut: 12 },
  ]);
  assert.equal(outputDuration(ranges), 7, '3 kept seconds plus 4 kept seconds');
  assert.equal(totalSourceEnd(ranges), 12);
  assert.equal(sourceToOutput(ranges, 2), 0, 'the first kept frame is the start of the file');
  assert.equal(sourceToOutput(ranges, 4), 2);
  assert.equal(sourceToOutput(ranges, 6), null, 'a cut-away moment is in no output file');
  assert.equal(sourceToOutput(ranges, 10), 5, 'output time keeps counting across the gap');
  assert.equal(outputToSource(ranges, 2.5), 4.5);
  assert.equal(outputToSource(ranges, 3), 8, 'the second clip begins where the first left off');
  assert.equal(outputToSource(ranges, 5), 10);
  assert.equal(outputToSource(ranges, 99), 12, 'past the end is clamped to the last frame');
  assert.equal(outputToSource([], 1), null, 'an empty track has no picture at all');
});

test('a caption is kept when most of it survives the cut', () => {
  const ranges = [{ id: 'a', srcIn: 0, srcOut: 4 }];
  assert.equal(keptOverlap(ranges, 1, 3), 2);
  assert.equal(captionKept(ranges, { start: 1, end: 3 }), true);
  assert.equal(captionKept(ranges, { start: 3, end: 6 }), false, 'half of it gone is gone');
  assert.equal(captionKept(ranges, { start: 3.9, end: 6 }), false);
  assert.equal(captionKept(ranges, { start: 0, end: 0 }), false, 'a zero-length caption is not drawn');
});

test('droppedCaptionIds reports what the cut removed from the picture track', () => {
  const doc = {
    blocks: [
      { id: 'kept', start: 0.5, end: 2 },
      { id: 'gone', start: 6, end: 8 },
    ],
    timeline: { video: { sourceDuration: 10, ranges: [{ id: 'a', srcIn: 0, srcOut: 4 }] } },
  };
  const dropped = droppedCaptionIds(doc);
  assert.equal(dropped.has('gone'), true);
  assert.equal(dropped.has('kept'), false);
  assert.equal(droppedCaptionIds({ blocks: [{ id: 'x', start: 0, end: 1 }], timeline: { video: { sourceDuration: 5, ranges: [] } } }).has('x'), true, 'no picture means no caption');
});
