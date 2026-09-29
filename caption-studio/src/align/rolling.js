/**
 * align/rolling.js — resolve cumulative/rolling SRT cues into a monotonic word stream.
 *
 * The source of truth files in this project use *rolling* cues: cue N repeats the
 * tail of cue N-1 and appends one new line. A naive flatten therefore emits every
 * line ~3 times (this was the root cause of v9's failure — Knowledge Base §6).
 *
 * The correct model: **a line's time window is the cue in which it FIRST appears
 * (its "birth cue")**; later appearances are on-screen context, not new lyrics.
 * Context repeats are dropped. A line that returns later (chorus) is born again at
 * its new cue and correctly forms a *new* occurrence.
 *
 * This is a refinement of the plan's §8.3 "span = first→last appearance" rule:
 * spanning a line across three cues would stretch one line over ~12 s and destroy
 * the alignment signal. See DECISIONS / plan update.
 */

import { matchKey } from './normalize.js';
import { tokenize, tokenWeight } from './tokens.js';

/**
 * @param {Array<{start:number,end:number,lines:string[]}>} cues
 * @returns {Array<{line:string,key:string,start:number,end:number,cueIndex:number}>}
 */
export function buildLineOccurrences(cues) {
  const occurrences = [];
  let prevKeys = new Set();

  (cues || []).forEach((cue, cueIndex) => {
    const lines = (cue.lines || []).filter((l) => l && l.trim());
    const cueKeys = new Set(lines.map(matchKey).filter(Boolean));

    // lines present now that were not present in the previous cue => newly sung
    const newLines = lines.filter((l) => {
      const k = matchKey(l);
      return k && !prevKeys.has(k);
    });

    if (newLines.length) {
      const span = Math.max(0, cue.end - cue.start);
      const per = span / newLines.length;
      newLines.forEach((line, i) => {
        occurrences.push({
          line,
          key: matchKey(line),
          start: cue.start + i * per,
          end: cue.start + (i + 1) * per,
          cueIndex,
        });
      });
    }

    prevKeys = cueKeys;
  });

  occurrences.sort((a, b) => a.start - b.start || a.end - b.end);
  return occurrences;
}

/**
 * Flatten occurrences into a monotonic word stream with proportional word timing.
 * @returns {Array<{text:string,start:number,end:number,mid:number,key:string,occurrenceIndex:number}>}
 */
export function flattenOccurrences(occurrences) {
  const words = [];
  occurrences.forEach((occ, occurrenceIndex) => {
    const tokens = tokenize(occ.line);
    if (!tokens.length) return;
    const span = Math.max(0, occ.end - occ.start);
    const weights = tokens.map(tokenWeight);
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    let t = occ.start;
    tokens.forEach((tok, i) => {
      const isLast = i === tokens.length - 1;
      const end = isLast ? occ.end : t + (span * weights[i]) / total;
      words.push({
        text: tok.text,
        start: t,
        end,
        mid: (t + end) / 2,
        key: matchKey(tok.text),
        occurrenceIndex,
      });
      t = end;
    });
  });
  return words;
}

/** Convenience: cues → truth word stream. */
export function wordsFromCues(cues) {
  const occurrences = buildLineOccurrences(cues);
  const words = flattenOccurrences(occurrences);
  return { occurrences, words };
}
