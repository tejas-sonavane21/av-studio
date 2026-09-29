/**
 * align/tokens.js — tokenization with character offsets.
 *
 * Tokens are whitespace-delimited runs, so punctuation stays attached to its word
 * ("falling," counts as one token). charFrom/charTo are offsets into the source string.
 */

const WS_RUN = /\S+/g;

/**
 * @param {string} text
 * @returns {Array<{text:string,charFrom:number,charTo:number}>}
 */
export function tokenize(text) {
  const out = [];
  if (text == null) return out;
  const s = String(text);
  WS_RUN.lastIndex = 0;
  let m;
  while ((m = WS_RUN.exec(s)) !== null) {
    out.push({ text: m[0], charFrom: m.index, charTo: m.index + m[0].length });
  }
  return out;
}

/** Tokenize several lines into one list, joined with a single space like the document model. */
export function tokenizeLines(lines) {
  const joined = (lines || []).join(' ');
  return tokenize(joined);
}

/** Character weight of a token for proportional timing (letters/digits, min 1). */
export function tokenWeight(token) {
  const letters = String(token.text).replace(/[^\p{L}\p{N}]/gu, '');
  return Math.max(1, letters.length);
}
