/**
 * align/dtw.js — banded dynamic-time-warp alignment of two word streams.
 *
 * Cost = W_text·(1 − similarity) + W_time·normalizedTimeDistance.
 * Allowed operations: match/substitute (diagonal), delete an AI word, insert a TRUTH word.
 * A *band* constrains how far the two sequences may drift apart, which is exactly what the
 * old midpoint-containment heuristic lacked (Knowledge Base §6, v9/v10).
 *
 * Pure and deterministic — golden-testable.
 */

import { matchKey, similarity } from './normalize.js';

const keyOf = (w) => w.key ?? matchKey(w.text);
const midOf = (w) => (Number.isFinite(w.mid) ? w.mid : (w.start + w.end) / 2);

/**
 * @param {Array<{text:string,key?:string,mid?:number,start:number,end:number}>} ai
 * @param {Array<{text:string,key?:string,mid?:number,start:number,end:number}>} truth
 * @param {object} [opts]
 * @returns {Array<{aiIndex:number|null,truthIndex:number|null}>} alignment path in order
 */
export function dtwAlign(ai, truth, opts = {}) {
  const m = ai.length;
  const n = truth.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return truth.map((_, j) => ({ aiIndex: null, truthIndex: j }));
  if (n === 0) return ai.map((_, i) => ({ aiIndex: i, truthIndex: null }));

  const W_TEXT = opts.wText ?? 0.7;
  const W_TIME = opts.wTime ?? 0.3;
  const GAP = opts.gapCost ?? 0.5;
  const bandFrac = opts.bandFrac ?? 0.2;
  const band = opts.band ?? Math.max(3, Math.ceil(bandFrac * Math.max(m, n)));
  const scale = n > 0 ? m / n : 1;

  const duration = opts.duration ?? Math.max(
    0.001,
    Math.max(Math.max(...truth.map((w) => w.end)) - Math.min(...truth.map((w) => w.start)),
             Math.max(...ai.map((w) => w.end)) - Math.min(...ai.map((w) => w.start))),
  );
  // Compare *relative* time only. TRUTH word times are synthesised from cue windows and
  // carry a systematic offset that drifts by seconds, so an absolute comparison would
  // penalise every correct pairing (see align/anchors.js).
  const originAi = opts.aiOrigin ?? Math.min(...ai.map((w) => w.start));
  const originTruth = opts.truthOrigin ?? Math.min(...truth.map((w) => w.start));

  const allowed = (i, j) =>
    Math.abs(i - j * scale) <= band || Math.abs(i - j) <= 3;

  const INF = Infinity;
  const D = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(INF));
  const F = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(''));
  D[0][0] = 0;

  for (let i = 1; i <= m; i++) {
    if (allowed(i, 0)) { D[i][0] = D[i - 1][0] + GAP; F[i][0] = 'del'; }
  }
  for (let j = 1; j <= n; j++) {
    if (allowed(0, j)) { D[0][j] = D[0][j - 1] + GAP; F[0][j] = 'ins'; }
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (!allowed(i, j)) continue;
      const a = ai[i - 1];
      const b = truth[j - 1];
      const sim = keyOf(a) && keyOf(b) && keyOf(a) === keyOf(b) ? 1 : similarity(a.text, b.text);
      const timePen = Math.min(1, Math.abs((midOf(a) - originAi) - (midOf(b) - originTruth)) / duration);
      const sub = D[i - 1][j - 1] + (W_TEXT * (1 - sim) + W_TIME * timePen);
      const del = D[i - 1][j] + GAP;
      const ins = D[i][j - 1] + GAP;
      const best = Math.min(sub, del, ins);
      D[i][j] = best;
      F[i][j] = best === sub ? 'diag' : best === del ? 'del' : 'ins';
    }
  }

  // Backtrack from (m,n).
  const path = [];
  let i = m;
  let j = n;
  let guard = m + n + 2;
  while ((i > 0 || j > 0) && guard-- > 0) {
    const dir = F[i][j];
    if (dir === 'diag') { path.push({ aiIndex: i - 1, truthIndex: j - 1 }); i--; j--; }
    else if (dir === 'del') { path.push({ aiIndex: i - 1, truthIndex: null }); i--; }
    else if (dir === 'ins') { path.push({ aiIndex: null, truthIndex: j - 1 }); j--; }
    else {
      // Not reachable through the band — consume the larger side to terminate safely.
      if (i > 0) { path.push({ aiIndex: i - 1, truthIndex: null }); i--; }
      else { path.push({ aiIndex: null, truthIndex: j - 1 }); j--; }
    }
  }
  path.reverse();
  return path;
}
