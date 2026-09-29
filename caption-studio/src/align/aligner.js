/**
 * align/aligner.js — orchestrate the full correction pipeline (plan §8).
 *
 *   AI word stream (timing/emphasis authority)
 *        ↘
 *         findAnchors → segment → DTW → path
 *        ↗
 *   TRUTH word stream (spelling authority)
 *        ↓
 *   resolved steps → output blocks + typed corrections + report
 *
 * Pure and deterministic: same inputs + policy ⇒ byte-identical output.
 */

import { matchKey } from './normalize.js';
import { wordsFromCues } from './rolling.js';
import { findAnchors, segmentAroundAnchors } from './anchors.js';
import { dtwAlign } from './dtw.js';
import { classifySubstitution, makeCorrection, confidenceFor } from './corrections.js';
import { buildReport } from './report.js';
import { createIdFactory } from '../model/id.js';
import { rebuildBlockText, computeEmphasisFlags } from '../model/document.js';

export const DEFAULT_POLICY = {
  // DTW weights / geometry
  wText: 0.7,
  wTime: 0.3,
  gapCost: 0.5,
  bandFrac: 0.2,
  // anchoring (time is a tie-breaker only — see align/anchors.js)
  timeTol: 1,
  maxDriftFrac: 0.15,
  allowStopwords: false,
  // behaviour
  insertMissing: true,
  deleteExtra: false,
  adoptPunctuation: true,
  gapThreshold: 2.5,
  minConfidence: 0.5,
};

/** Flatten AI blocks into one word stream, remembering which block each word came from. */
function flattenAiBlocks(aiBlocks) {
  const aiWords = [];
  aiBlocks.forEach((block, blockIndex) => {
    for (const w of block.words || []) {
      aiWords.push({
        text: w.text,
        start: w.start,
        end: w.end,
        mid: (w.start + w.end) / 2,
        key: matchKey(w.text),
        emphasis: !!w.emphasis,
        blockIndex,
      });
    }
  });
  return aiWords;
}

/**
 * Distribute runs of inserted words between their neighbours.
 *
 * IMPORTANT: an insertion's own TRUTH time is never used as a bound. TRUTH word times are
 * synthesised from cue windows and drift seconds *earlier* than the AI timeline, so they
 * would drag the block backwards over the previous one. Bounds come from the surrounding
 * AI words, the block's own envelope, and `floor` (the end of the previously emitted block).
 */
function placeInsertions(items, { envEnd = null, slotEnd = null, floor = -Infinity } = {}) {
  let i = 0;
  while (i < items.length) {
    if (items[i].kind !== 'ins') { i++; continue; }
    let j = i;
    while (j < items.length && items[j].kind === 'ins') j++;
    const run = items.slice(i, j);
    const prev = i > 0 ? items[i - 1] : null;
    const next = j < items.length ? items[j] : null;

    let lo = prev ? prev.end : floor;
    if (!Number.isFinite(lo)) lo = run[0].start;
    if (lo < floor) lo = floor;

    let hi = null;
    if (next) hi = next.start;
    else if (envEnd != null && envEnd > lo + 1e-6) hi = envEnd; // tail of the block
    else if (slotEnd != null && slotEnd > lo + 1e-6) hi = slotEnd; // the gap before the next block

    if (hi != null && hi > lo + 1e-6) {
      const weights = run.map((r) => Math.max(1, r.text.replace(/[^\p{L}\p{N}]/gu, '').length));
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      let t = lo;
      run.forEach((r, k) => {
        const d = ((hi - lo) * weights[k]) / total;
        r.start = t;
        r.end = t + d;
        t += d;
      });
    } else if (prev) {
      // no room left in the block: give each a nominal duration after the previous word
      let t = prev.end;
      run.forEach((r) => {
        const letters = r.text.replace(/[^\p{L}\p{N}]/gu, '').length;
        const d = Math.max(0.12, 0.06 * letters);
        r.start = t;
        r.end = t + d;
        t += d;
      });
    } else {
      // nothing to anchor to (empty block): pin the run at the floor
      run.forEach((r) => { r.start = lo; r.end = lo; });
    }
    i = j;
  }
}

/** Build emphasis style ranges from per-word flags (so computeEmphasisFlags reproduces them). */
function emphasisRanges(block, styleId) {
  const ranges = [];
  const style = { bold: false, italic: true, color: '#ffffff', font: 'Inter', spacing: 0, underline: true };
  let start = null;
  block.words.forEach((w, i) => {
    if (w.emphasis) {
      if (start === null) start = w.charFrom;
    } else if (start !== null) {
      ranges.push({ from: start, to: block.words[i - 1].charTo, id: styleId, style: { ...style } });
      start = null;
    }
  });
  if (start !== null) {
    ranges.push({ from: start, to: block.words[block.words.length - 1].charTo, id: styleId, style: { ...style } });
  }
  return ranges;
}

/**
 * @param {object} args
 * @param {Array} args.aiBlocks  AI blocks (Veed JSON or Whisper output) — authoritative timing/emphasis
 * @param {Array} args.truthCues TRUTH cues (SRT/VTT) — authoritative spelling
 * @param {object} [args.policy]
 * @returns {{ blocks:Array, corrections:Array, report:object, anchors:Array, aiWords:Array, truthWords:Array }}
 */
export function alignCaptions({ aiBlocks = [], truthCues = [], policy = {}, styleId = 'auto-highlight' } = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const nextBlockId = createIdFactory('blk');
  const nextWordId = createIdFactory('w');
  const nextCorrectionId = createIdFactory('cor');

  const { words: truthWords } = wordsFromCues(truthCues);
  const aiWords = flattenAiBlocks(aiBlocks);

  const anchors = findAnchors(aiWords, truthWords, p);
  const segments = segmentAroundAnchors(anchors, aiWords.length, truthWords.length);

  // --- alignment path (anchors forced, DTW in between) ---
  const path = [];
  for (const seg of segments) {
    const subPath = dtwAlign(aiWords.slice(seg.aiStart, seg.aiEnd), truthWords.slice(seg.truthStart, seg.truthEnd), p);
    for (const step of subPath) {
      path.push({
        aiIndex: step.aiIndex == null ? null : seg.aiStart + step.aiIndex,
        truthIndex: step.truthIndex == null ? null : seg.truthStart + step.truthIndex,
      });
    }
    if (seg.anchor) path.push({ aiIndex: seg.anchor.i, truthIndex: seg.anchor.j });
  }

  // --- resolve each step into a candidate output word ---
  const resolved = [];
  for (const step of path) {
    if (step.aiIndex == null) {
      const t = truthWords[step.truthIndex];
      resolved.push({ kind: 'ins', text: t.text, start: t.start, end: t.end, emphasis: false, aiIndex: null, truthIndex: step.truthIndex, blockIndex: null });
    } else if (step.truthIndex == null) {
      const a = aiWords[step.aiIndex];
      resolved.push({ kind: 'del', text: a.text, start: a.start, end: a.end, emphasis: a.emphasis, aiIndex: step.aiIndex, truthIndex: null, blockIndex: a.blockIndex, aiText: a.text });
    } else {
      const a = aiWords[step.aiIndex];
      const t = truthWords[step.truthIndex];
      resolved.push({ kind: 'sub', text: t.text, start: a.start, end: a.end, emphasis: a.emphasis, aiIndex: step.aiIndex, truthIndex: step.truthIndex, blockIndex: a.blockIndex, aiText: a.text, truthText: t.text });
    }
  }

  // --- give insertions a home block (previous block, else next) ---
  let lastBlock = null;
  for (const r of resolved) {
    if (r.blockIndex != null) lastBlock = r.blockIndex;
    else if (lastBlock != null) r.blockIndex = lastBlock;
  }
  let nextBlock = null;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    if (r.blockIndex != null) nextBlock = r.blockIndex;
    else if (nextBlock != null) r.blockIndex = nextBlock;
  }

  const kept = resolved.filter((r) => {
    if (r.kind === 'del' && p.deleteExtra) return false;
    if (r.kind === 'ins' && !p.insertMissing) return false;
    return r.blockIndex != null;
  });

  const groups = new Map();
  for (const r of kept) {
    if (!groups.has(r.blockIndex)) groups.set(r.blockIndex, []);
    groups.get(r.blockIndex).push(r);
  }

  // --- one group per source block, in path order ---
  // The path is monotonic in aiIndex, and the source blocks are time-sorted and
  // non-overlapping, so group order *is* time order: a forward pass can therefore keep the
  // output blocks from ever overlapping.
  const groupList = [];
  for (const [blockIndex, items] of groups) {
    items.sort((a, b) => a.start - b.start || (a.aiIndex ?? 1e9) - (b.aiIndex ?? 1e9));
    const aiItems = items.filter((it) => it.aiIndex != null);
    groupList.push({
      blockIndex,
      items,
      envStart: aiItems.length ? Math.min(...aiItems.map((it) => it.start)) : null,
      envEnd: aiItems.length ? Math.max(...aiItems.map((it) => it.end)) : null,
    });
  }

  // --- build output blocks + corrections ---
  const outBlocks = [];
  const corrections = [];
  const blockIdByIndex = new Map();
  let cursor = -Infinity; // end of the previously emitted block

  groupList.forEach((group, gi) => {
    const items = group.items;
    const slotEnd = groupList[gi + 1]?.envStart ?? null;
    placeInsertions(items, { envEnd: group.envEnd, slotEnd, floor: cursor });

    let prevEnd = -Infinity;
    for (const it of items) {
      if (it.start < prevEnd) it.start = prevEnd;
      if (it.end < it.start) it.end = it.start;
      prevEnd = it.end;
    }
    // Safety net: never begin before the previous block ended (durations preserved).
    if (Number.isFinite(cursor) && items[0].start < cursor) {
      const delta = cursor - items[0].start;
      for (const it of items) { it.start += delta; it.end += delta; }
    }

    const block = {
      id: nextBlockId(),
      start: items[0].start,
      end: items[items.length - 1].end,
      text: '',
      overrides: {},
      styles: [],
      words: [],
      placement: null,
      locked: false,
    };

    for (const it of items) {
      const word = {
        id: nextWordId(),
        text: it.text,
        start: it.start,
        end: it.end,
        charFrom: 0,
        charTo: it.text.length,
        emphasis: !!it.emphasis,
        emoji: null,
        confidence: it.kind === 'sub' ? confidenceFor('replace', it.aiText, it.truthText) : 0.6,
      };
      it.wordId = word.id;
      it.blockId = block.id;
      block.words.push(word);
    }

    rebuildBlockText(block);
    block.styles = emphasisRanges(block, styleId);
    computeEmphasisFlags(block, styleId);
    outBlocks.push(block);
    blockIdByIndex.set(group.blockIndex, block.id);
    cursor = block.end;

    // A correction records a change that was actually applied. An AI-only word is kept
    // as-is unless `deleteExtra` asks for its removal, so it is not a correction — it is
    // reported as `report.deleted` instead (the UI can offer it as a suggestion).
    for (const it of items) {
      if (it.kind === 'ins') {
        corrections.push(makeCorrection(nextCorrectionId(), { type: 'insert', to: it.text, blockId: it.blockId, wordId: it.wordId, confidence: 0.6, reason: 'word missing from AI source' }));
      } else if (it.kind === 'sub') {
        const type = classifySubstitution(it.aiText, it.truthText);
        if (type) {
          corrections.push(makeCorrection(nextCorrectionId(), { type, from: it.aiText, to: it.truthText, blockId: it.blockId, wordId: it.wordId, confidence: confidenceFor(type, it.aiText, it.truthText), reason: 'TRUTH spelling differs from AI' }));
        }
      }
    }
  });

  if (p.deleteExtra) {
    for (const r of resolved) {
      if (r.kind !== 'del') continue;
      corrections.push(makeCorrection(nextCorrectionId(), {
        type: 'delete',
        from: r.aiText,
        blockId: blockIdByIndex.get(r.blockIndex) ?? null,
        wordId: null,
        confidence: 0.6,
        reason: 'word present only in AI source',
      }));
    }
  }

  outBlocks.sort((a, b) => a.start - b.start);

  const report = buildReport({ aiWords, truthWords, anchors, resolved, corrections, gapThreshold: p.gapThreshold });

  return { blocks: outBlocks, corrections, report, anchors, aiWords, truthWords };
}
