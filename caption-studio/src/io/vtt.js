/**
 * io/vtt.js — WebVTT (.vtt) parsing and serialization.
 *
 * Handles the WEBVTT header, NOTE/STYLE/REGION blocks, cue identifiers and
 * cue settings (align/position/line), and the same inline markup as SRT.
 */

import { parseTimeToSeconds, formatVTTTime } from './timecode.js';
import { stripInlineTags } from './srt.js';

/**
 * @param {string} text raw VTT contents
 * @returns {{ cues: Array<{index:number,id:string|null,start:number,end:number,lines:string[],settings:string,raw:string}>, warnings:string[] }}
 */
export function parseVTT(text) {
  const warnings = [];
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const chunks = clean.split(/\n[ \t]*\n/);
  const cues = [];

  for (const chunk of chunks) {
    const body = chunk.trim();
    if (!body) continue;
    if (/^WEBVTT/.test(body)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(body)) continue;

    const lines = body.split('\n');
    let id = null;
    if (!lines[0].includes('-->')) {
      id = lines.shift().trim() || null;
    }
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) {
      warnings.push(`skipped VTT block with no timing line: "${body.split('\n')[0]}"`);
      continue;
    }
    const [rawStart, rawRest] = lines[timeIdx].split('-->');
    const rest = (rawRest || '').trim();
    const rawEnd = rest.split(/\s+/)[0];
    const settings = rest.slice(rawEnd.length).trim();
    const start = parseTimeToSeconds(rawStart);
    const end = parseTimeToSeconds(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      warnings.push(`skipped VTT cue with unparseable timing: "${lines[timeIdx]}"`);
      continue;
    }

    const textLines = lines
      .slice(timeIdx + 1)
      .map(stripInlineTags)
      .filter((l) => l.length > 0);

    cues.push({ index: cues.length + 1, id, start, end: Math.max(end, start), lines: textLines, settings, raw: chunk });
  }

  return { cues, warnings };
}

/** Serialize blocks to WebVTT (with optional per-word timestamps). */
export function serializeVTT(blocks, { withWordTimings = false } = {}) {
  const parts = ['WEBVTT', ''];
  blocks.forEach((b, i) => {
    parts.push(String(i + 1));
    parts.push(`${formatVTTTime(b.start)} --> ${formatVTTTime(b.end)}`);
    if (withWordTimings && b.words?.length) {
      // <00:00:12.500>word <00:00:12.900>word …
      parts.push(
        b.words.map((w) => `<${formatVTTTime(w.start)}>${w.text}`).join(' '),
      );
    } else {
      parts.push(b.text);
    }
    parts.push('');
  });
  return parts.join('\n');
}
