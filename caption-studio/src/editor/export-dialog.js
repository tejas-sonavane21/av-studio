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
  describeExportResult,
  describeSettings,
  outputSize,
  recommendFor,
} from '../io/export-settings.js';

/** The line the window shows before a job starts. Also what it falls back to between jobs. */
const IDLE_NOTE =
  'Frames are rendered and encoded offline, so the export is not tied to real time and the preview stays usable while it runs.';

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
 * @param {(settings:object) => Promise<{name:string, bytes:number, seconds?:number, frames?:number, audioNote?:string, audioSkipped?:string}>} options.onExport
 *   Resolves with the file that was written — that is what the window reports as finished. Resolving
 *   with nothing is treated as a failure, because the window must never claim a file it cannot name.
 * @param {(ratioId:string) => void} [options.onRatioChange]
 * @param {() => void} [options.onCancel]
 *   Called when the user asks a *running* export to stop (the button says "Stop export" while it runs).
 *   The caller owns the `AbortSignal`, so the window asks rather than reaching into the encoder itself.
 */
export function createExportDialog({ getContext, onExport, onRatioChange = null, onCancel = null } = {}) {
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
  progress.id = 'export-dialog-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.append(bar);
  // A track with no height is not a progress bar, and "muxing the file" is not a status. The bar says
  // how far along this is; the number beside it says the same thing in the one unit nobody has to
  // interpret, and stays readable even while the bar is too short to judge.
  const percent = el('span', 'export-percent mono', '0%');
  percent.id = 'export-dialog-percent';
  const progressRow = el('div', 'export-progress');
  progressRow.append(progress, percent);
  const note = el('p', 'hint export-note');
  note.id = 'export-dialog-note';
  note.textContent = IDLE_NOTE;

  const foot = el('div', 'export-foot');
  const spacer = el('span', 'spacer');
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.type = 'button';
  const go = el('button', 'primary', 'Export');
  go.type = 'button';
  go.id = 'export-dialog-go';
  foot.append(spacer, cancel, go);

  form.append(head, grid, readout, warning, progressRow, note, foot);
  dialog.append(form);

  let busy = false;
  let lastProgress = 0;
  let finished = false;
  // Whether this window is the one that asked for the current job to stop. A cancelled export and a
  // failed one both end in a rejection, and they must not read the same.
  let cancelRequested = false;

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
    // Cancel stays **live** while the job runs, because that is the one moment it is wanted. It used to
    // be disabled for the whole export — a button that looked like it should do something and could
    // not — which read exactly as "Cancel is broken".
    cancel.disabled = false;
    cancel.textContent = busy ? 'Stop export' : 'Cancel';
    for (const control of [formatSelect, resolutionSelect, ratioSelect, fpsSelect, qualitySelect, audioBitsSelect]) {
      control.disabled = busy;
    }
    bitrateInput.disabled = busy;
    bitrateAuto.disabled = busy;
    dialog.classList.toggle('busy', busy);
  }

  /**
   * The job is over and the file is on disk. Say so — this is the state the window never had.
   *
   * A finished export and a wedged one used to look identical, because the only thing that ever
   * changed was the last progress message. Now the bar completes, the number reads 100%, the note
   * names the file and its size, and the colour of all three says "done" without being read.
   */
  function finish(result) {
    const { headline, caveat } = describeExportResult(result);
    finished = true;
    lastProgress = 1;
    bar.style.width = '100%';
    bar.classList.remove('busy', 'failed');
    bar.classList.add('done');
    percent.textContent = '100%';
    percent.classList.add('done');
    progress.setAttribute('aria-valuenow', '100');
    note.textContent = caveat ? `${headline}\n${caveat}` : headline;
  }

  /**
   * Move the bar and the number. Also what clears a previous job's "done", so the window never shows a
   * green 100% over a run that has only just started.
   */
  function setProgress(fraction, message) {
    lastProgress = Math.max(0, Math.min(1, Number(fraction) || 0));
    const whole = Math.round(lastProgress * 100);
    bar.style.width = `${whole}%`;
    bar.classList.remove('done', 'failed', 'cancelled');
    percent.textContent = `${whole}%`;
    percent.classList.remove('done', 'failed', 'cancelled');
    progress.setAttribute('aria-valuenow', String(whole));
    finished = false;
    if (message) note.textContent = message;
  }

  /** The job did not produce a file. Say that too, rather than leaving the last progress message up. */
  function markFailed(reason = '') {
    finished = false;
    bar.classList.remove('busy', 'done', 'cancelled');
    bar.classList.add('failed');
    percent.textContent = 'failed';
    percent.classList.remove('done', 'cancelled');
    percent.classList.add('failed');
    note.textContent = reason
      ? `the export failed — ${reason}`
      : 'the export failed — the log has the reason';
  }

  /**
   * The user stopped it. Deliberately not shown as a failure — nothing went wrong, and saying "failed"
   * over an action somebody chose is how a cancel button teaches people not to trust it.
   */
  function markCancelled() {
    finished = false;
    bar.classList.remove('busy', 'done', 'failed');
    bar.classList.add('cancelled');
    percent.textContent = 'stopped';
    percent.classList.remove('done', 'failed');
    percent.classList.add('cancelled');
    note.textContent = 'the export was stopped — no file was written';
  }

  closeBtn.addEventListener('click', () => dialog.close());
  cancel.addEventListener('click', () => {
    // While a job runs the same button *stops* it. The signal travels down to the encoder, which checks
    // it between output frames and audio chunks and then tears down its encoder and its off-screen
    // decoder on the way out — so giving up on a long export costs nothing but the frames already done.
    if (busy) {
      cancelRequested = true;
      cancel.disabled = true;
      cancel.textContent = 'Stopping…';
      onCancel?.();
      return;
    }
    dialog.close();
  });
  go.addEventListener('click', async () => {
    if (busy) return;
    cancelRequested = false;
    setBusy(true);
    setProgress(0, 'preparing the encoder…');
    bar.classList.add('busy');
    try {
      const result = await onExport({ ...settings });
      // The caller names the file it wrote or it is not a success; a window that said "done" over an
      // empty result would be exactly the ambiguity this state exists to remove.
      if (result?.name) finish(result);
      else markFailed('nothing was written — the log has the reason');
    } catch (err) {
      if (cancelRequested || err?.name === 'AbortError') markCancelled();
      else markFailed(err?.message ?? String(err));
    } finally {
      cancelRequested = false;
      setBusy(false);
      bar.classList.remove('busy');
    }
  });

  // Escape and the backdrop must not *dismiss* a running export silently — but now that the job can be
  // stopped, that is what the key does instead of being inert: ask it to stop, and keep the window up
  // so the result is still on screen.
  dialog.addEventListener('cancel', (event) => {
    if (!busy) return;
    event.preventDefault();
    cancelRequested = true;
    cancel.disabled = true;
    cancel.textContent = 'Stopping…';
    onCancel?.();
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
      // A window that is opened again starts clean: the previous job's "done" is not this job's.
      note.textContent = IDLE_NOTE;
      setProgress(0, '');
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
    /** Has this window asked the current job to stop? Read by the caller's cancel path. */
    get cancelled() {
      return cancelRequested;
    },
    setProgress,
    get progress() {
      return lastProgress;
    },
    /** Has the last job in this window produced a file? The state the user asked to be able to see. */
    get finished() {
      return finished;
    },
    finish,
    markFailed,
    markCancelled,
    setNote(text) {
      note.textContent = text;
    },
    refresh,
    syncFromContext,
  };
}
