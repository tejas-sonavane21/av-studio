/**
 * align/anchors.js — find high-confidence (AI word, TRUTH word) pairs.
 *
 * An anchor is a pair (AI word, TRUTH word) with the same match key that is
 * *unambiguous*. Stop-words are excluded unless the caller opts in — they are too common
 * to be reliable on their own.
 *
 * TIME IS ONLY A TIE-BREAKER, NOT A GATE. TRUTH word times are synthesised from cue
 * windows (rolling SRT lines are spread proportionally across a 2–4 s cue), so they sit
 * seconds away from the AI's real word times. Measured on the reference song the offset
 * drifts from ~3 s to ~7 s over the track, so any tight absolute window matches nothing
 * (this was worth 0 anchors at the naive 0.35 s tolerance). Instead:
 *
 *   - a key that occurs exactly once in TRUTH (and once in the AI stream) anchors outright;
 *   - a repeated key (the chorus) anchors on its nearest-in-time occurrence, and only when
 *     that occurrence is clearly closer than the runner-up;
 *   - `maxDrift` still rejects absurd matches, but it is generous (a fraction of the track).
 *
 * Candidates are then reduced to a strictly increasing chain by a *weighted* LIS, so a
 * doubtful anchor loses to a confident one instead of corrupting the whole alignment.
 *
 * Anchors turn one global alignment into several small, reliable sub-alignments.
 */

import { matchKey } from './normalize.js';

export const STOP_WORDS = [
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'as', 'is',
  'it', 'its', 'i', 'im', 'me', 'my', 'we', 'be', 'am', 'are', 'was', 'do', 'so',
  'if', 'up', 'no', 'oh', 'yeah', 'that', 'this', 'with', 'from',
];

const keyOf = (w) => w.key ?? matchKey(w.text);
const midOf = (w) => (Number.isFinite(w.mid) ? w.mid : (w.start + w.end) / 2);

/**
 * Weighted longest increasing chain over (i, j) — prefers confident anchors.
 * Each AI index contributes at most one candidate, so `i` is already unique and ascending.
 */
function monotonicAnchors(candidates) {
  const seq = candidates.slice().sort((p, q) => p.i - q.i || p.j - q.j);
  const n = seq.length;
  if (n === 0) return [];
  const best = seq.map((c) => c.weight);
  const prev = new Array(n).fill(-1);
  let bestIdx = 0;
  for (let x = 1; x < n; x++) {
    for (let y = 0; y < x; y++) {
      if (seq[y].j < seq[x].j && best[y] + seq[x].weight > best[x]) {
        best[x] = best[y] + seq[x].weight;
        prev[x] = y;
      }
    }
    if (best[x] > best[bestIdx]) bestIdx = x;
  }
  const out = [];
  for (let k = bestIdx; k !== -1; k = prev[k]) out.push({ i: seq[k].i, j: seq[k].j });
  return out.reverse();
}

/** Time span covered by both streams (seconds). */
function streamSpan(ai, truth) {
  const times = [];
  for (const w of ai) { times.push(w.start); times.push(w.end); }
  for (const w of truth) { times.push(w.start); times.push(w.end); }
  const finite = times.filter((t) => Number.isFinite(t));
  if (!finite.length) return 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of finite) { if (t < lo) lo = t; if (t > hi) hi = t; }
  return Math.max(1, hi - lo);
}

/**
 * @returns {Array<{i:number,j:number}>} anchors with strictly increasing i and j
 */
export function findAnchors(ai, truth, opts = {}) {
  const stop = new Set((opts.stopWords ?? STOP_WORDS).map((w) => String(w).toLowerCase()));
  const allowStopwords = opts.allowStopwords ?? false;
  const timeTol = opts.timeTol ?? 1;
  // Generous hard window: TRUTH times are synthetic, so a real match can be seconds off.
  const maxDrift = opts.maxDrift ?? Math.max(4 * timeTol, (opts.maxDriftFrac ?? 0.15) * streamSpan(ai, truth));

  const truthByKey = new Map();
  truth.forEach((w, j) => {
    const k = keyOf(w);
    if (!k) return;
    if (!truthByKey.has(k)) truthByKey.set(k, []);
    truthByKey.get(k).push(j);
  });
  const aiKeyCount = new Map();
  ai.forEach((w) => {
    const k = keyOf(w);
    if (k) aiKeyCount.set(k, (aiKeyCount.get(k) || 0) + 1);
  });

  const raw = [];
  ai.forEach((a, i) => {
    const k = keyOf(a);
    if (!k) return;
    const cands = truthByKey.get(k);
    if (!cands) return;
    if (stop.has(k) && !allowStopwords) return;

    let best = null;
    let second = null;
    for (const j of cands) {
      const d = Math.abs(midOf(truth[j]) - midOf(a));
      if (!best || d < best.d) { second = best; best = { j, d }; }
      else if (!second || d < second.d) second = { j, d };
    }
    if (!best || best.d > maxDrift) return;

    const uniqueTruth = cands.length === 1;
    const uniqueAi = (aiKeyCount.get(k) || 0) === 1;
    // A repeated key must have a clearly nearest occurrence, or it is not an anchor.
    if (!uniqueTruth && second && second.d < best.d + timeTol) return;

    const closeness = 1 - Math.min(1, best.d / maxDrift);
    raw.push({ i, j: best.j, weight: (uniqueTruth ? 3 : 0) + (uniqueAi ? 1.5 : 0) + closeness });
  });

  return monotonicAnchors(raw);
}

/**
 * Split two streams into segments around anchors. Each segment is
 * { aiStart, aiEnd, truthStart, truthEnd, anchor } (half-open ranges).
 */
export function segmentAroundAnchors(anchors, aiLength, truthLength) {
  const segments = [];
  let aiCursor = 0;
  let truthCursor = 0;
  for (const a of anchors) {
    segments.push({ aiStart: aiCursor, aiEnd: a.i, truthStart: truthCursor, truthEnd: a.j, anchor: a });
    aiCursor = a.i + 1;
    truthCursor = a.j + 1;
  }
  segments.push({ aiStart: aiCursor, aiEnd: aiLength, truthStart: truthCursor, truthEnd: truthLength, anchor: null });
  return segments;
}
