/**
 * align/report.js — machine-readable alignment report (plan §8.8).
 */

/** Detect gaps in the AI timeline larger than `threshold` seconds. */
export function detectGaps(aiWords, threshold = 2.5) {
  const gaps = [];
  for (let i = 1; i < aiWords.length; i++) {
    const gap = aiWords[i].start - aiWords[i - 1].end;
    if (gap >= threshold) gaps.push({ start: aiWords[i - 1].end, end: aiWords[i].start, duration: gap });
  }
  return gaps;
}

export function buildReport({
  aiWords,
  truthWords,
  anchors,
  resolved,
  corrections,
  gapThreshold = 2.5,
}) {
  const counts = {
    replace: 0,
    punctuation: 0,
    case: 0,
    insert: 0,
    delete: 0,
  };
  for (const c of corrections) if (c.type in counts) counts[c.type]++;

  const inserted = resolved.filter((r) => r.kind === 'ins').length;
  const deleted = resolved.filter((r) => r.kind === 'del').length;
  const matched = resolved.filter((r) => r.kind === 'sub').length;

  const lowConfidence = corrections.filter((c) => c.confidence < 0.5);

  return {
    sourceWords: aiWords.length,
    truthWords: truthWords.length,
    anchors: anchors.length,
    aligned: matched + anchors.length,
    matched,
    inserted,
    deleted,
    replacements: counts.replace,
    punctuationOnly: counts.punctuation,
    caseOnly: counts.case,
    gaps: detectGaps(aiWords, gapThreshold),
    lowConfidence: lowConfidence.map((c) => ({ blockId: c.blockId, wordId: c.wordId, type: c.type, confidence: c.confidence })),
    corrections: corrections.length,
  };
}
