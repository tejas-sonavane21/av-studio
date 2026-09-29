import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseSRT } from '../../src/io/srt.js';
import { buildLineOccurrences, wordsFromCues } from '../../src/align/rolling.js';
import { parseVeedJSON } from '../../src/io/veed-json.js';
import { alignCaptions } from '../../src/align/aligner.js';
import { validateDocument } from '../../src/model/document.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const refDir = path.resolve(here, '../../../referece_material/version10');
const srtPath = path.join(refDir, 'spidy.srt');
const jsonPath = path.join(refDir, 'veed_master_v3_65415659-710f-40b8-b0f5-e91f7e22abe6.json');

test('spidy.srt resolves into a monotonic word stream', (t) => {
  if (!existsSync(srtPath)) return t.skip('spidy.srt not present');
  const { cues } = parseSRT(readFileSync(srtPath, 'utf8'));
  assert.equal(cues.length, 40, 'expected 40 rolling cues');

  const occ = buildLineOccurrences(cues);
  assert.ok(occ.length >= 30 && occ.length <= 45, `occurrences=${occ.length}`);

  const { words } = wordsFromCues(cues);
  assert.ok(Math.abs(words[0].start - 12) < 1e-6, `first word starts at ${words[0].start}`);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].start >= words[i - 1].start - 1e-9, `monotonic at ${i}`);
  }
  assert.ok(words[words.length - 1].end >= 175, 'covers most of the song');
});

test('alignment corrects the Veed transcription against spidy.srt', (t) => {
  if (!existsSync(srtPath) || !existsSync(jsonPath)) return t.skip('reference files not present');

  const veed = parseVeedJSON(JSON.parse(readFileSync(jsonPath, 'utf8')));
  const { cues } = parseSRT(readFileSync(srtPath, 'utf8'));

  const { blocks, corrections, report } = alignCaptions({
    aiBlocks: veed.blocks.map((b) => ({ start: b.start, end: b.end, words: b.words })),
    truthCues: cues,
  });

  assert.deepEqual(validateDocument({ schemaVersion: 1, canvas: veed.canvas, blocks }).errors, []);
  assert.ok(blocks.length > 20, `blocks=${blocks.length}`);
  assert.ok(report.anchors > 20, `anchors=${report.anchors}`);

  const crush = corrections.find((c) => c.type === 'replace' && /crush/i.test(c.from || ''));
  assert.ok(crush, 'expected a crush -> catch correction');
  assert.match(crush.to, /catch/i);

  const text = blocks.map((b) => b.text).join(' ');
  assert.doesNotMatch(text, /crush the falling/i, 'TRUTH spelling should win');
});
