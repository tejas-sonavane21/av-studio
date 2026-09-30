/**
 * main.js — bootstrap and wiring.
 *
 * The whole pipeline, end to end:
 *
 *   AI source (Veed JSON) ─┐
 *                          ├─▶ align/* ─▶ corrections + report ─▶ caption document ─▶ preview
 *   TRUTH source (SRT/VTT)─┘
 *
 * Phase 2 adds the right-hand end of that chain: a caption document is rendered to a canvas by
 * `render/canvas2d.js`, over the video when one is loaded, on a clock. Nothing here contains
 * rendering logic — it only translates DOM events into calls on `editor/preview.js`.
 *
 * Phase 4 adds the editing layer: templates (`templates/`), direct manipulation of a caption's
 * position through the overlay (`editor/canvas-overlay.js`) and sparse per-block overrides
 * (`templates/merge.js`). The pattern that keeps this file small is that **every edit is a call to
 * a pure function in another module and then a redraw** — there is no editing state in here beyond
 * `selectedBlockId`.
 *
 * Must be served over http://localhost (see README): ES modules and `captureStream` need an origin.
 */

import { createStore } from './store/store.js';
import { parseSRT } from './io/srt.js';
import { parseVTT } from './io/vtt.js';
import { importJSON } from './io/project-file.js';
import { alignCaptions } from './align/aligner.js';
import { validateDocument } from './model/document.js';
import { createDefaultStyle } from './model/schema.js';
import { documentFromAlignment } from './model/pipeline.js';
import { createDemoDocument } from './model/demo.js';
import { setBlockText, setWordText } from './model/edit.js';
import { createPreview } from './editor/preview.js';
import { createCanvasOverlay } from './editor/canvas-overlay.js';
import { fontFamilies, getFont } from './fonts/registry.js';
import { DISPLAY_MODES, resolveStyle } from './model/schema.js';
import { REVEAL_MODES, EMPHASIS_SOURCES } from './render/time.js';
import { animationNames } from './render/animation.js';
import { PRESET_IDS, anchorFromPreset, clampAnchorToCanvas, describeAnchor, presetFor } from './render/placement.js';
import { allSwatches, getTemplate, templatesByOrigin } from './templates/index.js';
import {
  applyTemplate,
  clearBlockOverrides,
  clearBlockPlacement,
  currentTemplateId,
  findBlock,
  isTemplateUnmodified,
  overrideSummary,
  promoteBlockToDocument,
  setBlockOverrides,
  setBlockPlacement,
} from './templates/merge.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const store = createStore({ video: null, audio: null, aiDoc: null, truthCues: null, result: null, log: [] });

let videoUrl = null;
let audioUrl = null;
let preview = null;
let overlay = null;
// The only editing state this module owns: which block the inspector edits. Everything else about
// an edit lives in the document (overrides / placement) or in a registry.
let selectedBlockId = null;
let uiBusy = false;
// Bumped by every template application, so an overlapping application cannot repaint last.
let templateRequest = 0;

// ---------------------------------------------------------------------------
// logging + status
// ---------------------------------------------------------------------------

function log(msg) {
  const state = store.getState();
  store.setState({ log: [...state.log, msg] });
  console.log('[caption-studio]', msg);
  renderLog();
}

function setStatus(text) {
  $('#status-badge').textContent = text;
}

function renderLog() {
  const { log: lines } = store.getState();
  const box = $('#log');
  box.classList.toggle('empty', lines.length === 0);
  box.textContent = lines.length ? lines.join('\n') : 'No activity yet.';
  box.scrollTop = box.scrollHeight;
}

function refreshAlignButton() {
  const s = store.getState();
  $('#align-btn').disabled = !(s.aiDoc && s.truthCues);
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

async function onVideo(file) {
  if (!file) return;
  store.setState({ video: file });
  log(`video loaded: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);

  const video = $('#preview-video');
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  preview?.setVideo(video);
  video.src = videoUrl;
  video.load();
  $('#play-btn').disabled = false;
  $('#video-toggle').checked = true;
  preview?.setVideoVisible(true);

  // adopt the video's native size for the document, unless a document already set one
  video.addEventListener(
    'loadedmetadata',
    () => {
      log(`video: ${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(2)}s`);
      const doc = preview?.document;
      if (doc) {
        doc.canvas = { ...doc.canvas, width: video.videoWidth, height: video.videoHeight };
        preview.resize();
        refreshSeekRange();
      }
    },
    { once: true },
  );
}

/**
 * Import the original audio track.
 *
 * Deliberately independent of the video input: the common Veed-style setup is a silent (or
 * screen-recorded) picture plus a separate master track, and the captions are what matters. The
 * preview then plays the two together — the audio drives the clock whenever no video is loaded,
 * and is force-muted against the video when there is one (see `applyAudioRouting` in preview.js).
 */
async function onAudio(file) {
  if (!file) return;
  store.setState({ audio: file });
  log(`audio loaded: ${file.name} (${(file.size / 1e6).toFixed(2)} MB)`);

  const audio = $('#preview-audio');
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file);
  preview?.setAudio(audio);
  audio.src = audioUrl;
  audio.load();
  // an audio-only session is still a session: the transport has to work with no picture at all
  $('#play-btn').disabled = false;
  $('#audio-tag').textContent = file.name;

  audio.addEventListener(
    'loadedmetadata',
    () => {
      if (Number.isFinite(audio.duration)) log(`audio: ${audio.duration.toFixed(2)}s`);
      refreshSeekRange();
    },
    { once: true },
  );
}

async function onAi(file) {
  if (!file) return;
  try {
    setStatus('reading AI source…');
    const { document: doc, kind } = importJSON(await file.text());
    store.setState({ aiDoc: doc });
    const words = doc.blocks.reduce((n, b) => n + b.words.length, 0);
    log(`AI source: "${file.name}" → ${doc.blocks.length} blocks, ${words} words`);
    if (kind !== 'veed') log(`note: detected as ${kind}`);
  } catch (err) {
    log(`ERROR importing AI source: ${err.message}`);
  } finally {
    setStatus('idle');
    refreshAlignButton();
  }
}

async function onTruth(file) {
  if (!file) return;
  try {
    setStatus('reading TRUTH source…');
    const text = await file.text();
    const isVtt = /\.vtt$/i.test(file.name);
    const { cues, warnings } = isVtt ? parseVTT(text) : parseSRT(text);
    store.setState({ truthCues: cues });
    log(`TRUTH source: "${file.name}" → ${cues.length} ${isVtt ? 'VTT' : 'SRT'} cues`);
    warnings.forEach((w) => log(`  ⚠ ${w}`));
  } catch (err) {
    log(`ERROR parsing TRUTH source: ${err.message}`);
  } finally {
    setStatus('idle');
    refreshAlignButton();
  }
}

// ---------------------------------------------------------------------------
// alignment → caption document
// ---------------------------------------------------------------------------

async function runAlignment() {
  const { aiDoc, truthCues } = store.getState();
  if (!aiDoc || !truthCues) return;
  try {
    setStatus('aligning…');
    const result = alignCaptions({
      aiBlocks: aiDoc.blocks.map((b) => ({ start: b.start, end: b.end, words: b.words })),
      truthCues,
    });
    const { errors, warnings } = validateDocument({ schemaVersion: 1, canvas: aiDoc.canvas, blocks: result.blocks });
    store.setState({ result: { ...result, errors, warnings } });

    const { report, corrections } = result;
    log(
      `alignment: ${report.aligned}/${report.sourceWords} aligned, ${report.anchors} anchors, ` +
        `${corrections.length} corrections`,
    );
    if (warnings.length) log(`  ${warnings.length} validation warning(s)`);
    errors.forEach((e) => log(`  ✖ ${e}`));

    renderReport();
    renderBlocks();
    renderCorrections();

    // and show it
    const doc = documentFromAlignment(result, aiDoc);
    await showDocument(doc, `corrected captions → ${doc.blocks.length} blocks`);
  } catch (err) {
    log(`ERROR during alignment: ${err.message}`);
    console.error(err);
  } finally {
    setStatus('idle');
  }
}

/** Hand a document to the preview and enable the transport. */
async function showDocument(doc, label = 'document') {
  const video = $('#preview-video');
  preview.setVideo(video);
  const fonts = await preview.setDocument(doc);
  if (!fonts.ok) {
    const missing = fonts.results.filter((r) => !r.ok).map((r) => `${r.family} ${r.weight}`).join(', ');
    log(`  ⚠ font fallback in use: ${missing} (drop a woff2 into src/fonts/packaged/ for exact parity)`);
  }
  $('#stage').classList.add('has-content');
  $('#play-btn').disabled = false;
  await syncStyleControls(doc.defaults);
  refreshSeekRange();
  // A new document invalidates any selection from the previous one.
  selectedBlockId = doc.blocks[0]?.id ?? null;
  renderBlocks();
  renderTemplates();
  selectBlock(selectedBlockId);
  log(`preview: ${label}`);
  return doc;
}

/**
 * Redraw after an edit that changed the *document* rather than the clock.
 *
 * Invalidating the layout engine is not strictly required (its key includes the style's content)
 * but it is cheap and removes any chance of a stale measurement surviving a font or size change —
 * and a stale measurement is exactly the "the font doesn't match" class of bug this project exists
 * to avoid.
 */
function redraw() {
  if (!preview?.document) return;
  preview.renderer.layoutEngine?.invalidate();
  preview.renderFrame(preview.currentTime());
  overlay?.refresh({ force: true });
}

/**
 * Edit the *document* defaults — what the style bar does, as opposed to a per-block override.
 *
 * Two extra steps beyond `preview.setDefaults()` matter: the picker has to re-render, because an
 * edit either makes the current template read as "· edited" or (when a value is edited back to the
 * template's own) makes that stop being true; and the guide layer has to repaint, because the box a
 * selection outline follows may have changed size. These edits keep `templateId`, so the picker can
 * always say which template the style came from.
 */
async function editDefaults(patch) {
  if (!preview?.document) return null;
  const defaults = await preview.setDefaults(patch);
  renderTemplates();
  overlay?.refresh({ force: true });
  return defaults;
}

// ---------------------------------------------------------------------------
// report / blocks / corrections panels
// ---------------------------------------------------------------------------

function stat(key, value) {
  const box = el('div', 'stat');
  box.append(el('div', 'k', key), el('div', 'v', String(value)));
  return box;
}

function renderReport() {
  const { result } = store.getState();
  const host = $('#report');
  host.replaceChildren();
  if (!result) {
    host.append(el('div', 'empty', 'Run the correction to see the report.'));
    return;
  }
  const r = result.report;
  const entries = [
    ['AI words', r.sourceWords],
    ['TRUTH words', r.truthWords],
    ['Anchors', r.anchors],
    ['Matched', r.matched],
    ['Inserted', r.inserted],
    ['Deleted', r.deleted],
    ['Replacements', r.replacements],
    ['Punctuation', r.punctuationOnly],
    ['Gaps ≥2.5s', r.gaps.length],
    ['Low conf.', r.lowConfidence.length],
    ['Corrections', r.corrections],
    ['Blocks', result.blocks.length],
  ];
  entries.forEach(([k, v]) => host.append(stat(k, v)));
}

const fmt = (t) => Number(t).toFixed(2).padStart(6, ' ');

/**
 * The block list doubles as the inspector's picker: a row is selected, seeking the playhead to it.
 *
 * Rows come from the *document*, not from the alignment result, because the document's blocks are
 * the ones that carry `overrides` / `placement` — the things the inspector edits.
 */
function renderBlocks() {
  const { result } = store.getState();
  const blocks = preview?.document?.blocks?.length ? preview.document.blocks : result?.blocks;
  const host = $('#blocks');
  host.replaceChildren();
  if (!blocks?.length) {
    host.append(el('div', 'empty', '—'));
    return;
  }
  for (const b of blocks) {
    const row = el('div', 'row');
    row.dataset.blockId = b.id;
    if (b.id === selectedBlockId) row.classList.add('active');
    row.append(el('div', 't', `${fmt(b.start)}–${fmt(b.end)}`));
    const body = el('div', 'body');
    body.append(document.createTextNode(b.text));
    if (b.words.some((w) => w.emphasis)) body.append(el('span', 'tag', ' emphasis'));
    const summary = overrideSummary(b);
    if (summary.count) body.append(el('span', 'tag', summary.text));
    if (b.placement) body.append(el('span', 'tag', presetFor(b.placement) ?? 'moved'));
    row.append(body);
    row.title = 'click to select this caption and scrub to it';
    row.addEventListener('click', () => {
      selectBlock(b.id);
      preview?.seek(b.start + 0.01);
    });
    host.append(row);
  }
}

function renderCorrections() {
  const { result } = store.getState();
  const host = $('#corrections');
  host.replaceChildren();
  $('#cor-count').textContent = result ? String(result.corrections.length) : '0';
  if (!result || result.corrections.length === 0) {
    host.append(el('div', 'empty', result ? 'No changes needed 🎉' : '—'));
    return;
  }
  for (const c of result.corrections) {
    const row = el('div', 'row');
    row.append(el('span', `tag ${c.type}`, c.type));
    const body = el('div', 'body');
    const from = c.from ? `${c.from} → ` : '';
    body.append(document.createTextNode(from + (c.to ?? '')));
    body.append(el('span', 'tag', `${Math.round(c.confidence * 100)}%`));
    row.append(body);
    host.append(row);
  }
}

// ---------------------------------------------------------------------------
// preview transport + style controls
// ---------------------------------------------------------------------------

function refreshSeekRange() {
  const duration = preview?.duration() ?? 0;
  const seek = $('#seek');
  seek.max = String(Math.max(0.01, duration));
  seek.disabled = duration <= 0;
}

function onFrame(t, doc) {
  $('#preview-time').textContent = `${t.toFixed(2)}s`;
  const seek = $('#seek');
  if (document.activeElement !== seek) seek.value = String(t);
  $('#seek-label').textContent = `${t.toFixed(2)} / ${(preview?.duration() ?? 0).toFixed(2)}`;
  if (doc) $('#play-btn').textContent = preview.playing ? '⏸ Pause' : '▶ Play';
}

function buildFontControls(defaults) {
  const familySelect = $('#font-family');
  familySelect.replaceChildren(
    ...fontFamilies().map((family) => {
      const option = el('option', null, family);
      option.value = family;
      return option;
    }),
  );
  const syncWeights = () => {
    const entry = getFont(familySelect.value);
    const weights = entry?.weights ?? [400, 700, 900];
    $('#font-weight').replaceChildren(
      ...weights.map((w) => {
        const option = el('option', null, String(w));
        option.value = String(w);
        return option;
      }),
    );
    $('#font-weight').value = String(
      weights.includes(defaults.font.weight) ? defaults.font.weight : weights[weights.length - 1],
    );
  };
  familySelect.addEventListener('change', async () => {
    syncWeights();
    await editDefaults({ font: { family: familySelect.value, weight: Number($('#font-weight').value) } });
    log(`font: ${familySelect.value} ${$('#font-weight').value}`);
  });
  $('#font-weight').addEventListener('change', async () => {
    await editDefaults({ font: { weight: Number($('#font-weight').value) } });
  });
  return syncWeights;
}

/**
 * Show the font size *and* the pixels it resolves to. The px figure is the whole point of the
 * width/height switch: 0.036 is 46.1 px against a 1280-wide frame and 24.8 px against its 690-px
 * height, and which one the reference video used is a visible, one-click difference.
 */
function updateSizeReadout() {
  const style = preview?.document?.defaults ?? createDefaultStyle();
  const canvas = preview?.document?.canvas ?? { width: 1280, height: 690 };
  const unit = style.font.sizeUnit === 'h' ? 'h' : 'w';
  const px = style.font.size * (unit === 'h' ? canvas.height : canvas.width);
  $('#size-out').textContent = `${style.font.size.toFixed(3)} → ${px.toFixed(1)}px`;
}

async function syncStyleControls(defaults) {
  const style = defaults ?? preview.document?.defaults ?? createDefaultStyle();
  if (!$('#font-family').options.length) buildFontControls(style);
  $('#font-family').value = style.font.family;
  const entry = getFont(style.font.family);
  const weights = entry?.weights ?? [style.font.weight];
  if (!$('#font-weight').options.length || [...$('#font-weight').options].length !== weights.length) {
    $('#font-weight').replaceChildren(
      ...weights.map((w) => {
        const o = el('option', null, String(w));
        o.value = String(w);
        return o;
      }),
    );
  }
  $('#font-weight').value = String(style.font.weight);
  $('#font-size').value = String(style.font.size);
  $('#size-unit').value = style.font.sizeUnit === 'h' ? 'h' : 'w';
  $('#wrap-width').value = String(style.wrapWidth);
  $('#wrap-out').textContent = style.wrapWidth.toFixed(2);
  $('#reveal-mode').value = style.reveal ?? 'progressive';
  $('#emphasis-decoration').value = style.emphasis?.decoration ?? 'none';
  $('#emphasis-source').value = style.emphasis?.source ?? 'keyword';
  updateSizeReadout();
}

function wirePreview() {
  $('#play-btn').addEventListener('click', async () => {
    if (!preview.document) return;
    preview.toggle();
    overlay?.refresh();
  });

  $('#seek').addEventListener('input', (e) => {
    const t = Number(e.target.value);
    preview.seek(t);
    $('#seek-label').textContent = `${t.toFixed(2)} / ${preview.duration().toFixed(2)}`;
    // a different block may now be on screen, so the selection outline has to follow
    overlay?.refresh();
  });

  $('#demo-btn').addEventListener('click', async () => {
    setStatus('building demo…');
    const doc = createDemoDocument();
    await showDocument(doc, `demo document (${doc.blocks.length} blocks, ${doc.blocks.reduce((n, b) => n + b.words.length, 0)} words)`);
    log('demo: a long line wraps to two lines at the parity wrap width (v10 would have shrunk it)');
    setStatus('idle');
  });

  $('#video-toggle').addEventListener('change', (e) => preview.setVideoVisible(e.target.checked));
  $('#mute-toggle').addEventListener('change', (e) => {
    preview.setMuted(e.target.checked);
    log(e.target.checked ? 'sound muted' : 'sound on');
  });
  $('#volume').addEventListener('input', (e) => preview.setVolume(Number(e.target.value)));
  $('#guides-toggle').addEventListener('change', (e) => preview.setOptions({ guides: e.target.checked }));
  $('#overlay-toggle').addEventListener('change', (e) => overlay?.setEnabled(e.target.checked));

  $('#font-size').addEventListener('input', async (e) => {
    const size = Number(e.target.value);
    await editDefaults({ font: { size } });
    updateSizeReadout();
  });
  $('#size-unit').addEventListener('change', async (e) => {
    await editDefaults({ font: { sizeUnit: e.target.value } });
    updateSizeReadout();
    log(`font size is now a fraction of canvas ${e.target.value === 'h' ? 'height (v10 rule)' : 'width (Veed rule)'}`);
  });
  $('#wrap-width').addEventListener('input', async (e) => {
    const wrapWidth = Number(e.target.value);
    $('#wrap-out').textContent = wrapWidth.toFixed(2);
    await editDefaults({ wrapWidth });
  });
  $('#reveal-mode').addEventListener('change', async (e) => {
    await editDefaults({ reveal: e.target.value });
    log(`reveal: ${e.target.value}`);
  });
  $('#emphasis-decoration').addEventListener('change', async (e) => {
    await editDefaults({ emphasis: { decoration: e.target.value } });
  });
  $('#emphasis-source').addEventListener('change', async (e) => {
    await editDefaults({ emphasis: { source: e.target.value } });
    log(
      e.target.value === 'active'
        ? 'emphasis follows the spoken word (karaoke)'
        : 'emphasis marks the AI keywords (Veed)',
    );
  });
  $('#reset-style').addEventListener('click', () => useTemplate('veed-auto-highlight'));
  $('#template-parity').addEventListener('click', () => useTemplate('veed-auto-highlight'));
}

// ---------------------------------------------------------------------------
// Phase 4 — templates
// ---------------------------------------------------------------------------

/** A tint for the swatch preview: a template with no decoration still needs to look like itself. */
function swatchMarkup(swatch) {
  const span = el('span');
  span.textContent = swatch.uppercase ? 'CAPTION' : 'Caption';
  span.style.color = swatch.fill;
  if (swatch.fontFamily) span.style.fontFamily = `"${swatch.fontFamily}", sans-serif`;
  if (swatch.fontWeight) span.style.fontWeight = String(swatch.fontWeight);
  if (swatch.uppercase) span.style.letterSpacing = '0.04em';
  if (swatch.stroke) span.style.webkitTextStroke = `${Math.max(1, swatch.strokeWidth)}px ${swatch.stroke}`;
  const mark = el('b');
  mark.textContent = 'style';
  if (swatch.emphasis === 'underline') {
    mark.style.borderBottom = `3px solid ${swatch.emphasisColor ?? swatch.fill}`;
    mark.style.fontStyle = 'italic';
  } else if (swatch.emphasis === 'highlight') {
    mark.style.background = swatch.emphasisColor ?? swatch.background ?? 'rgba(124,58,237,0.95)';
    mark.style.padding = '0 4px';
  }
  span.append(document.createTextNode(' '), mark);
  return span;
}

/** One template tile. Everything visual comes from the registry's derived swatch, never hand-written. */
function templateTile(swatch) {
  const tile = el('button', 'tile');
  tile.type = 'button';
  tile.dataset.id = swatch.id;
  const previewBox = el('div', 'preview');
  if (swatch.background) previewBox.style.background = swatch.background;
  previewBox.append(swatchMarkup(swatch));
  const meta = el('div', 'meta');
  meta.append(el('span', 'name', swatch.name), el('span', 'tag', swatch.origin));
  tile.append(previewBox, meta, el('div', 'desc', swatch.description));
  tile.title = `${swatch.name} — reveal: ${swatch.reveal}, emphasis: ${swatch.emphasis} (${swatch.emphasisSource})`;
  tile.addEventListener('click', () => useTemplate(swatch.id));
  return tile;
}

function renderTemplates() {
  const host = $('#templates');
  if (!host) return;
  host.replaceChildren();
  const swatches = new Map(allSwatches().map((s) => [s.id, s]));
  for (const group of templatesByOrigin()) {
    host.append(el('div', 'origin-heading', `${group.origin} (${group.templates.length})`));
    for (const def of group.templates) host.append(templateTile(swatches.get(def.id)));
  }
  const doc = preview?.document;
  const id = doc ? currentTemplateId(doc) : 'veed-auto-highlight';
  const def = getTemplate(id);
  const edited = doc ? !isTemplateUnmodified(doc) : false;
  $('#template-status').textContent = def ? `${def.name}${edited ? ' · edited' : ''}` : 'unstyled';
  host.querySelectorAll('.tile').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
}

/**
 * Switch the document to a template.
 *
 * This is the whole "apply" path: replace the defaults, re-resolve fonts (the new template may name
 * a family that is not loaded yet — measuring with a fallback face is the classic "font doesn't
 * match" bug), redraw, and resync the controls. Per-block overrides and placements survive by
 * design (see the merge order in `templates/merge.js`).
 */
async function useTemplate(id) {
  const doc = preview?.document;
  const def = getTemplate(id);
  if (!def) return;
  if (!doc) {
    log(`template "${def.name}" needs a document — load a source or open the demo first`);
    return;
  }
  applyTemplate(doc, id);
  // Applying is synchronous, so a burst of clicks leaves the *document* on the last template. But
  // `ensureFonts` is async, so without a token the slower of two overlapping applications would
  // repaint the controls last and the picker would end up showing a template the document is not
  // on. The token makes every application but the newest a no-op after its await.
  const token = ++templateRequest;
  const fonts = await preview.renderer.ensureFonts(doc);
  if (token !== templateRequest) return;
  if (!fonts.ok) {
    const missing = fonts.results.filter((r) => !r.ok).map((r) => `${r.family} ${r.weight}`).join(', ');
    log(`  ⚠ font fallback in use: ${missing}`);
  }
  redraw();
  await syncStyleControls(doc.defaults);
  renderTemplates();
  renderBlockInspector();
  log(`template: ${def.name} (${def.origin})`);
}

// ---------------------------------------------------------------------------
// Phase 4 — selection, placement and per-block overrides
// ---------------------------------------------------------------------------

function selectedBlock() {
  return preview?.document ? findBlock(preview.document, selectedBlockId) : null;
}

/** Everything that has to change when the selection changes, in one place. */
function updateSelectionUI() {
  if (uiBusy) return;
  uiBusy = true;
  try {
    const doc = preview?.document;
    // Auto-select the first block so the inspector is useful the moment a document appears.
    if (doc?.blocks?.length && !findBlock(doc, selectedBlockId)) {
      selectedBlockId = doc.blocks[0].id;
      overlay?.select(selectedBlockId);
    }
    renderBlockStatus();
    document.querySelectorAll('#blocks .row').forEach((row) => {
      row.classList.toggle('active', row.dataset.blockId === selectedBlockId);
    });
    renderBlockInspector();
    overlay?.refresh({ force: true });
  } finally {
    uiBusy = false;
  }
}

function renderBlockStatus() {
  const doc = preview?.document;
  const block = selectedBlock();
  const tag = $('#block-status');
  if (!tag) return;
  if (!block) {
    tag.textContent = doc?.blocks?.length ? 'auto' : 'none';
    return;
  }
  const i = doc.blocks.indexOf(block);
  const anchor = block.placement ?? doc.defaults.anchor;
  tag.textContent = `${i + 1}/${doc.blocks.length} · ${describeAnchor(anchor)}${block.placement ? '' : ' (inherit)'}`;
}

function selectBlock(id) {
  const next = id ?? null;
  if (next === selectedBlockId) {
    updateSelectionUI();
    return next;
  }
  selectedBlockId = next;
  // Let the overlay drive the UI update when it owns the selection, so its own state cannot
  // disagree with ours. Otherwise do it here.
  if (overlay && overlay.selectedId !== next) overlay.select(next);
  else updateSelectionUI();
  return next;
}

/**
 * Redraw, then refresh every piece of UI that reads the selected block.
 *
 * Used by the edits that *change what is selected or where it is* (reset, promote, drag commit,
 * keyboard nudge) — as opposed to `applyBlockPatch`, which deliberately leaves the inspector's
 * controls alone so a slider being dragged does not lose the pointer. Forgetting one of these
 * refreshes is exactly how the position readout ended up showing a stale anchor.
 */
function afterBlockEdit() {
  redraw();
  renderBlocks();
  renderBlockStatus();
  renderBlockInspector();
}

/** Sparse patch onto the selected block's overrides. */
function applyBlockPatch(patch) {
  const doc = preview?.document;
  const block = selectedBlock();
  if (!doc || !block) return null;
  setBlockOverrides(doc, block.id, patch);
  redraw();
  renderBlockStatus();
  renderBlocks();
  return block.overrides;
}

/** Commit a position for the selected block (used by the overlay's drag/nudge callbacks). */
function placeSelected(blockId, anchor, info = {}) {
  const doc = preview?.document;
  if (!doc || !blockId) return null;
  selectedBlockId = blockId;
  const block = findBlock(doc, blockId);
  if (!block) return null;
  setBlockPlacement(
    doc,
    blockId,
    { posX: anchor.posX, posY: anchor.posY, gravity: anchor.gravity ?? doc.defaults.anchor?.gravity ?? 'center' },
    { preset: info.preset ?? null },
  );
  if (info.live) redraw();
  else afterBlockEdit();
  return block.placement;
}

/**
 * Move the selected block to a named preset.
 *
 * The preset's own numbers are used (`anchorFromPreset`), then clamped so a large box at an edge
 * preset is slid inside the frame rather than hanging off it. Snapping is deliberately *not* applied:
 * a preset must land where the preset says, not wherever a nearby guide happens to be.
 */
function applyAnchorPreset(id) {
  const doc = preview?.document;
  const block = selectedBlock();
  if (!doc || !block) return;
  if (id === 'inherit') {
    clearBlockPlacement(doc, block.id);
    afterBlockEdit();
    log('block position: reset to the document default');
    return;
  }
  const preset = anchorFromPreset(id);
  if (!preset) return;
  const layout = (preview.layouts ?? []).find((l) => l.blockId === block.id);
  const box = layout ? { width: layout.width, height: layout.height } : null;
  let anchor = preset;
  if (box) {
    const clamped = clampAnchorToCanvas(preset, { canvas: preview.renderer.size, box });
    anchor = { ...preset, posX: clamped.anchor.posX, posY: clamped.anchor.posY };
  }
  setBlockPlacement(
    doc,
    block.id,
    { posX: anchor.posX, posY: anchor.posY, gravity: preset.gravity ?? doc.defaults.anchor?.gravity ?? 'center' },
    { preset: presetFor(anchor) },
  );
  afterBlockEdit();
  log(`block position: ${id}`);
}

// --- the inspector's form controls -----------------------------------------

function fieldInline(labelText, control) {
  const wrap = el('label', 'field-inline');
  wrap.append(el('span', null, labelText), control);
  return wrap;
}

function buildSelect(values, current, onChange) {
  const s = el('select');
  for (const v of values) {
    const value = typeof v === 'object' ? v.value : v;
    const option = el('option', null, typeof v === 'object' ? v.label : String(v));
    option.value = value === null ? '' : String(value);
    s.append(option);
  }
  s.value = current === null || current === undefined ? '' : String(current);
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function buildText(value, onChange, { placeholder = '' } = {}) {
  const input = el('input');
  input.type = 'text';
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

function buildRange({ min, max, step, value, onInput }) {
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value)));
  return input;
}

/**
 * The block inspector.
 *
 * Rebuilt from scratch whenever the selection changes and *not* on every edit — a rebuild during a
 * range drag would steal the slider out from under the pointer. Handlers therefore call
 * `applyBlockPatch(self)` and read the input's own value, so no control ever holds stale state.
 */
function renderBlockInspector() {
  const host = $('#block-inspector');
  if (!host) return;
  const doc = preview?.document;
  const block = selectedBlock();
  host.replaceChildren();
  if (!doc?.blocks?.length || !block) {
    host.className = 'empty';
    host.append(
      document.createTextNode('Click a caption on the canvas (or a row in “Corrected blocks”) to edit just that one.'),
    );
    return;
  }
  host.className = '';
  const style = resolveStyle(doc, block);
  const anchor = block.placement ?? doc.defaults.anchor;
  const summary = overrideSummary(block);

  const meta = el('div', 'block-meta');
  meta.append(document.createTextNode(`${fmt(block.start)}–${fmt(block.end)}  `));
  const metaText = el('b', null, block.text.slice(0, 90));
  metaText.id = 'block-meta-text';
  meta.append(metaText);
  meta.append(el('div', 'hint', `${summary.text} · position ${describeAnchor(anchor)} (${presetFor(anchor) ?? 'custom'})`));
  host.append(meta);

  const grid = el('div', 'inspector-grid');
  const weights = getFont(style.font.family)?.weights ?? [style.font.weight];

  // The content edit sits first and spans the grid: it is the reason most people open this panel.
  const textInput = buildText(block.text, (v) => onBlockText(v), {
    placeholder: 'the caption exactly as it should read',
  });
  textInput.id = 'block-text-input';
  const textField = fieldInline('Caption text', textInput);
  textField.classList.add('field-wide');

  grid.append(
    textField,
    fieldInline(
      'Block',
      buildSelect(
        doc.blocks.map((b, i) => ({ value: b.id, label: `${i + 1}. ${b.text.slice(0, 28)}` })),
        block.id,
        (id) => selectBlock(id),
      ),
    ),
    fieldInline(
      'Position',
      buildSelect(
        [{ value: 'inherit', label: 'inherit (document default)' }, ...PRESET_IDS, { value: 'custom', label: 'custom (dragged)' }],
        block.placement ? (presetFor(block.placement) ?? 'custom') : 'inherit',
        (id) => (id === 'custom' ? null : applyAnchorPreset(id)),
      ),
    ),
    fieldInline(
      'Display',
      buildSelect(DISPLAY_MODES, style.display, (v) => {
        applyBlockPatch({ display: v });
        renderBlockInspector();
      }),
    ),
    fieldInline(
      `Fill ${style.fill.color}`,
      buildText(style.fill.color, (v) => applyBlockPatch({ fill: { color: v } }), { placeholder: '#ffffff or rgba(...)' }),
    ),
    fieldInline(
      `Size ${style.font.size.toFixed(3)}`,
      buildRange({
        min: 0.01,
        max: 0.12,
        step: 0.001,
        value: style.font.size,
        onInput: (v) => applyBlockPatch({ font: { size: v } }),
      }),
    ),
    fieldInline(
      'Weight',
      buildSelect(weights, style.font.weight, (v) => applyBlockPatch({ font: { weight: Number(v) } })),
    ),
    fieldInline(
      'Case',
      buildSelect(['none', 'upper', 'lower', 'title'], style.font.case ?? 'none', (v) => applyBlockPatch({ font: { case: v } })),
    ),
    fieldInline('Reveal', buildSelect(REVEAL_MODES, style.reveal, (v) => applyBlockPatch({ reveal: v }))),
    fieldInline(
      'Emphasis',
      buildSelect(['underline', 'highlight', 'none'], style.emphasis?.decoration ?? 'none', (v) =>
        applyBlockPatch({ emphasis: { decoration: v } }),
      ),
    ),
    fieldInline(
      'Emphasis on',
      buildSelect(EMPHASIS_SOURCES, style.emphasis?.source ?? 'keyword', (v) =>
        applyBlockPatch({ emphasis: { source: v } }),
      ),
    ),
    fieldInline(
      `Emphasis colour ${style.emphasis?.decorationColor ?? '—'}`,
      buildText(style.emphasis?.decorationColor ?? '', (v) => applyBlockPatch({ emphasis: { decorationColor: v || null } }), {
        placeholder: '#22c55e',
      }),
    ),
    fieldInline(
      'Animation in',
      buildSelect(animationNames(), style.animation?.in ?? 'none', (v) => applyBlockPatch({ animation: { in: v } })),
    ),
    fieldInline(
      'Animation out',
      buildSelect(['none', ...animationNames()], style.animation?.out ?? 'none', (v) =>
        applyBlockPatch({ animation: { out: v === 'none' ? null : v } }),
      ),
    ),
  );
  host.append(grid);

  const words = el('div', 'word-list');
  words.id = 'word-editor';
  host.append(words);
  renderWordEditor();

  const actions = el('div', 'actions');
  const applyAll = el('button', 'ghost', 'Apply look to all captions');
  applyAll.addEventListener('click', () => {
    promoteBlockToDocument(doc, block.id);
    afterBlockEdit();
    renderTemplates();
    log('promoted this block\'s look (and position) to every caption');
  });
  const resetBlock = el('button', 'ghost', 'Reset this block');
  resetBlock.addEventListener('click', () => {
    clearBlockOverrides(doc, block.id);
    afterBlockEdit();
    log('block reset — it inherits the document style and position again');
  });
  const resetPosition = el('button', 'ghost', 'Reset position');
  resetPosition.addEventListener('click', () => {
    clearBlockPlacement(doc, block.id);
    afterBlockEdit();
  });
  actions.append(applyAll, resetBlock, resetPosition);
  host.append(actions);
}

/**
 * Apply a whole-line text edit to the selected block.
 *
 * Unlike `applyBlockPatch`, this must *not* rebuild the inspector: a `change` event fires as the
 * field is left, and a rebuild at that instant would pull the next control out from under the
 * user's click — the same reason a range drag is never re-rendered. Only the parts of the UI that
 * display the block's content are refreshed.
 */
function onBlockText(text) {
  const doc = preview?.document;
  const block = selectedBlock();
  if (!doc || !block) return;
  setBlockText(doc, block.id, text);
  refreshBlockContent();
  log(`caption text: "${block.text}"`);
}

/** Refresh every view of the selected block's content without rebuilding its controls. */
function refreshBlockContent() {
  const block = selectedBlock();
  redraw();
  renderBlocks();
  renderBlockStatus();
  const metaText = $('#block-meta-text');
  if (metaText && block) metaText.textContent = block.text.slice(0, 90);
  renderWordEditor();
}

/**
 * The word strip: one editable input per word, tagged with that word's own timing.
 *
 * A single wrong word is the common correction, and editing it here leaves its `start`/`end`
 * untouched — whereas retyping the whole line can only preserve timings while the word count holds.
 */
function renderWordEditor() {
  const host = $('#word-editor');
  if (!host) return;
  const block = selectedBlock();
  host.replaceChildren();
  if (!block) return;
  if (!block.words.length) {
    host.append(el('div', 'hint', 'this caption has no words — type a line above to give it some back'));
    return;
  }
  block.words.forEach((w, i) => {
    const chip = el('label', 'word-chip');
    chip.append(el('span', 'word-time', `${fmt(w.start)}–${fmt(w.end)}`));
    const input = el('input');
    input.type = 'text';
    input.value = w.text;
    input.addEventListener('change', () => {
      const current = selectedBlock();
      if (!current) return;
      setWordText(preview.document, current.id, i, input.value);
      refreshBlockContent();
      log(`word ${i + 1}: "${input.value}"`);
    });
    chip.append(input);
    host.append(chip);
  });
}

/** Build the overlay once a document exists — it needs the renderer's size and layouts. */
function createOverlay() {
  if (overlay) return overlay;
  overlay = createCanvasOverlay({
    canvas: $('#preview-canvas'),
    overlay: $('#overlay-canvas'),
    preview,
    onSelect: (id) => {
      selectedBlockId = id ?? null;
      updateSelectionUI();
    },
    onPlace: (blockId, anchor, info) => placeSelected(blockId, anchor, info),
  });
  return overlay;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

preview = createPreview({
  canvas: $('#preview-canvas'),
  container: $('#stage'),
  video: $('#preview-video'),
  audio: $('#preview-audio'),
  onFrame,
});

createOverlay();

$('#video-in').addEventListener('change', (e) => onVideo(e.target.files?.[0]));
$('#audio-in').addEventListener('change', (e) => onAudio(e.target.files?.[0]));
$('#ai-in').addEventListener('change', (e) => onAi(e.target.files?.[0]));
$('#truth-in').addEventListener('change', (e) => onTruth(e.target.files?.[0]));
$('#align-btn').addEventListener('click', runAlignment);

wirePreview();
syncStyleControls(createDefaultStyle());
renderTemplates();
log('ready — load an AI source and a TRUTH subtitle file, or click "Demo document"');
log('tip: add the original Audio (optional) to hear the preview play, even with no video');
log('tip: click a caption to select it, drag it to move, arrow keys to nudge (shift = ×4)');
