/**
 * io/timecode.js — SRT/VTT timestamp parsing and formatting.
 */

/** Parse "HH:MM:SS,mmm" / "MM:SS.mmm" / "SS.mmm" (also accepts a plain number). */
export function parseTimeToSeconds(t) {
  if (typeof t === 'number') return t;
  if (t == null) return NaN;
  const s = String(t).trim().replace(',', '.');
  if (!s) return NaN;
  const parts = s.split(':');
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n))) return NaN;
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0];
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function split(sec) {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  // rounding can push ms to 1000
  return ms === 1000 ? { h, m, s: s + 1, ms: 0 } : { h, m, s, ms };
}

/** "00:00:12,500" */
export function formatSRTTime(sec) {
  const { h, m, s, ms } = split(sec);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** "00:00:12.500" */
export function formatVTTTime(sec) {
  const { h, m, s, ms } = split(sec);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}
