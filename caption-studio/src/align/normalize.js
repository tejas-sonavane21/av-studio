/**
 * align/normalize.js — deterministic text normalization for matching.
 *
 * IMPORTANT: the normal form is used *only* for matching. Display text is never changed
 * here — corrections are applied later and are fully auditable.
 */

const QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u02BC]/g;
const DQUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const ELLIPSIS = /\u2026/g;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/** NFKC + unify punctuation + collapse whitespace. Case preserved. */
export function canonical(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical with punctuation removed but case preserved (used to detect case-only diffs).
 *
 * Apostrophes are elision, not word separators: "hero's" and "heros", "don't" and "dont"
 * must share a key, otherwise every contraction in an AI transcript reads as a mismatch
 * against a TRUTH file that spells it without the apostrophe.
 */
export function lettersOnly(text) {
  return canonical(text)
    .replace(/'/g, '')
    .replace(NON_ALNUM, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The matching key: letters/digits only, lowercased. */
export function matchKey(text) {
  return lettersOnly(text).toLowerCase();
}

/** Standard Levenshtein edit distance. */
export function levenshtein(a, b) {
  a = String(a);
  b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Normalized similarity in [0,1] between two words, compared on their match keys. */
export function similarity(a, b) {
  const x = matchKey(a);
  const y = matchKey(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Classify how a trusted word differs from an AI word.
 * @returns {'same'|'punctuation'|'case'|'replace'}
 */
export function classifyTextDiff(aiText, truthText) {
  if (aiText === truthText) return 'same';
  const ak = matchKey(aiText);
  const tk = matchKey(truthText);
  if (ak === tk) {
    return lettersOnly(aiText) === lettersOnly(truthText) ? 'punctuation' : 'case';
  }
  return 'replace';
}
