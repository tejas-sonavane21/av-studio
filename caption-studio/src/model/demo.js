/**
 * model/demo.js — a small built-in caption document.
 *
 * Why this exists: the renderer, the anchor math and the wrapping all need to be exercised
 * *visually* before any real files are loaded, and neither `referece_material/` (outside the
 * served root) nor a user's SRT is available over HTTP. A hard-coded document makes the preview
 * testable in one click, and doubles as a stable fixture for the visual harness.
 *
 * The first block is lifted from the **real** extracted Veed data
 * (`referece_material/version10/veed_master_v3_…json`, block `15.2–16.72`), including its
 * `styles[0] = {from: 0, to: 4}` emphasis range on `Just` and the `👦` emoji on `boy` — so it
 * exercises emphasis ranges *and* the emoji-off default. The other blocks add a long line (to
 * show wrapping) and a mid-line keyword.
 */

import { normalizeDocument, rebuildBlockText } from './document.js';
import { createBlock, createDocument, createWord } from './schema.js';

/** Attach an `auto-highlight` emphasis range covering one word of a block. */
function emphasise(block, wordIndex) {
  const w = block.words[wordIndex];
  block.styles = [
    {
      from: w.charFrom,
      to: w.charTo,
      id: 'auto-highlight',
      style: { bold: false, italic: true, color: '#ffffff', underline: true },
    },
  ];
  return block;
}

/** Build a block from `[text, start, end]` triples. */
function block(start, end, words) {
  return createBlock(
    start,
    end,
    words.map(([text, s, e, extra]) => createWord(text, s, e, extra)),
  );
}

export const DEMO_BLOCKS = [
  {
    start: 15.2,
    end: 16.72,
    emphasis: 0, // "Just"
    words: [
      ['Just', 15.2, 15.36],
      ['an', 15.36, 15.48],
      ['ordinary', 15.48, 16.1],
      ['boy', 16.1, 16.72, { emoji: '👦' }],
    ],
  },
  {
    // deliberately long: at the parity wrap width this wraps to two lines, which is the
    // capability v10 lacked (it would have shrunk the font to force one line instead)
    start: 17.68,
    end: 20.9,
    emphasis: 5, // "stop"
    words: [
      ['Head', 17.68, 17.85],
      ['in', 17.85, 17.98],
      ['the', 17.98, 18.14],
      ['books,', 18.14, 18.44],
      ["can't", 18.44, 18.62],
      ['stop', 18.62, 18.86],
      ['staring', 18.86, 19.3],
      ['at', 19.3, 19.44],
      ['the', 19.44, 19.58],
      ['stars', 19.58, 20.0],
      ['and', 20.0, 20.14],
      ['the', 20.14, 20.28],
      ['night', 20.28, 20.52],
      ['never', 20.52, 20.72],
      ['sleeps', 20.72, 20.9],
    ],
  },
  {
    start: 21.0,
    end: 23.2,
    emphasis: 2, // "burden" — the word the aligner corrected from Veed's "burning"
    words: [
      ["A", 21.0, 21.1],
      ["hero's", 21.1, 21.6],
      ['burden,', 21.6, 22.3],
      ['I', 22.3, 22.4],
      ['catch', 22.4, 22.8],
      ['the', 22.8, 22.9],
      ['falling', 22.9, 23.2],
    ],
  },
];

/**
 * Create the demo document: 1280×720, the `veed-auto-highlight` defaults, three blocks.
 * Returned in canonical form (text rebuilt, emphasis flags resolved, validated invariants).
 */
export function createDemoDocument() {
  const doc = createDocument({
    name: 'Demo — Veed auto-highlight (parity)',
    canvas: { width: 1280, height: 720, fps: 25 },
    media: { videoRef: null, duration: 25, audioRef: null },
    sources: { ai: { kind: 'demo', ref: 'model/demo.js' }, truth: null },
  });

  doc.blocks = DEMO_BLOCKS.map((spec) => {
    const b = block(spec.start, spec.end, spec.words);
    rebuildBlockText(b); // fills word.charFrom/charTo so the style range can reference them
    emphasise(b, spec.emphasis);
    return b;
  });

  normalizeDocument(doc);
  return doc;
}

/** The demo document's caption text, one line per block — handy in tests and logs. */
export function demoLines() {
  return DEMO_BLOCKS.map((b) => b.words.map((w) => w[0]).join(' '));
}
