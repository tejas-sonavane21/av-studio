/**
 * io/srt.js — SubRip (.srt) parsing and serialization.
 *
 * Robust to the edge cases listed in IMPLEMENTATION-PLAN.md §7.2:
 * BOM, CRLF/CR/LF, missing indices, hour-less timestamps, and inline markup.
 */

import { parseTimeToSeconds, formatSRTTime } from './timecode.js';

/** Remove <i>…</i>, <b>, <font …>, and ASS-style {\an8}/{\pos(...)} tags. */
export function stripInlineTags(line) {
  return String(line)
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .trim();
}

/**
 * @param {string} text raw SRT contents
 * @returns {{ cues: Array<{index:number,start:number,end:number,lines:string[],raw:string}>, warnings:string[] }}
 */
export function parseSRT(text) {
  const warnings = [];
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const chunks = clean.split(/\n[ \t]*\n/);
  const cues = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    if (lines.length && /^\s*\d+\s*$/.test(lines[0])) lines.shift();

    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) {
      warnings.push(`skipped block with no timing line: "${chunk.split('\n')[0]}"`);
      continue;
    }
    const [rawStart, rawRest] = lines[timeIdx].split('-->');
    const rawEnd = (rawRest || '').trim().split(/\s+/)[0]; // drop trailing settings, if any
    const start = parseTimeToSeconds(rawStart);
    const end = parseTimeToSeconds(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      warnings.push(`skipped cue with unparseable timing: "${lines[timeIdx]}"`);
      continue;
    }

    const textLines = lines
      .slice(timeIdx + 1)
      .map(stripInlineTags)
      .filter((l) => l.length > 0);

    cues.push({ index: cues.length + 1, start, end: Math.max(end, start), lines: textLines, raw: chunk });
  }

  return { cues, warnings };
}

/** Serialize blocks to SRT. `blocks` may be caption-document blocks. */
export function serializeSRT(blocks) {
  return (
    blocks
      .map((b, i) => `${i + 1}\n${formatSRTTime(b.start)} --> ${formatSRTTime(b.end)}\n${b.text}\n`)
      .join('\n') + '\n'
  );
}
