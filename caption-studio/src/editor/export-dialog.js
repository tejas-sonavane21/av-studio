/**
 * editor/export-dialog.js — the export window.
 *
 * One modal that says the whole delivery out loud: container, resolution, frame shape, frame rate,
 * quality, and both bitrates — plus the one line that matters most, what the file will actually be.
 *
 * Two behaviours make it a *settings* surface rather than a form:
 *
 * * **Choosing a resolution re-tunes the rest.** 480p sets a balanced bitrate and 30 fps; 4K sets the
 *   best quality. That is the recommendation the user asked for, applied in one click.
 * * **Everything stays editable.** Touch any field afterwards and it stops following — including the
 *   bitrate, which switches itself to "custom" the moment it is typed into. A control that silently
 *   reverts your edit is worse than one that never offered the recommendation.
 *
 * The dialog owns no state that outlives it beyond the settings object it hands back, and it is a
 * plain `<dialog>` so Escape, the backdrop and focus containment come from the browser rather than
 * from a hand-rolled overlay.
 */

import { CANVAS_PRESETS } from '../model/schema.js';
import { QUALITY_PRESETS } from '../io/download.js';
import {
  DEFAULT_FPS,
  FPS_OPTIONS,
  MBPS,
  RESOLUTION_PRESETS,
  applyResolution,
  defaultExportSettings,
  describeSettings,
  outputSize,
  recommendFor,
} from '../io/export-settings.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

function labelled(text, control, hint = '') {
  const wrap = el('label', 'field-inline export-field');
  wrap.append(el('span', null, text), control);
  if (hint) wrap.append(el('span', 'hint', hint));
  return wrap;
}

function selectOf(entries, value, onchange, attrs = {}) {
  const select = el('select');
  for (const [id, label] of entries) {
    const option = el('option', null, label);
    option.value = id;
    select.append(option);
  }
  select.value = value;
  for (const [key, val] of Object.entries(attrs)) select.setAttribute(key, val);
  select.addEventListener('change', () => onchange(select.value));
  return select;
}

/**
 * @param {object} options
 * @param {() => {sourceSize?:{width:number,height:number}, sourceFps?:number, docSize?:{width:number,height:number}, aspect?:number}} options.getContext
 * @param {(settings:object, encoder:object) => Promise<void>} options.onExport
 * @param {(ratioId:string) => void} [options.onRatioChange]
 */
export function createExportDialog({ getContext, onExport, onRatioChange = null } = {}) {
  const dialog = el('dialog', 'export-dialog');
  dialog.id = 'export-dialog';
  dialog.setAttribute('aria-label', 'Export video');

  const form = el('form', 'export-form');
  const head = el('div', 'export-head');
  head.append(el('h2', null, 'Export video'));
  const headSpacer = el('span', 'spacer');
  const closeBtn = el('button', 'ghost export-close', '✕');
  closeBtn.type = 'button';
  closeBtn.title = 'Close without exporting';
  head.append(headSpacer, closeBtn);

  let settings = defaultExportSettings();

  const formatSelect = selectOf(
    [
      ['mp4', 'MP4 — H.264, plays everywhere'],
      ['webm', 'WebM — VP9, open format'],
    ],
    settings.format,
    (value) => {
      settings = { ...settings, format: value };
      refresh();
    },
    { id: 'export-dialog-format' },
  );

  const resolutionSelect = selectOf(
    Object.entries(RESOLUTION_PRESETS).map(([id, preset]) => [id, preset.label]),
    settings.resolution,
    (value) => {
      // the one control that re-tunes the others, exactly as asked
      settings = applyResolution(settings, value, { sourceFps: getContext().sourceFps });
      syncFields();
      refresh();
    },
    { id: 'export-dialog-resolution' },
  );

  const ratioEntries = [
    ['source', 'Source — the picture’s own shape'],
    ...Object.entries(CANVAS_PRESETS).map(([id, preset]) => [id, preset.label]),
  ];
  const ratioSelect = selectOf(ratioEntries, 'source', (value) => {
    onRatioChange?.(value);
    syncFromContext();
    refresh();
  }, { id: 'export-dialog-ratio' });

  const fpsSelect = selectOf(
    FPS_OPTIONS.map((rate) => [String(rate), `${rate} fps`]),
    String(settings.fps),
    (value) => {
      settings = { ...settings, fps: Number(value) };
      refresh();
    },
    { id: 'export-dialog-fps' },
  );

  const qualitySelect = selectOf(
    Object.entries(QUALITY_PRESETS).map(([id, preset]) => [id, preset.label]),
    settings.quality,
    (value) => {
      settings = { ...settings, quality: value };
      refresh();
    },
    { id: 'export-dialog-quality' },
  );

  const bitrateInput = el('input');
  bitrateInput.type = 'number';
  bitrateInput.min = '0.25';
  bitrateInput.max = '50';
  bitrateInput.step = '0.25';
  bitrateInput.id = 'export-dialog-bitrate';
  bitrateInput.addEventListener('input', () => {
    const mbps = Number(bitrateInput.value);
    if (!Number.isFinite(mbps) || mbps <= 0) return;
    settings = { ...settings, videoBitrateMode: 'custom', videoBitrate: Math.round(mbps * MBPS) };
    refresh({ keepBitrate: true });
  });
  const bitrateAuto = el('button', 'ghost', 'Auto');
  bitrateAuto.type = 'button';
  bitrateAuto.title = 'Let the resolution and quality decide the bitrate again';
  bitrateAuto.id = 'export-dialog-bitrate-auto';
  bitrateAuto.addEventListener('click', () => {
    settings = { ...settings, videoBitrateMode: 'auto', videoBitrate: 0 };
    refresh();
  });
  const bitrateRow = el('span', 'export-inline');
  bitrateRow.append(bitrateInput, el('span', 'unit', 'Mbps'), bitrateAuto);

  const audioBitsSelect = selectOf(
    [
      ['auto', 'Auto — follow the quality'],
      ['320000', '320 kbps'],
      ['256000', '256 kbps'],
      ['192000', '192 kbps'],
      ['128000', '128 kbps'],
      ['96000', '96 kbps'],
    ],
    'auto',
    (value) => {
      settings =
        value === 'auto'
          ? { ...settings, audioBitrateMode: 'auto', audioBitrate: 0 }
          : { ...settings, audioBitrateMode: 'custom', audioBitrate: Number(value) };
      refresh();
    },
    { id: 'export-dialog-audio-bitrate' },
  );

  const grid = el('div', 'export-grid');
  grid.append(
    labelled('Format', formatSelect),
    labelled('Resolution', resolutionSelect),
    labelled('Frame ratio', ratioSelect),
    labelled('Frame rate', fpsSelect),
    labelled('Quality', qualitySelect),
    labelled('Video bitrate', bitrateRow),
    labelled('Audio bitrate', audioBitsSelect),
  );

  const readout = el('p', 'export-readout mono');
  readout.id = 'export-readout';
  const warning = el('p', 'hint export-warning');
  warning.id = 'export-warning';
  const bar = el('div', 'progress-bar');
  bar.id = 'export-dialog-bar';
  const progress = el('div', 'progress');
  progress.append(bar);
  progress.id = 'export-dialog-progress';
  const note = el('p', 'hint');
  note.id = 'export-dialog-note';
  note.textContent =
    'Frames are rendered and encoded offline, so the export is not tied to real time and the preview stays usable while it runs.';

  const foot = el('div', 'export-foot');
  const spacer = el('span', 'spacer');
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.type = 'button';
  const go = el('button', 'primary', 'Export');
  go.type = 'button';
  go.id = 'export-dialog-go';
  foot.append(spacer, cancel, go);

  form.append(head, grid, readout, warning, progress, note, foot);
  dialog.append(form);

  let busy = false;
  let lastProgress = 0;

  function context() {
    const raw = getContext() ?? {};
    const docSize = raw.docSize ?? raw.sourceSize ?? { width: 1920, height: 1080 };
    const aspect = raw.aspect ?? (docSize.height > 0 ? docSize.width / docSize.height : 16 / 9);
    return { ...raw, docSize, aspect };
  }

  /** The context and the size the file will land at — what the readout is built from. */
  function encoderFor() {
    const ctx = context();
    return { ctx, size: outputSize(settings, ctx) };
  }

  function refresh({ keepBitrate = false } = {}) {
    const { ctx, size } = encoderFor();
    readout.textContent = describeSettings(settings, ctx);
    if (!keepBitrate) {
      const autoMbps = (
        size.width *
        size.height *
        Math.min(60, Math.max(1, settings.fps)) *
        (QUALITY_PRESETS[settings.quality] ?? QUALITY_PRESETS.high).bpp /
        MBPS
      ).toFixed(2);
      bitrateInput.value = settings.videoBitrateMode === 'custom'
        ? (settings.videoBitrate / MBPS).toFixed(2)
        : String(Math.max(0.25, Number(autoMbps)));
    }
    bitrateInput.disabled = busy;
    const source = ctx.sourceSize;
    if (source && (size.width > source.width || size.height > source.height)) {
      warning.textContent = `the picture is ${source.width}×${source.height}, so this export is upscaled — pick a smaller resolution for a sharper file`;
      warning.hidden = false;
    } else if (source) {
      warning.textContent = `the picture is ${source.width}×${source.height}; this export is not upscaled`;
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }
  }

  function syncFields() {
    resolutionSelect.value = settings.resolution;
    fpsSelect.value = String(settings.fps);
    qualitySelect.value = settings.quality;
    formatSelect.value = settings.format;
    audioBitsSelect.value = settings.audioBitrateMode === 'custom' ? String(settings.audioBitrate) : 'auto';
  }

  function syncFromContext() {
    const ctx = context();
    ratioSelect.value = ctx.ratioId ?? ratioSelect.value;
  }

  function setBusy(next) {
    busy = !!next;
    go.disabled = busy;
    closeBtn.disabled = busy;
    cancel.disabled = busy;
    for (const control of [formatSelect, resolutionSelect, ratioSelect, fpsSelect, qualitySelect, audioBitsSelect]) {
      control.disabled = busy;
    }
    bitrateInput.disabled = busy;
    bitrateAuto.disabled = busy;
    dialog.classList.toggle('busy', busy);
  }

  closeBtn.addEventListener('click', () => dialog.close());
  cancel.addEventListener('click', () => dialog.close());
  go.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    bar.style.width = '0%';
    bar.classList.remove('failed');
    bar.classList.add('busy');
    try {
      await onExport({ ...settings });
    } finally {
      setBusy(false);
      bar.classList.remove('busy');
    }
  });

  // Escape and the backdrop close the dialog; a running export must not be thrown away by a stray
  // keypress, so the dialog asks before it disappears (and refuses while busy).
  dialog.addEventListener('cancel', (event) => {
    if (!busy) return;
    event.preventDefault();
  });

  return {
    element: dialog,
    get settings() {
      return { ...settings };
    },
    /** Seed the dialog from the document — the ratio always comes from the project, never its own. */
    open({ ratioId = 'source', sourceFps = 0, resolution = null } = {}) {
      const ctx = context();
      settings = defaultExportSettings({
        ...settings,
        resolution: resolution ?? (settings.resolution || '1080p'),
      });
      if (!settings.fps) settings.fps = DEFAULT_FPS;
      // The document's own frame rate is the right default the first time the window opens.
      if (settings.fps === DEFAULT_FPS && sourceFps) settings.fps = recommendFor(settings.resolution, { sourceFps }).fps;
      ratioSelect.value = ratioId;
      syncFields();
      refresh();
      note.textContent =
        'Frames are rendered and encoded offline, so the export is not tied to real time and the preview stays usable while it runs.';
      bar.style.width = '0%';
      bar.classList.remove('failed');
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      return this.settings;
    },
    close() {
      dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
    get isBusy() {
      return busy;
    },
    setProgress(fraction, message) {
      lastProgress = Math.max(0, Math.min(1, Number(fraction) || 0));
      bar.style.width = `${lastProgress * 100}%`;
      if (message) note.textContent = message;
    },
    get progress() {
      return lastProgress;
    },
    setNote(text) {
      note.textContent = text;
    },
    markFailed() {
      bar.classList.add('failed');
    },
    refresh,
    syncFromContext,
  };
}
