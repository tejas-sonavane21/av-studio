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
 * `selectedBlockId`. Content edits (`model/edit.js`) follow the same rule, including the ones that
 * change the shape of the document rather than its wording: splitting one caption into two is an
 * edit to where the line breaks are, and a line break is a block.
 *
 * Must be served over http://localhost (see README): ES modules and `captureStream` need an origin.
 */

import { createStore } from './store/store.js';
import { toHexColor } from './util/color.js';
import { parseSRT } from './io/srt.js';
import { parseVTT } from './io/vtt.js';
import { importJSON } from './io/project-file.js';
import {
  baseName,
  describeStudioAudit,
  fetchArtifact,
  health,
  listRuns,
  openRun,
  optionsFor,
  transcribeFile,
} from './io/audio-studio-client.js';
import { captionFiles, downloadBlob, downloadText, exportStem } from './io/download.js';
import { exportDocumentToVideo } from './io/webcodecs-export.js';
import { createPreviewSource } from './io/preview-source.js';
import {
  DEFAULT_PROXY_ID,
  PROXY_LADDER,
  autoProxyDecision,
  buildPreviewProxy,
  proxyPlan,
  proxySupported,
} from './io/preview-proxy.js';
import { defaultExportSettings, encoderSettings, outputSize } from './io/export-settings.js';
import { alignCaptions } from './align/aligner.js';
import { validateDocument } from './model/document.js';
import { createDefaultStyle } from './model/schema.js';
import { documentFromAlignment } from './model/pipeline.js';
import { createDemoDocument } from './model/demo.js';
import { joinBlockWithPrevious, setBlockText, setWordText, splitBlock, splitBlockAtTime } from './model/edit.js';
import { createPreview } from './editor/preview.js';
import { createCanvasOverlay } from './editor/canvas-overlay.js';
import { createMediaLibrary } from './editor/media-library.js';
import { createTimeline } from './editor/timeline.js';
import {
  MIN_CROP,
  addMediaClip,
  boxRect,
  centerClipBox,
  clipContentAspect,
  clipLength,
  clipPixelAspect,
  describeClip,
  duplicateClip,
  fitClipToFrame,
  flipMediaClip,
  layerPosition,
  mediaClips,
  moveMediaClip,
  planClip,
  normalizeCrop,
  removeMediaClip,
  reorderClip,
  resetClipCrop,
  resetMediaClip,
  rotateMediaClip,
  setClipBox,
  trimMediaClip,
  updateMediaClip,
} from './model/media.js';
import { boxWithAspect, describeTransform } from './render/media-placement.js';
import { createExportDialog } from './editor/export-dialog.js';
import {
  TIMELINE_TRACKS,
  cutAfter,
  cutBefore,
  droppedCaptionIds,
  ensureTimeline,
  fullRanges,
  removeAt,
  resetTrack,
  setTrackRanges,
  splitAt,
  timelineSummary,
  trackRanges,
  trimEdge,
} from './model/timeline.js';
import { fontFamilies, getFont } from './fonts/registry.js';
import {
  CANVAS_PRESETS,
  DISPLAY_MODES,
  canvasForPreset,
  presetIdFor,
  resolveAnchor,
  resolveStyle,
} from './model/schema.js';
import { REVEAL_MODES, EMPHASIS_SOURCES } from './render/time.js';
import { animationNames } from './render/animation.js';
import { PRESET_IDS, anchorFromPreset, clampAnchorToCanvas, describeAnchor, presetFor } from './render/placement.js';
import { allSwatches, getTemplate, templatesByOrigin } from './templates/index.js';
import {
  applyStyleToAll,
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
  shiftDocumentPlacements,
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
// The copy of the picture the preview may be playing, if one has been made. Revoked and replaced
// whenever a new one is built, and on unloading a picture.
let proxyUrl = null;
let proxyBuilding = false;
let proxyController = null;
// The picture the user has already sent back to the original *by hand*. The automatic copy must not
// build itself again the moment that picture comes back — and it does come back through
// `loadedmetadata`, because pointing the element at the original is a source change like any other.
// Null means no decision has been made about the picture that is loaded.
let proxyDeclined = null;
// Which rung of the size ladder the user has picked. The preview copy's resolution is theirs to
// choose — the right answer depends on the machine, not on the file — and it lives here rather than in
// the document because it says *how the preview is built*, not what the project contains.
let proxyPick = DEFAULT_PROXY_ID;
// The copy that was playing when the pick changed, so a rebuild can wait for the new one rather than
// leaving the preview on the original in the meantime.
let proxySwap = null;
// Which picture is on screen against which one the export encodes — the two are deliberately
// different once a preview copy exists. See `io/preview-source.js`.
const previewSource = createPreviewSource();
let preview = null;
let overlay = null;
let timeline = null;
let exportDialog = null;
// The only editing state this module owns: which block the inspector edits. Everything else about
// an edit lives in the document (overrides / placement) or in a registry.
let selectedBlockId = null;
let uiBusy = false;
// The "apply to all" drag's running anchor, keyed by which block is being dragged. Present only
// while a drag with the option on is in flight, so a committed drag cannot leak into the next one.
let dragAllState = null;
// Bumped by every template application, so an overlapping application cannot repaint last.
let templateRequest = 0;
// The inspector's "apply style edits to every caption" scope. A UI mode, like `dragAllState` — it
// lives here rather than in the document because it says *where an edit goes*, not what the document
// contains. Kept across a selection change so it behaves like the transport's "drag all captions".
let styleScopeAll = false;
// True once the frame ratio has been chosen explicitly, so a video that arrives afterwards cannot
// reset the frame back to its own shape. Cleared by "source" and whenever a new document is shown.
let aspectLocked = false;
// Which video/audio clip the timeline has selected — `{ track, id }`. The cut commands that act on
// "the selected clip" read this; ones that act on the whole programme ignore it.
let selectedClip = null;
// The overlay clip the strip has selected (`doc.media`), if any. Kept apart from `selectedClip` because
// the two are not interchangeable: a cut clip is part of the one source file (so `Delete` removes a
// range of it), while an overlay clip is a whole object in the document (so `Delete` removes it).
let selectedMediaClipId = null;
// The files behind the overlay clips, keyed by clip id. The document stores timing and placement; this
// holds the bytes, for this session only.
const mediaLibrary = createMediaLibrary();

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
  const badge = $('#status-badge');
  badge.textContent = text;
  badge.classList.toggle('busy', /ing\b|\u2026/.test(text));
}

// ---------------------------------------------------------------------------
// saying how a thing went
// ---------------------------------------------------------------------------

/**
 * One vocabulary for "busy / done / failed", shared by all three workflow panels.
 *
 * A single call fills the three places a person looks: the badge beside the panel's title, which
 * carries the state in colour *and* in words; the panel's own state line, which carries the detail;
 * and — through `log()` at the call site — the history. The panels each spelled this out for
 * themselves before, and the predictable result was that the panel somebody was staring at was the
 * one least likely to say whether its own work had finished.
 *
 * `failed` and `warn` are deliberately different. A failure needs doing something about; a warning is
 * a compromised but finished result, and colouring the two the same is how a warning gets ignored
 * until it becomes a failure.
 */
const NOTICES = {
  sources: { badge: '#sources-status', line: '#sources-message' },
  transcribe: { badge: '#transcribe-status', line: '#transcribe-message' },
  export: { badge: '#export-status', line: '#export-message' },
};

const NOTICE_MARK = { busy: '\u2026', ok: '\u2713', failed: '\u2715', warn: '\u26a0', idle: '' };

function stateOf(panel, state, badgeText, message = '') {
  const target = NOTICES[panel];
  const badge = target?.badge ? $(target.badge) : null;
  if (badge) {
    const mark = NOTICE_MARK[state] ?? '';
    badge.textContent = [mark, badgeText].filter(Boolean).join(' ') || '\u2014';
    badge.classList.remove('busy', 'ok', 'failed', 'warn');
    if (state !== 'idle') badge.classList.add(state);
  }
  const line = target?.line ? $(target.line) : null;
  if (line && message) {
    line.textContent = message;
    line.classList.remove('busy', 'ok', 'failed', 'warn');
    if (state !== 'idle') line.classList.add(state);
  }
  return message;
}

/** A media element's own length, or 0 when it has none yet. */
function mediaSeconds(media) {
  const value = Number(media?.duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A `MediaError` code, as something a person can act on. */
function describeMediaError(error) {
  const reasons = {
    1: 'the load was stopped before it finished',
    2: 'the file could not be read',
    3: 'the file could not be decoded — the browser has no decoder for this codec',
    4: 'this file or container is not supported by the browser',
  };
  return `${reasons[error?.code] ?? 'the browser refused it'}${error?.message ? ` (${error.message})` : ''}`;
}

/**
 * Name the one thing that actually limits a preview, when it applies: a picture far larger than the
 * frame it is being shown in.
 *
 * This is measured rather than guessed. `tools/preview-perf.mjs` plays a real 3840x2160 AV1 capture in
 * a bare `<video>` and in the editor, and reports both: the editor's own render loop holds a full
 * 59.8 fps against the bare element's 59.7, while the *decoder* presents 16.3 of the 30 frames a second
 * the file contains, against 19.3 for the element on a page with nothing else on it. The captions, the
 * timeline and the transport cost nothing measurable — the decode is the rest, and a picture resampled
 * down to a 900 px stage has no decoder to spare on a machine without AV1 in hardware. So the useful
 * thing an editor can do here is say so, and say what helps: a copy for the preview, the original for
 * the export.
 */
function reportPictureCost() {
  const video = $('#preview-video');
  const width = Number(video?.videoWidth) || 0;
  const stage = $('#stage');
  const shown = Number(stage?.clientWidth) || 0;
  if (!width || !shown || width < shown * 2) return '';
  return (
    `\nNote: the picture is ${width}\u00d7${video.videoHeight} and the preview shows it about ` +
    `${Math.round(shown)}px wide, so it is being decoded at roughly ` +
    `${(width / shown).toFixed(1)}\u00d7 the size it is displayed at. That decode — not the captions — ` +
    `is what can make a preview stutter; the 720p copy the preview builds for itself is smoother to ` +
    `edit against, and the export still uses the file you choose here.`
  );
}

/**
 * Say how the two recordings compare, because the answer changes what the programme *is*.
 *
 * A picture shorter than the track is the normal case here (a cut-down music video against the
 * full-length master), and it is the case that used to look like a bug: the transport stopped, or
 * the track stuttered back to the picture's end. It is not a bug — it is a blank frame with the track
 * still playing — but nothing said so, so it is said here, once, at the moment both are known.
 */
function reportMediaLengths() {
  const picture = mediaSeconds($('#preview-video'));
  const track = mediaSeconds($('#preview-audio'));
  if (!picture && !track) return;
  if (!picture || !track) {
    stateOf(
      'sources',
      'ok',
      picture ? `picture ${picture.toFixed(2)}s` : `track ${track.toFixed(2)}s`,
      (picture
        ? `Picture loaded: ${picture.toFixed(2)}s. No track, so the picture's own sound is what you hear.`
        : `Track loaded: ${track.toFixed(2)}s. It carries the clock and the programme's length.`) +
        (picture ? reportPictureCost() : ''),
    );
    return;
  }
  const diff = track - picture;
  if (Math.abs(diff) < 0.5) {
    stateOf(
      'sources',
      'ok',
      `${picture.toFixed(2)}s`,
      `Picture and track are both ${picture.toFixed(2)}s — the programme is exactly the recording, with no blank stretch.` +
        reportPictureCost(),
    );
    return;
  }
  const programme = Math.max(picture, track);
  const tail =
    diff > 0
      ? `Past ${picture.toFixed(2)}s the picture has run out: the preview keeps playing and drawing captions over a blank frame.`
      : `Past ${track.toFixed(2)}s the track has run out: the programme carries on silent.`;
  stateOf(
    'sources',
    'warn',
    `${programme.toFixed(2)}s programme`,
    `The picture is ${picture.toFixed(2)}s and the track is ${track.toFixed(2)}s, so the programme is ` +
      `${programme.toFixed(2)}s long.\n${tail}` +
      reportPictureCost(),
  );
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
// a finished run, reflected back into Sources
// ---------------------------------------------------------------------------

/**
 * Put a file into a `<input type="file">`, exactly as the user's own picker would.
 *
 * A page cannot set `input.files` directly; a `DataTransfer` can, and it is the documented way — so
 * the input is left holding a real `File`, which is what every handler downstream already expects.
 * Dispatching `change` afterwards is not decoration: it is what makes the panel behave identically
 * whether the file came from the run or from a folder, which is the whole point of filling it in.
 *
 * @returns {boolean} whether the file is now in the input
 */
function fillSourceInput(selector, file) {
  const input = $(selector);
  if (!input || !file) {
    log(`  ⚠ could not fill ${selector}: ${input ? 'no file was fetched' : 'that field is not on the page'}`);
    return false;
  }
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  } catch (err) {
    log(`  ⚠ could not put ${file.name} into ${selector}: ${err.message}`);
    return false;
  }
  input.dispatchEvent(new Event('change'));
  return true;
}

/** A string as a `File`, so an artifact fetched over HTTP can go where a chosen file goes. */
function textAsFile(name, text, type = 'text/plain') {
  return new File([text], name, { type });
}

/** The stem a run's own files are named after, taken from the artifact it actually wrote. */
function runStem(job, fallback = 'captions') {
  const name = baseName(job?.files?.veed ?? '');
  return name ? name.replace(/\.veed\.json$/i, '') : fallback;
}

/**
 * Fill the Sources panel from a run that finished.
 *
 * Transcription is the one step that already produced files, and until now the panel that *consumes*
 * them was left empty: the recording was loaded automatically and the two files the run wrote were
 * not, so "load the AI source" meant remembering which job folder held them. The panel is the place a
 * person goes next, so the run's own artifacts land in it:
 *
 * * **AI source** — the run's Veed master JSON: the timing the whole editor is built around;
 * * **TRUTH source** — the run's own SRT.
 *
 * The TRUTH file is the studio's own SRT **on purpose**, and not the lyric sheet the run was given.
 * The two are not the same document even when they read the same: the lyrics are the words that were
 * *asked for*, while the SRT is what the studio actually produced from the recording — transcribed
 * against the audio, aligned word by word, validated, and reconciled with those lyrics. Measured on
 * this project's own material, the studio's file is the better spelling authority of the two, and it
 * is the one that carries the words the captions actually had. The supplied lyrics are not thrown
 * away: they went to the run as its reference, which is what makes the SRT good in the first place.
 *
 * A person can still point TRUTH at any file by hand — that is what the field is for — and this only
 * decides what is filled in for them.
 *
 * Nothing here is guessed at: each artifact is fetched from the job that just finished, and a file that
 * cannot be fetched says so instead of leaving a field that looks loaded.
 *
 * @returns {Promise<string[]>} what was filled in, for a log line and the panel's own message
 */
async function reflectRunInSources({ base, jobId, job, stem }) {
  const filled = [];
  const name = runStem(job, stem);
  try {
    const veed = await fetchArtifact(base, jobId, 'veed');
    if (fillSourceInput('#ai-in', textAsFile(`${name}.veed.json`, veed, 'application/json'))) {
      filled.push('AI source');
    }
  } catch (err) {
    log(`  ⚠ the run's Veed JSON could not be fetched: ${err.message}`);
  }

  try {
    const srt = await fetchArtifact(base, jobId, 'srt');
    if (fillSourceInput('#truth-in', textAsFile(`${name}.srt`, srt, 'application/x-subrip'))) {
      filled.push(`TRUTH source (${name}.srt from the run)`);
    }
  } catch (err) {
    log(`  ⚠ the run's SRT could not be fetched: ${err.message}`);
  }
  return filled;
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

async function onVideo(file) {
  if (!file) return;
  store.setState({ video: file });
  log(`video loaded: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);
  stateOf('sources', 'busy', `reading ${file.name}\u2026`);
  $('#video-note').textContent = `${file.name} — reading\u2026`;

  const video = $('#preview-video');
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  // A new picture starts un-copied: the old copy is a copy of *another* file, and the export must be
  // reading this one. Its size and length are filled in when the element has read its metadata.
  previewSource.setOriginal({ name: file.name, url: videoUrl });
  // A decision about a picture outlives that picture being picked again, and does not outlive a
  // *different* one: sending a 4K file back to the original is a statement about that file.
  if (proxyDeclined && proxyDeclined !== file.name) proxyDeclined = null;
  refreshProxyControls();
  preview?.setVideo(video);
  video.src = videoUrl;
  video.load();
  // The stale copy's URL is revoked only once the element has been moved off it.
  dropProxy();
  $('#play-btn').disabled = false;
  $('#video-toggle').checked = true;
  preview?.setVideoVisible(true);
  // A picture is exactly what the burn-in export needs, so the export buttons have to be re-read the
  // moment one arrives — the document may already be loaded and waiting for it.
  refreshExportButtons();

  // adopt the video's native size for the document, unless a document already set one
  video.addEventListener(
    'loadedmetadata',
    () => {
      log(`video: ${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(2)}s`);
      $('#video-note').textContent =
        `${file.name} — ${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(2)}s, ` +
        `${(file.size / 1e6).toFixed(1)} MB`;
      // The export's own numbers. Read from the file, never from whatever the preview element is
      // playing: once a copy exists the element is smaller than the master.
      previewSource.setOriginalSize({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
      refreshProxyControls();
      reportMediaLengths();
      const doc = preview?.document;
      if (doc) {
        // A picture normally sets the frame, but not over a ratio somebody has already chosen: the
        // whole point of picking 9:16 is that the clip that arrives later does not undo it.
        if (!aspectLocked) doc.canvas = { ...doc.canvas, width: video.videoWidth, height: video.videoHeight };
        applyStageAspect();
        preview.resize();
        syncAspectSelect();
        refreshSeekRange();
        // A new picture means the old cut pointed into a file that is no longer loaded, so the video
        // track starts again from the whole of this one.
        resetTrack(doc, 'video', video.duration);
        selectedClip = null;
        timeline?.setSelectedClip(null);
        refreshTimelineRanges();
        updateTimelineStatus();
      }
      // Last, so the copy is decided on a picture the rest of the app has finished adopting: its
      // size, its length and the document's aspect are all settled by the time this runs.
      maybeAutoProxy();
    },
    { once: true },
  );
}

// ---------------------------------------------------------------------------
// the picture's own cost — a smaller copy, for the preview only
// ---------------------------------------------------------------------------

/**
 * The size picker, built from the ladder so the option a person sees and the edge the converter is
 * given cannot drift apart.
 *
 * Created once; the options carry the rung's own long edge in their title, so the size a rung means for
 * *this* picture is visible before anything is built rather than after.
 */
function buildProxySizeSelect() {
  const select = $('#proxy-size');
  if (!select) return;
  select.replaceChildren(
    ...PROXY_LADDER.map((rung) => {
      const option = el('option', null, `${rung.label} (${rung.longEdge} on the long edge)`);
      option.value = rung.id;
      return option;
    }),
  );
  select.value = proxyPick;
  select.addEventListener('change', onProxyPickChange);
}

/**
 * What the picked rung means for the picture on screen, right now.
 *
 * One call, one answer, shared by everything in the panel — the button's label, whether it is enabled,
 * the note under it and the copy itself — so there is no way for the panel to describe one size while
 * the converter builds another.
 */
function currentProxyPlan() {
  return proxyPlan(previewSource.original, { id: proxyPick });
}

/**
 * The four things that decide whether a copy is worth offering: is there a picture, is it bigger than
 * the rung that is picked, will the browser let one be made, and is there one already.
 */
function refreshProxyControls() {
  const build = $('#proxy-build');
  const clear = $('#proxy-clear');
  const select = $('#proxy-size');
  if (!build || !clear) return;
  if (select) select.value = proxyPick;
  const picture = previewSource.original;
  const plan = currentProxyPlan();
  const worthwhile = Boolean(picture) && plan.worth && proxySupported();
  build.disabled = proxyBuilding || !worthwhile || previewSource.proxied;
  // The second button is the stop button while a copy is being built. A copy costs a minute of the
  // user's machine and this one starts by itself, so it has to be stoppable by hand.
  clear.disabled = !proxyBuilding && !previewSource.proxied;
  clear.textContent = proxyBuilding ? 'Stop copying' : 'Preview the original';
  if (proxyBuilding) {
    build.textContent = 'Copying…';
    return;
  }
  build.textContent = 'Build smooth preview copy';
  if (picture && !previewSource.proxied && worthwhile && plan.size) {
    build.textContent = `Build smooth preview copy (${plan.size.width}×${plan.size.height})`;
  }
  // What the pick means here, said where the pick is: either the size this picture would be copied to
  // and what that costs a second, or why there is nothing to copy. Never both, and never a size for a
  // build that is not offered.
  if (picture && plan.size && plan.worth && !previewSource.proxied) {
    setProxyNote(
      `${picture.width}×${picture.height} → ${plan.size.width}×${plan.size.height} ` +
        `(${plan.rung.label}, about ${(plan.bitsPerSecond / 1e6).toFixed(2)} Mbps). ` +
        'The copy is used only in the preview. Export always encodes the original file.',
    );
  } else if (picture && previewSource.proxied) {
    // A copy is playing: say what it is and where the picker is, rather than leaving the last build's
    // sentence under a picker that no longer describes it.
    setProxyNote(previewSource.describe());
  } else if (picture && !plan.worth && !previewSource.proxied) {
    setProxyNote(
      `${picture.width}×${picture.height} — ${plan.reason}. Pick a smaller size to copy it down, ` +
        'or leave it as it is: the preview plays the original file. Export always encodes the original file.',
    );
  }
}

/**
 * A different rung: rebuild the copy at it.
 *
 * Changing the size is a decision about the *preview*, so it takes effect on the preview: a copy that
 * is playing is rebuilt at the new size (the old one keeps playing until the new one is ready, so the
 * transport is never left on the heavier original), and a picture with no copy yet just updates what
 * the button would build. Stopping to ask first would be worse than either — the pick is made by
 * somebody who already knows what they want.
 */
function onProxyPickChange() {
  const select = $('#proxy-size');
  if (!select) return;
  const before = proxyPick;
  proxyPick = select.value;
  if (before === proxyPick) return;
  const plan = currentProxyPlan();
  log(
    `preview copy: size now ${plan.rung.label}${plan.size ? ` (${plan.size.width}×${plan.size.height})` : ''}` +
      `${plan.worth ? '' : ` — ${plan.reason}`}`,
  );
  refreshProxyControls();
  if (proxyBuilding) {
    // A build in flight is at the *old* rung, so it is stopped rather than left to deliver a copy
    // nobody asked for; the new one starts as soon as the stop has been taken.
    proxySwap = 'restart';
    proxyController?.abort();
    return;
  }
  if (previewSource.proxied) {
    if (!previewSource.original || !proxySupported() || !plan.worth) {
      // Nothing to rebuild at — back to the original, with the reason said out loud.
      onClearProxy();
      return;
    }
    // A rebuild, not a teardown: the copy that is playing stays on screen until the new one is ready,
    // because the original is the heavier picture and the user is mid-edit.
    void onBuildProxy();
    return;
  }
  if (plan.worth && proxySupported() && previewSource.original) void onBuildProxy();
}

function setProxyNote(text) {
  const note = $('#proxy-note');
  if (note) note.textContent = text;
}

/** Forget the copy: revoke its URL and point the preview back at the file the user loaded. */
function dropProxy() {
  if (proxyUrl) URL.revokeObjectURL(proxyUrl);
  proxyUrl = null;
  previewSource.clearProxy();
}

/**
 * Play the element from `url`, keeping the playhead where it was.
 *
 * Swapping a `<video>`'s source resets it to zero, and a preview that jumps back to the first caption
 * every time its picture is swapped is a preview nobody can check a cut against — so the time the user
 * was parked on is restored as soon as the new source can be seeked.
 */
function usePictureUrl(url, { restore = null, resume = false, label = '' } = {}) {
  const video = $('#preview-video');
  if (!video || !url) return;
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (restore != null) preview?.seek(restore);
      if (label) log(label);
    },
    { once: true },
  );
  // Resuming waits for `loadeddata` rather than riding on the metadata event: `play()` on an element
  // that has nothing decoded yet is refused, and a swap that quietly left the transport parked would
  // be a worse interruption than the stutter it was there to fix.
  if (resume) video.addEventListener('loadeddata', () => preview?.start(), { once: true });
  video.src = url;
  video.load();
  preview?.setVideo(video);
}

/**
 * Make a smaller copy of the picture, in the browser, for the preview to play.
 *
 * Called **by itself** when a picture bigger than the picked rung is loaded (see `maybeAutoProxy`), by
 * the button when the user wants one back after sending a picture to the original, and by the size
 * picker when the rung changes. The size and the bitrate are the current plan's, so a rebuild at a new
 * rung is the same call with different numbers in it.
 *
 * Even off the clock a long 4K file takes a while to decode, and the wait is the *master's* decode rather
 * than the copy's settings: measured on this project's 2160p fixture, the copy's own size moves the pass
 * by about one per cent (10.7 s at the 720p rung against 10.8 s at 480p for a 4 s window) while a
 * decode-and-scale arm with no encoder at all accounts for between four fifths and nine tenths of it
 * (`tools/proxy-speed.mjs`, where the floor prints its own share of the arm: 80-89% over four runs)
 * — so the cost is not hidden, it is *stated*: the panel counts it out, the log carries the size and the
 * rate, and the stop button cancels it. What the copy fixes is measured too — the copy's frame rate
 * against the source's, in `tools/ui-smoke.mjs` and `tools/preview-perf.mjs`.
 */
async function onBuildProxy() {
  const picture = previewSource.original;
  if (!picture || proxyBuilding) return;
  const plan = currentProxyPlan();
  const size = plan.size;
  if (!size || !plan.worth) return;

  // The transport is parked for the pass, because this is a heavy job next to the decoder that is
  // already playing the picture. On the automatic path nothing is playing yet, so it is a no-op.
  preview?.pause();

  proxyBuilding = true;
  const controller = new AbortController();
  proxyController = controller;
  refreshProxyControls();
  const megs = (plan.bitsPerSecond / 1e6).toFixed(2);
  setProxyNote('copying — decoding the picture off the clock');
  log(
    `preview copy: converting ${picture.width}×${picture.height} → ${size.width}×${size.height} ` +
      `(${plan.rung.label}, about ${megs} Mbps) in this browser ` +
      `(${(picture.duration || 0).toFixed(1)}s of picture — decoded off the clock, so the pass takes what the ` +
      'decoding takes rather than what the clip runs, and no frames are dropped to keep up). ' +
      'The export is untouched.',
  );
  stateOf('sources', 'busy', 'copying…', `Making a ${size.width}×${size.height} copy of the picture for the preview.`);

  try {
    const result = await buildPreviewProxy({
      url: previewSource.exportUrl,
      size,
      bitsPerSecond: plan.bitsPerSecond,
      signal: controller.signal,
      onProgress: (fraction, message) => setProxyNote(`${message} (${Math.round(fraction * 100)}%)`),
    });
    if (proxyUrl) URL.revokeObjectURL(proxyUrl);
    proxyUrl = URL.createObjectURL(result.blob);
    previewSource.setProxy({
      url: proxyUrl,
      width: result.width,
      height: result.height,
      seconds: result.seconds,
      bytes: result.blob.size,
      mimeType: result.mimeType,
      audio: result.audio,
      frames: result.frames,
      averageFps: result.averageFps,
    });
    usePictureUrl(proxyUrl, {
      // Where the transport is *now*, not where it was when the copy started: a build that took a
      // minute has had a minute of the user's editing in it, and a copy that arrived by itself and
      // threw the playhead back to the second it began at would be worse than the stutter it removes.
      restore: preview?.currentTime() ?? 0,
      resume: Boolean(preview?.playing),
      label: `preview copy: playing the ${result.width}×${result.height} copy (${(result.blob.size / 1e6).toFixed(1)} MB)`,
    });
    log(
      `preview copy: ready — ${result.width}×${result.height}, ${(result.blob.size / 1e6).toFixed(1)} MB, ` +
        `${result.codec}${result.audio ? ` + ${result.audioCodec || 'audio'}` : ' (no sound in the copy)'}, ` +
        `${result.encodeSeconds}s to convert`,
    );
    // The frames the copy holds, measured off the copy itself. It is the number that separates a copy
    // that carries the file's motion from one that quietly threw half of it away - which is what the
    // wall-clock version of this did, and what made a "smoother" copy look choppier than the original.
    if (result.summary) log(`  ${result.summary}`);
    if (!result.audio && result.audioError) log(`  ⚠ the copy has no sound: ${result.audioError}`);
    if (result.drift) log(`  ⚠ ${result.drift}`);
    setProxyNote(previewSource.describe());
    stateOf(
      'sources',
      'ok',
      'copy ready',
      `The preview is playing a ${result.width}×${result.height} copy, so the transport has less to decode.\n` +
        `The export still encodes the original ${picture.width}×${picture.height} file, with every cut applied.` +
        (result.drift ? `\n⚠ ${result.drift}` : ''),
    );
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (proxySwap) {
        log(`preview copy: stopped the pass at the old size — starting again at ${proxyPick}`);
        setProxyNote(`switching the copy to ${proxyPick}…`);
        stateOf('sources', 'busy', 'copying…', `Rebuilding the preview copy at ${proxyPick}.`);
      } else {
        log('preview copy: stopped — the preview is still on the original');
        setProxyNote('the copy was stopped. The preview is still on the original file.');
        stateOf('sources', 'warn', 'copy stopped', 'The preview copy was stopped, so the preview is still playing the original.');
      }
    } else {
      log(`ERROR preview copy: ${err.message}`);
      setProxyNote(`the copy could not be made: ${err.message}`);
      stateOf('sources', 'failed', 'copy failed', `The preview copy could not be made.\n${err.message}`);
    }
  } finally {
    proxyBuilding = false;
    if (proxyController === controller) proxyController = null;
    refreshProxyControls();
    setStatus('idle');
    // The picker changed the rung *while* this was building: the copy that just arrived is at the old
    // one, so it is replaced. Nothing is asked of the user — they already said which size they want.
    if (proxySwap) {
      const wanted = proxySwap;
      proxySwap = null;
      if (wanted === 'restart') {
        const next = currentProxyPlan();
        if (next.worth && proxySupported() && previewSource.original) void onBuildProxy();
        else if (previewSource.proxied) onClearProxy();
      }
    }
  }
}

/**
 * Build the copy without being asked — the whole reason `autoProxyDecision` exists.
 *
 * Called from the picture's own `loadedmetadata`, so the numbers the decision is made on are the
 * file's real width and height rather than a guess, and so the preview is smooth from the *first*
 * play rather than from whenever somebody notices a button. The cost is stated where it is paid, and
 * the stop button is what keeps an automatic pass from being a surprise.
 */
function maybeAutoProxy() {
  const picture = previewSource.original;
  const decision = autoProxyDecision(picture, {
    supported: proxySupported(),
    building: proxyBuilding,
    proxied: previewSource.proxied,
    declined: Boolean(picture) && proxyDeclined === picture.name,
    id: proxyPick,
  });
  if (!decision.build) {
    log(`preview copy: not building one automatically — ${decision.reason}`);
    return;
  }
  const plan = currentProxyPlan();
  log(
    `preview copy: building a copy automatically at ${plan.rung.label}, so the preview is not ` +
      'decoding the master; the export is untouched and Stop copying cancels it',
  );
  setProxyNote('copying the picture for the preview — this happens by itself; Stop copying cancels it');
  void onBuildProxy();
}

/**
 * Go back to the original file on the preview — or stop the copy that is being built right now.
 *
 * The element is pointed at the original *first* and the copy's URL revoked after, so the browser is
 * never asked to keep playing a blob that has just been released.
 */
function onClearProxy() {
  // A build in flight is the first thing this button stops: `AbortSignal` is what the conversion was
  // written against, and a minute-long automatic pass with no way out is not a feature.
  if (proxyBuilding) {
    proxyDeclined = previewSource.original?.name || '';
    log('preview copy: stopping the copy that is being built — the preview stays on the original');
    proxyController?.abort();
    return;
  }
  if (!previewSource.proxied) return;
  const at = preview?.currentTime() ?? 0;
  const original = previewSource.original;
  // Told, not guessed: having chosen the original, the user is not asked again the next time this
  // picture's metadata arrives. Loading a different picture clears it.
  proxyDeclined = original?.name || '';
  preview?.pause();
  usePictureUrl(original?.url, { restore: at, label: 'preview copy: back on the original picture' });
  dropProxy();
  refreshProxyControls();
  setProxyNote(
    `${original?.name || 'the picture'} — previewing the original, ${original?.width}×${original?.height}. ` +
      'A copy can be built again at any time.',
  );
  stateOf('sources', 'ok', 'original', 'The preview is back on the original picture.');
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
  stateOf('sources', 'busy', `reading ${file.name}\u2026`);
  $('#audio-note').textContent = `${file.name} — reading\u2026`;

  const audio = $('#preview-audio');
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file);
  preview?.setAudio(audio);
  // A master track takes the sound over: the picture's own audio is switched off so the two cannot
  // play over each other, and the transport switches are moved to match. Both are one click away
  // from being changed back.
  preview?.setPlaybackAudioEnabled(true);
  preview?.setVideoAudioEnabled(false);
  $('#audio-audio-toggle').checked = true;
  $('#video-audio-toggle').checked = false;
  audio.src = audioUrl;
  audio.load();
  // an audio-only session is still a session: the transport has to work with no picture at all
  $('#play-btn').disabled = false;
  $('#audio-tag').textContent = file.name;

  audio.addEventListener(
    'loadedmetadata',
    () => {
      if (Number.isFinite(audio.duration)) log(`audio: ${audio.duration.toFixed(2)}s`);
      if (Number.isFinite(audio.duration)) {
        $('#audio-note').textContent =
          `${file.name} — ${audio.duration.toFixed(2)}s, ${(file.size / 1e6).toFixed(2)} MB`;
      }
      reportMediaLengths();
      refreshSeekRange();
      // Same rule as the picture: a new track starts uncut. The video track is left alone — the two
      // are cut independently, which is the whole point of having two lanes.
      const doc = preview?.document;
      if (doc && Number.isFinite(audio.duration)) {
        resetTrack(doc, 'audio', audio.duration);
        refreshTimelineRanges();
        updateTimelineStatus();
      }
    },
    { once: true },
  );
}

// ---------------------------------------------------------------------------
// overlay clips — pictures and videos laid over the programme
// ---------------------------------------------------------------------------

/**
 * Republish the overlay clips, in one place.
 *
 * Three views of the same list — the preview's clip layer, the strip's lane, and the panel's rows — and
 * they drift the moment one of them is updated without the others. Same rule as `syncTimeline()`: one
 * function, called after any edit, from `doc.media` alone.
 */
function syncMedia() {
  const doc = preview?.document;
  const clips = doc ? mediaClips(doc) : [];
  preview?.setMedia(clips, (id) => mediaLibrary.element(id));
  timeline?.setMediaClips(clips);
  timeline?.setMediaOffline(mediaLibrary.missing(clips.map((clip) => clip.id)));
  timeline?.setSelectedMediaClip(selectedMediaClipId);
  renderMediaList();
  renderClipInspector();
  return clips;
}

/**
 * Point the clip layer at a document that has just been shown.
 *
 * The files stay loaded only if the new document still refers to them: a `.caproj` opened over another
 * one carries its own clip ids, and leaving the previous project's bytes in the registry would let a
 * clip draw from a file nobody chose. Everything else is released, and the clips that have no file come
 * back as "offline" — a real state the panel can state (see `Relink`).
 */
function adoptMedia(doc) {
  const wanted = new Set(mediaClips(doc).map((clip) => clip.id));
  for (const id of mediaLibrary.ids()) if (!wanted.has(id)) mediaLibrary.remove(id);
  if (selectedMediaClipId && !wanted.has(selectedMediaClipId)) selectedMediaClipId = null;
  return syncMedia();
}

/**
 * Load files as overlay clips, each placed at the playhead.
 *
 * One loop over what was selected, and one failure never stops the rest — the same shape as every other
 * multi-file path here. A file that is not an image or a video is refused with a sentence naming it
 * rather than being added as a clip that can never draw.
 */
async function onMediaFiles(files) {
  const list = [...(files ?? [])];
  if (!list.length) return;
  // The input is cleared as soon as its files have been copied out, so choosing the same file twice in
  // a row adds it twice: a file input whose value has not changed fires no event at all.
  $('#media-in').value = '';
  const doc = preview?.document;
  if (!doc) {
    log('ERROR clip: there is no programme to place a clip on — load a source, or open the demo');
    stateOf(
      'sources',
      'warn',
      'no programme',
      'An overlay clip is placed on a programme. Load an AI source and run the correction, open a ' +
        'project, or open the demo first.',
    );
    return;
  }

  setStatus('reading clips…');
  const at = Math.max(0, preview?.currentTime() ?? 0);
  let added = 0;
  for (const file of list) {
    const result = await mediaLibrary.add(file);
    if (!result.ok) {
      log(`ERROR clip: ${result.error}`);
      continue;
    }
    const entry = result.entry;
    const clip = planClip({ entry, at, canvas: doc.canvas, limit: preview?.duration() ?? 0, id: entry.id });
    if (!clip) {
      // Nothing usable came back, so the file is released again rather than left loaded for a clip
      // that does not exist.
      mediaLibrary.remove(entry.id);
      log(`ERROR clip: "${entry.name}" has no usable time window`);
      continue;
    }
    addMediaClip(doc, clip);
    added += 1;
    log(`clip added: ${describeClip(clip)}${clip.kind === 'video' ? ' (silent)' : ''}`);
  }
  setStatus('idle');
  syncMedia();
  if (added) {
    stateOf(
      'sources',
      'ok',
      `${added} clip${added === 1 ? '' : 's'}`,
      `${added} overlay clip${added === 1 ? '' : 's'} added at ${at.toFixed(2)}s. Drag a clip along the ` +
        'Clips lane in the timeline to move it, or drag its edges to trim it. Clips are silent.',
    );
    // Showing the clip is the point of adding it, so the playhead goes to where it now is.
    preview?.seek(at + 0.01);
  }
}

/** Take a clip off the programme, and release its file with it. */
function removeClip(id) {
  const doc = preview?.document;
  const clip = mediaClips(doc).find((c) => c.id === id);
  if (!doc || !clip || !removeMediaClip(doc, id)) return false;
  mediaLibrary.remove(id);
  if (selectedMediaClipId === id) selectedMediaClipId = null;
  log(`clip removed: "${clip.name}" (${(clip.end - clip.start).toFixed(2)}s at ${clip.start.toFixed(2)}s)`);
  syncMedia();
  return true;
}

/**
 * Give a clip back its file, in place.
 *
 * The project stores the clip — its window, its box, its id — and not the bytes, so this is how a
 * project saved yesterday is made whole today. The clip is rebuilt rather than patched, because the new
 * file may be a different *kind* (an image standing in for a video), and `updateMediaClip` deliberately
 * keeps the original kind: an edit must not turn a clip into another sort of thing by accident.
 */
async function relinkClip(id, file) {
  if (!file) return;
  const doc = preview?.document;
  const before = mediaClips(doc).find((clip) => clip.id === id);
  if (!doc || !before) return;
  const result = await mediaLibrary.add(file, { id });
  if (!result.ok) {
    log(`ERROR clip: ${result.error}`);
    renderMediaList();
    return;
  }
  const entry = result.entry;
  removeMediaClip(doc, id);
  addMediaClip(doc, { ...before, kind: entry.kind, name: entry.name });
  log(`clip relinked: "${before.name}" ← "${entry.name}" (${entry.width}×${entry.height})`);
  selectMediaClip(id);
}

/** Select an overlay clip, everywhere it is shown. */
function selectMediaClip(id) {
  selectedMediaClipId = id ?? null;
  timeline?.setSelectedMediaClip(selectedMediaClipId);
  // The overlay draws the handles for whatever is selected, so selecting here is what puts them on
  // screen — and selecting from the panel or the lane is the same act as clicking the clip.
  overlay?.selectClip(selectedMediaClipId);
  renderMediaList();
  renderClipInspector();
  const clip = mediaClips(preview?.document).find((c) => c.id === id);
  if (clip) {
    log(`clip: selected "${clip.name}" ${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s`);
    // A clip is only visible while the playhead is inside it, so selecting one parks the playhead just
    // inside its window. Selecting something you cannot see is a click that appears to do nothing.
    preview?.seek(clip.start + 0.01);
  }
  return clip;
}

/** A drag on an overlay clip's edge. Applied live, so the strip and the list follow the pointer. */
function onMediaClipTrim(id, edge, seconds) {
  const doc = preview?.document;
  if (!doc) return;
  trimMediaClip(doc, id, edge, seconds);
  syncMedia();
}

/** A drag on an overlay clip's body: a new start on the source clock, keeping its length. */
function onMediaClipMove(id, start) {
  const doc = preview?.document;
  const clip = mediaClips(doc).find((c) => c.id === id);
  if (!doc || !clip) return;
  const delta = start - clip.start;
  if (Math.abs(delta) < 1e-9) return;
  moveMediaClip(doc, id, delta);
  syncMedia();
}

/** One row of the clip list: what it is, when it runs, and the two things you can do to it. */
function mediaRow(clip) {
  const row = el('div', 'clip-row');
  row.dataset.clipId = clip.id;
  if (clip.id === selectedMediaClipId) row.classList.add('active');

  const name = el('button', 'clip-name', `${clip.kind === 'video' ? '\u25b6' : '\u25a2'} ${clip.name}`);
  name.title =
    `${clip.kind} · ${clipLength(clip).toFixed(2)}s · ${clip.start.toFixed(2)}s → ${clip.end.toFixed(2)}s\n` +
    'click to select it (the playhead moves to it)';
  name.addEventListener('click', () => selectMediaClip(clip.id));

  const where = el('span', 'clip-where mono', `${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s`);

  const actions = el('span', 'clip-actions');
  if (!mediaLibrary.has(clip.id)) {
    // The clip is in the programme but its bytes are not in this session. Drawn, so the programme is
    // honest about what it contains, and relinkable rather than silently empty.
    row.classList.add('offline');
    const relink = el('label', 'clip-relink', 'Relink');
    relink.title = `Choose the file for "${clip.name}" again — a project stores the clip, not its bytes`;
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.addEventListener('change', () => relinkClip(clip.id, input.files?.[0]));
    relink.append(input);
    actions.append(el('span', 'clip-offline', 'offline'), relink);
  }
  // Duplicate sits next to remove because they are the two things a row can do to the clip itself, and
  // copying is the one people reach for when a badge has to go in two corners.
  const copy = el('button', 'clip-dup', '\u29c9');
  copy.title = `Duplicate "${clip.name}" on the same window`;
  copy.addEventListener('click', () => {
    const doc = preview?.document;
    if (doc && duplicateSelectedClip(doc, clip)) {
      syncMedia();
      log(`clip duplicated: "${clip.name}"`);
    }
  });

  const remove = el('button', 'clip-remove', '\u00d7');
  remove.title = 'Remove this clip from the programme';
  remove.addEventListener('click', () => removeClip(clip.id));
  actions.append(copy, remove);

  row.append(name, where, actions);
  return row;
}

/** The clip list under the file input: one row per clip, plus the count in the hint. */
function renderMediaList() {
  const host = $('#media-list');
  if (!host) return;
  const clips = mediaClips(preview?.document);
  if (!clips.length) {
    host.replaceChildren(el('div', 'empty', '—'));
  } else {
    host.replaceChildren(...clips.map(mediaRow));
  }
  const offline = clips.filter((clip) => !mediaLibrary.has(clip.id)).length;
  const note = $('#media-note');
  if (note) {
    note.textContent = !clips.length
      ? 'Images and videos drawn over the picture, under the captions. They are silent — the master track under Audio is the programme\u2019s sound. No clips loaded.'
      : `${clips.length} clip${clips.length === 1 ? '' : 's'} over the picture${offline ? `, ${offline} with no file loaded (Relink to bring it back)` : ''}. Click a clip \u2014 here, on the Clips lane or on the preview \u2014 to get its handles: drag the body to move it, the square handles to resize it, the round one to turn it, and the lane's edges to trim it.`;
  }
}

// ---------------------------------------------------------------------------
// the selected clip's transform
// ---------------------------------------------------------------------------

/**
 * The pixel ratio a clip's picture keeps: its own shape when the file is loaded, its box's shape when
 * it is not.
 *
 * A file's shape is the right answer while the media is there — that is what "do not distort this"
 * means. For a clip whose file is offline there is no shape to keep, so the box's own is held instead;
 * refusing to resize a clip until its file comes back would be a panel that suddenly does nothing.
 */
function clipShapeAspect(clip) {
  const media = mediaLibrary.size(clip?.id);
  // The shape of what the clip *shows*, crop included: cropping a logo to a strip and then resizing it
  // must hold the strip's shape, not the file's.
  const content = media ? clipContentAspect(clip, media) : 0;
  if (content > 0) return content;
  const size = preview?.renderer?.size ?? null;
  return size ? clipPixelAspect(clip, size) : 0;
}

/** Whether the panel is in crop mode — read live, like every other mode. */
function clipCropMode() {
  return Boolean($('#clip-crop-toggle')?.checked);
}

/**
 * The one place a clip's *frame* changes — the preview's handles, the panel's sliders and their commit
 * lines all come through here.
 *
 * `live` is a gesture in progress: the picture is redrawn and the panel's numbers follow, but nothing is
 * logged, because a drag is one edit and not one per pointer move. `commit` is the end of a gesture: the
 * log line is written and the clips are republished, which is what puts a finished drag into the strip,
 * the list and the renderer at once.
 *
 * A box edit deliberately does **not** rebuild the strip mid-drag: a clip's box says nothing about when
 * it plays, so the lane has nothing to say about it, and re-rendering the lane sixty times a second to
 * prove that is work nobody asked for.
 */
function editClip(id, patch, { live = false, what = 'adjusted' } = {}) {
  const doc = preview?.document;
  const clip = mediaClips(doc).find((c) => c.id === id);
  if (!doc || !clip) return null;
  const next = updateMediaClip(doc, id, patch);
  if (!next) return null;
  if (!live) {
    // The full republish: it hands the renderer the canonical list, repaints the lane and the rows and
    // refills the panel, and it is also what puts the new box on the frame — the model answers a patch
    // with *fresh objects*, so an edit is only on screen once the new list has been published.
    syncMedia();
    log(`clip ${what}: "${clip.name}" ${describeTransform(next)}`);
    return next;
  }
  // A gesture in progress: the same publish to the renderer, without rebuilding the lane or the rows,
  // which cannot have changed — a box says nothing about when a clip plays.
  preview?.setMedia(mediaClips(doc), (clipId) => mediaLibrary.element(clipId));
  redraw();
  renderClipInspector();
  return next;
}

/**
 * Copy the selected clip: same window, same box, its own layer on top, and its own slot in the library.
 *
 * The *file* is shared rather than copied (`mediaLibrary.copy`), because a duplicated clip is a second
 * use of one picture: re-reading the bytes would re-decode a video the user already has open, and the two
 * clips would then decode the same file twice in the preview and twice in the export. The copy is left
 * selected, because a copy you cannot immediately see selected is a button that appears to do nothing.
 */
function duplicateSelectedClip(doc, clip) {
  const copy = duplicateClip(doc, clip.id);
  if (!copy) return false;
  mediaLibrary.copy(clip.id, copy.id);
  selectMediaClip(copy.id);
  return true;
}

/** A drag on a clip in the preview: its body (move) or one of its handles (resize). */
function onClipBox(id, box, info = {}) {
  return editClip(id, { box }, {
    live: Boolean(info.live),
    commit: Boolean(info.commit),
    what: info.resize ? 'resized' : 'moved',
  });
}

/**
 * A drag on a crop handle: which part of the clip's own file is shown.
 *
 * The box is untouched, which is the whole difference between cropping and resizing — and the crop is
 * applied to the *file*, so the same crop means the same thing after a move, a resize or a rotation.
 */
function onClipCrop(id, crop, info = {}) {
  return editClip(id, { crop }, {
    live: Boolean(info.live),
    commit: Boolean(info.commit),
    what: 'cropped',
  });
}

/** A drag on the round handle: the clip's rotation. */
function onClipRotation(id, degrees, info = {}) {
  return editClip(id, { rotation: degrees }, {
    live: Boolean(info.live),
    commit: Boolean(info.commit),
    what: 'rotated',
  });
}

/**
 * The selected clip, or `null`. Read fresh every time — the panel is a view of the document.
 *
 * Named apart from the `selectedClip` variable, which is the *timeline's* cut range: the two are different
 * kinds of thing and one function with the other's name would be a trap for the next reader.
 */
function selectedMediaClip() {
  return mediaClips(preview?.document).find((clip) => clip.id === selectedMediaClipId) ?? null;
}

/** Whether the panel's shape lock is on. Defaults to on, which is what an unlocked checkbox means. */
function clipShapeLocked() {
  const lock = $('#clip-lock');
  return !lock || lock.checked !== false;
}

/** The selected clip's media, as the frame the panel's shape maths needs. */
function clipFrameSize() {
  return preview?.renderer?.size ?? { width: 1, height: 1 };
}

/**
 * Fill the transform panel from the document.
 *
 * Every value is read back from the clip rather than remembered, so the panel cannot disagree with the
 * picture — and `except` is the slider the user is currently holding. A thumb is not moved while it is
 * being dragged: an edge-clamped box would otherwise fight the hand that is pushing it, and the readout
 * next to it is what says where the clip actually went.
 */
function renderClipInspector({ except = null } = {}) {
  const host = $('#clip-inspector');
  if (!host) return;
  const doc = preview?.document;
  const clip = selectedMediaClip();
  host.hidden = !clip;
  if (!clip) return;

  const set = (id, value) => {
    if (except && except === id) return;
    const input = $(`#${id}`);
    if (input) input.value = String(value);
  };
  const text = (id, value) => {
    const node = $(`#${id}`);
    if (node) node.textContent = value;
  };
  const pct = (v) => `${Math.round(v * 100)}%`;

  set('clip-x', clip.box.x);
  set('clip-y', clip.box.y);
  set('clip-w', clip.box.w);
  set('clip-h', clip.box.h);
  set('clip-rot', clip.rotation);
  set('clip-opacity', clip.opacity);
  text('clip-x-out', pct(clip.box.x));
  text('clip-y-out', pct(clip.box.y));
  text('clip-w-out', pct(clip.box.w));
  text('clip-h-out', pct(clip.box.h));
  text('clip-rot-out', `${Math.round(clip.rotation)}\u00b0`);
  text('clip-opacity-out', pct(clip.opacity));

  const fit = $('#clip-fit');
  if (fit) fit.value = clip.fit;

  // What the box means in pixels, which is the number that answers "why does this look small on a
  // 4K frame" — a fraction of the frame is not a size until it is multiplied by one.
  const size = clipFrameSize();
  const px = boxRect(clip.box, size);
  const media = mediaLibrary.size(clip.id);
  // Where the clip sits in the stack, which is the one number the picture itself cannot show: two clips
  // that overlap in time also overlap on the frame, and only the panel can say which one is winning.
  // The crop, as the four *insets* the panel edits: left/right/top/bottom, which is how a person describes
  // a cut ("a bit off the left") where the stored rectangle describes what is left.
  const crop = normalizeCrop(clip.crop);
  set('clip-crop-left', crop.x);
  set('clip-crop-top', crop.y);
  set('clip-crop-right', 1 - crop.x - crop.w);
  set('clip-crop-bottom', 1 - crop.y - crop.h);
  text('clip-crop-left-out', pct(crop.x));
  text('clip-crop-top-out', pct(crop.y));
  text('clip-crop-right-out', pct(1 - crop.x - crop.w));
  text('clip-crop-bottom-out', pct(1 - crop.y - crop.h));

  const layer = layerPosition(doc, clip.id);
  text('clip-inspector-name', `${clip.kind === 'video' ? '\u25b6' : '\u25a2'} ${clip.name}`);
  text(
    'clip-inspector-where',
    `${describeTransform(clip)} \u00b7 ${Math.round(px.width)}\u00d7${Math.round(px.height)} px` +
      (media ? ` \u00b7 file ${media.width}\u00d7${media.height}` : ' \u00b7 file not loaded') +
      // Which layer, of how many. The number is what answers "why is the badge behind the banner" —
      // the panel is the only place that can say it, because the picture just shows the result.
      (layer.count > 1 ? ` \u00b7 layer ${layer.index}/${layer.count}` : ''),
  );
  const hint = $('#clip-inspector-hint');
  if (hint) {
    hint.textContent = mediaLibrary.has(clip.id)
      ? 'Drag the clip on the preview to move it, the square handles to resize it, the round handle above it to turn it, and Alt to drag with no guides. Arrow keys nudge; shift inverts the shape lock for one drag.'
      : `No file is loaded for "${clip.name}" \u2014 Relink it in the list above. Its window and its box are still editable, and nothing is drawn until the file is back.`;
  }
  // The stack buttons are only meaningful with something to stack: a single clip has nowhere to go, and
  // a button that can never do anything is a button that teaches people the panel lies.
  const stackable = layer.count > 1;
  for (const [id, usable] of [
    ['clip-front', stackable && layer.index < layer.count],
    ['clip-forward', stackable && layer.index < layer.count],
    ['clip-backward', stackable && layer.index > 1],
    ['clip-back', stackable && layer.index > 1],
  ]) {
    const button = $(`#${id}`);
    if (button) button.classList.toggle('muted', !usable);
  }

  // Enabled only while a clip is selected: a panel offering to edit nothing is worse than no panel.
  for (const id of ['clip-x', 'clip-y', 'clip-w', 'clip-h', 'clip-rot', 'clip-opacity', 'clip-fit', 'clip-flip-x', 'clip-flip-y', 'clip-fit-frame', 'clip-fill-frame', 'clip-center', 'clip-reset', 'clip-duplicate', 'clip-front', 'clip-forward', 'clip-backward', 'clip-back', 'clip-crop-toggle', 'clip-crop-left', 'clip-crop-top', 'clip-crop-right', 'clip-crop-bottom', 'clip-crop-reset']) {
    const control = $(`#${id}`);
    if (control) control.disabled = false;
  }
}

/**
 * Wire the transform panel, once.
 *
 * The sliders edit live (`input`) and log on release (`change`), so a drag on one is a single entry in the
 * log rather than sixty. The buttons are whole commands and each is a call into `model/media.js`, the
 * same one the preview's own gestures end at, so a panel edit and a drag cannot produce different
 * documents.
 */
function wireClipInspector() {
  const host = $('#clip-inspector');
  if (!host) return;

  /** Apply a panel edit to the box, holding the picture's shape when one slider moved. */
  const boxEdit = (change, { driver = null, live = false } = {}) => {
    const clip = selectedMediaClip();
    if (!clip) return null;
    let box = { ...clip.box, ...change };
    if (clipShapeLocked() && driver) {
      box = boxWithAspect(box, clipShapeAspect(clip), clipFrameSize(), { driver });
    }
    return editClip(clip.id, { box }, { live, what: driver ? 'resized' : 'moved' });
  };

  const bindRange = (id, apply) => {
    const input = $(`#${id}`);
    if (!input) return;
    const read = () => Number(input.value);
    input.addEventListener('input', () => {
      apply(read(), { live: true });
      // Every *other* control is refilled from the model — the height a shape lock derived from the width
      // has to appear, or the panel would be describing a box that no longer exists. The slider under the
      // hand is left alone, because moving a thumb while it is being dragged is the one thing a range
      // control must never do.
      renderClipInspector({ except: id });
    });
    input.addEventListener('change', () => apply(read(), { live: false }));
  };

  bindRange('clip-x', (value, opts) => boxEdit({ x: value }, opts));
  bindRange('clip-y', (value, opts) => boxEdit({ y: value }, opts));
  bindRange('clip-w', (value, opts) => boxEdit({ w: value }, { ...opts, driver: 'w' }));
  bindRange('clip-h', (value, opts) => boxEdit({ h: value }, { ...opts, driver: 'h' }));
  bindRange('clip-rot', (value, opts) => {
    const clip = selectedMediaClip();
    return clip ? editClip(clip.id, { rotation: value }, { live: opts.live, what: 'rotated' }) : null;
  });
  bindRange('clip-opacity', (value, opts) => {
    const clip = selectedMediaClip();
    return clip ? editClip(clip.id, { opacity: value }, { live: opts.live, what: 'made more/less opaque' }) : null;
  });

  const fit = $('#clip-fit');
  fit?.addEventListener('change', () => {
    const clip = selectedMediaClip();
    if (clip) editClip(clip.id, { fit: fit.value }, { what: `fitting set to ${fit.value}` });
  });

  // A command is a whole edit with a name, so every button reads the same way and every one of them
  // ends with a log line a person can check against what they saw happen.
  const command = (id, what, run) => {
    const button = $(`#${id}`);
    if (!button) return;
    button.addEventListener('click', () => {
      const doc = preview?.document;
      const clip = selectedMediaClip();
      if (!doc || !clip) return;
      if (run(doc, clip) === false) return;
      // `syncMedia` republishes the clips to the renderer *and* refills this panel, which is the whole
      // effect of a command — nothing else has to be asked for.
      syncMedia();
      log(`clip ${what}: "${clip.name}"`);
    });
  };

  /**
   * A crop edit keeps the edge opposite the one being moved: a slider says how much to cut off *one* side,
   * so the other three stay where the user put them. The floor is the model's own `MIN_CROP`, so a slider
   * cannot ask for a crop the model would refuse.
   */
  const cropEdit = (patch, opts = {}) => {
    const clip = selectedMediaClip();
    if (!clip) return null;
    return editClip(clip.id, { crop: normalizeCrop({ ...clip.crop, ...patch }) }, { live: opts.live, what: 'cropped' });
  };
  const cropFrom = (side, value, opts) => {
    const clip = selectedMediaClip();
    if (!clip) return null;
    const c = normalizeCrop(clip.crop);
    if (side === 'left') return cropEdit({ x: value, w: Math.max(MIN_CROP, c.x + c.w - value) }, opts);
    if (side === 'top') return cropEdit({ y: value, h: Math.max(MIN_CROP, c.y + c.h - value) }, opts);
    if (side === 'right') return cropEdit({ w: Math.max(MIN_CROP, 1 - value - c.x) }, opts);
    return cropEdit({ h: Math.max(MIN_CROP, 1 - value - c.y) }, opts);
  };
  bindRange('clip-crop-left', (value, opts) => cropFrom('left', value, opts));
  bindRange('clip-crop-top', (value, opts) => cropFrom('top', value, opts));
  bindRange('clip-crop-right', (value, opts) => cropFrom('right', value, opts));
  bindRange('clip-crop-bottom', (value, opts) => cropFrom('bottom', value, opts));
  command('clip-crop-reset', 'crop reset to the whole file', (doc, clip) => Boolean(resetClipCrop(doc, clip.id)));

  command('clip-front', 'brought to the front', (doc, clip) => Boolean(reorderClip(doc, clip.id, 'front')));
  command('clip-forward', 'brought one layer forward', (doc, clip) => Boolean(reorderClip(doc, clip.id, 'up')));
  command('clip-backward', 'sent one layer back', (doc, clip) => Boolean(reorderClip(doc, clip.id, 'down')));
  command('clip-back', 'sent to the back', (doc, clip) => Boolean(reorderClip(doc, clip.id, 'back')));
  command('clip-duplicate', 'duplicated', (doc, clip) => duplicateSelectedClip(doc, clip));
  command('clip-flip-x', 'mirrored left to right', (doc, clip) => Boolean(flipMediaClip(doc, clip.id, 'x')));
  command('clip-flip-y', 'mirrored top to bottom', (doc, clip) => Boolean(flipMediaClip(doc, clip.id, 'y')));
  command('clip-fit-frame', 'fitted to the frame', (doc, clip) => Boolean(fitClipToFrame(doc, clip.id, { mode: 'contain' })));
  command('clip-fill-frame', 'filled the frame', (doc, clip) => Boolean(fitClipToFrame(doc, clip.id, { mode: 'cover' })));
  command('clip-center', 'centred', (doc, clip) => Boolean(centerClipBox(doc, clip.id)));
  command('clip-reset', 'reset to how it arrived', (doc, clip) =>
    Boolean(resetMediaClip(doc, clip.id, { media: mediaLibrary.size(clip.id), canvas: doc.canvas })),
  );
}

// ---------------------------------------------------------------------------
// sources: the files the programme is built from
// ---------------------------------------------------------------------------

async function onAi(file) {
  if (!file) return;
  try {
    setStatus('reading AI source…');
    const { document: doc, kind } = importJSON(await file.text());
    store.setState({ aiDoc: doc });
    const words = doc.blocks.reduce((n, b) => n + b.words.length, 0);
    log(`AI source: "${file.name}" → ${doc.blocks.length} blocks, ${words} words`);
    if (kind !== 'veed') log(`note: detected as ${kind}`);
    $('#ai-note').textContent = `${file.name} — ${doc.blocks.length} blocks, ${words} words${kind !== 'veed' ? ` (detected as ${kind})` : ''}`;
  } catch (err) {
    log(`ERROR importing AI source: ${err.message}`);
    $('#ai-note').textContent = `${file.name} could not be read: ${err.message}`;
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
    $('#truth-note').textContent =
      `${file.name} — ${cues.length} ${isVtt ? 'VTT' : 'SRT'} cues${warnings.length ? `, ${warnings.length} warning(s)` : ''}`;
  } catch (err) {
    log(`ERROR parsing TRUTH source: ${err.message}`);
    $('#truth-note').textContent = `${file.name} could not be parsed: ${err.message}`;
  } finally {
    setStatus('idle');
    refreshAlignButton();
  }
}

// ---------------------------------------------------------------------------
// transcribe — asking the Python studio next door for the timings
// ---------------------------------------------------------------------------

let transcribing = false;

/**
 * The one thing this module adds to the pipeline is a *source*.
 *
 * `caption-studio` corrects an AI transcript against a trusted subtitle file, and it is good at
 * it — but it inherits its word timings from Veed, so every split, join and reveal inherits Veed's
 * error. This section replaces the AI source with one measured from the audio, and then does
 * nothing else: the document it produces is loaded through the very same `importJSON` a file from
 * disk goes through, so the alignment and editing that follow are exactly the ones that already
 * worked.
 */
// ---------------------------------------------------------------------------
// presets — which model a run actually loads
// ---------------------------------------------------------------------------

/**
 * What the server says each preset runs: `[]` until it has been asked.
 *
 * A preset id is a speed/accuracy trade-off, and the two things that decide whether a run works are
 * which model it loads and whether this machine already has that model. The panel used to offer
 * "balanced — small model", which answers neither — `balanced` is not a model and "small" is not a
 * file. The server's `presetDetails` is the answer (`audio_studio/models.py` builds it), and the
 * static labels in `index.html` stand in until the first probe.
 */
let presetDetails = [];

/** One preset in a sentence: what it loads, how big it is, and whether it is already here. */
function describePresetRun(presetId) {
  const row = presetDetails.find((entry) => entry.id === presetId);
  if (!row) return null;
  const size = row.params ? `, ${row.params} parameters` : '';
  const state =
    row.downloaded === true
      ? 'That model is already downloaded on this machine'
      : row.downloaded === false
        ? `That model is NOT downloaded yet — the first run fetches ${row.repo} from the hub`
        : 'The server did not say whether that model is downloaded here';
  return (
    `Preset ${row.id} runs ${row.modelName} — ${row.repo}${size}, ${row.languages}. ${state}` +
    (row.note ? ` — ${row.note}.` : '.')
  );
}

function setModelNote(text) {
  const note = $('#transcribe-model-note');
  if (note) note.textContent = text;
}

/**
 * Re-read the note for the preset that is selected.
 *
 * Silent when the server has not been asked yet: the static sentence in the page is better than
 * replacing it with nothing, and "ask the server" is already the button right above it.
 */
function refreshModelNote() {
  const select = $('#transcribe-preset');
  if (!select) return;
  const text = describePresetRun(select.value);
  if (text) setModelNote(text);
}

/**
 * Rebuild the preset menu from the server's answer, download state included.
 *
 * The ids are the server's contract and do not change; what changes is that the label now names the
 * model, so choosing "accurate" no longer means picking between three words that say nothing about
 * what is about to run. An unrecognised current value falls back to the default rather than silently
 * selecting whatever happens to be first.
 */
function rebuildPresetOptions(info) {
  const rows = Array.isArray(info?.presetDetails) ? info.presetDetails : [];
  if (!rows.length) return;
  const select = $('#transcribe-preset');
  if (!select) return;
  const wanted = select.value;
  const label = (row) => {
    const mark = row.downloaded === true ? ' · downloaded' : row.downloaded === false ? ' · will download' : '';
    return `${row.id} — ${row.modelName}${row.params ? `, ${row.params}` : ''}${mark}`;
  };
  select.replaceChildren(
    ...rows.map((row) => {
      const option = el('option', null, label(row));
      option.value = row.id;
      return option;
    }),
  );
  if (rows.some((row) => row.id === wanted)) select.value = wanted;
  else if (rows.some((row) => row.id === 'balanced')) select.value = 'balanced';
  refreshModelNote();
}

function setTranscribeNote(text) {
  $('#transcribe-note').textContent = text;
}

function setTranscribeProgress(fraction) {
  const bar = $('#transcribe-bar');
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function refreshTranscribeButton() {
  $('#transcribe-btn').disabled = transcribing || !$('#transcribe-in').files?.length;
}

/**
 * The dependencies this server has, against the ones it was verified with.
 *
 * Empty when there is nothing to say — an older server that does not report its pins, or
 * one where every pin matches. `pins.differs` is the list worth reading: each entry is a
 * package whose installed version is not the pinned one, which on this project has already
 * meant "decodes on one machine and not on the other, from the same commit".
 */
function describePinMismatch(report) {
  const differs = report?.differs ?? [];
  if (!differs.length) return '';
  const lines = differs
    .map((row) => `${row.name} ${row.installed} (pinned ${row.pinned})`)
    .join(', ');
  return (
    `${differs.length} package(s) differ from audio-studio's requirements.txt: ${lines}. ` +
    'A transcription may fail for a reason that has nothing to do with your audio — run ' +
    '`pip install -r requirements.txt` in the audio-studio folder, then `python -m audio_studio doctor`.'
  );
}

/** Ask the server what it can actually do here, before trusting it with a job. */
async function onTranscribeProbe() {
  const badge = $('#transcribe-status');
  badge.textContent = 'checking…';
  try {
    const info = await health($('#transcribe-url').value);
    const available = (list) => (list ?? []).filter((entry) => entry.available).map((entry) => entry.name);
    const engines = available(info.engines);
    const aligners = available(info.aligners);
    const validators = available(info.validators);

    // A machine whose dependencies have drifted from the set the studio was verified
    // against is reported *before* a job is queued rather than after it fails: the same
    // code on two machines behaves differently for exactly one reason, and the error it
    // produces (`cannot decode audio: … install ffmpeg`) names neither the package nor
    // the version. This is the one place the browser can say so up front.
    const pins = describePinMismatch(info.pins);

    badge.textContent = `audio-studio ${info.version}`;
    log(`audio-studio ${info.version} — engines: ${engines.join(', ') || 'none'}`);
    log(`  aligners: ${aligners.join(', ') || 'none'} · validators: ${validators.join(', ') || 'none'}`);

    // The models behind the presets, and whether this machine already has them. That is the one
    // difference that has already made the same commit behave differently on two machines, so it is
    // said here — before a job is queued — rather than surfacing as a hub download that fails
    // halfway through one. `audio_studio/models.py` builds it; the option labels are rebuilt from it.
    presetDetails = Array.isArray(info.presetDetails) ? info.presetDetails : [];
    rebuildPresetOptions(info);
    const presetLines = presetDetails.map((row) => {
      const mark = row.downloaded === true ? 'downloaded' : row.downloaded === false ? 'NOT downloaded yet' : 'unknown';
      return `  ${row.id}: ${row.modelName} (${row.repo}) — ${mark}`;
    });
    for (const line of presetLines) log(line);
    const toFetch = presetDetails.filter((row) => row.downloaded === false).map((row) => row.id);
    if (toFetch.length) {
      log(`  ⚠ not downloaded on this machine yet: ${toFetch.join(', ')} — that preset fetches its model on the first run`);
    }
    if (pins) log(`  ⚠ ${pins}`);
    setTranscribeNote(
      `audio-studio ${info.version} is up.\npresets: ${(info.presets ?? []).join(', ')} (default ${info.defaultPreset})\n` +
        `${presetLines.join('\n')}\n` +
        `aligners: ${aligners.join(', ') || 'none'}   validators: ${validators.join(', ') || 'none'}` +
        (pins ? `\n\n⚠ ${pins}` : ''),
    );
    // A server that answered has runs, and its runs are the reason to prefer opening one to
    // transcribing again — so the list is filled the moment the server proves it is there.
    await refreshRuns({ announce: false });
  } catch (err) {
    // "Busy" and "absent" are different problems with different fixes, so the badge must not
    // flatten them: the first click after the server starts can genuinely be a slow one.
    badge.textContent = err.timedOut ? 'server busy — retry' : 'server unreachable';
    log(`ERROR ${err.toString()}`);
    setTranscribeNote(err.toString());
  }
}

/**
 * Ask the server which runs it has finished, and offer them.
 *
 * The counterpart to the transcribe button: a run already exists on the Python side, so the useful
 * thing is to *open* it rather than to do the same minutes of work again. The list is fetched, never
 * cached — the server is the register of its own runs, and a stale menu here would offer a job whose
 * folder has since been deleted.
 */
async function refreshRuns({ announce = true } = {}) {
  const select = $('#runs-select');
  const openBtn = $('#runs-open');
  if (!select) return [];
  const base = $('#transcribe-url').value;
  if (announce) log('runs: asking the server what it has finished…');
  let runs = [];
  try {
    runs = await listRuns(base);
  } catch (err) {
    select.replaceChildren(el('option', null, '— the server is not reachable —'));
    select.value = '';
    openBtn.disabled = true;
    $('#runs-note').textContent =
      `Could not list runs: ${err.toString()}${err.hint ? ` — ${err.hint}` : ''}`;
    if (announce) log(`ERROR runs: ${err.toString()}`);
    return [];
  }

  select.replaceChildren();
  if (!runs.length) {
    select.append(el('option', null, '— no finished runs on that server yet —'));
    select.value = '';
    openBtn.disabled = true;
    $('#runs-note').textContent = 'That server has no finished run with captions to open.';
    if (announce) log('runs: none yet');
    return [];
  }
  for (const run of runs) {
    const option = el('option', null);
    option.value = run.id;
    option.textContent = `${run.name} — ${run.captions} captions, ${run.words} words`;
    select.append(option);
  }
  select.value = runs[0].id;
  openBtn.disabled = false;
  $('#runs-note').textContent =
    `${runs.length} finished run${runs.length === 1 ? '' : 's'} on the server, newest first. ` +
    'Opening one loads its captions exactly as it wrote them. The media is not sent back, so load ' +
    'the same recording under Sources to hear it against them.';
  if (announce) log(`runs: ${runs.length} finished run(s) on the server`);
  return runs;
}

/** Open a finished run's captions, without transcribing anything again. */
async function onOpenRun() {
  const select = $('#runs-select');
  const jobId = select?.value;
  if (!jobId) return;
  const label = select.options[select.selectedIndex]?.textContent ?? jobId;
  try {
    stateOf('transcribe', 'busy', 'opening…', `Fetching "${label}"...`);
    log(`runs: opening ${label}`);
    const { text, job } = await openRun($('#transcribe-url').value, jobId);
    const { document: doc, kind } = importJSON(text);
    store.setState({ aiDoc: doc });
    const words = doc.blocks.reduce((n, b) => n + b.words.length, 0);
    await showDocument(doc, `an existing run's captions → ${doc.blocks.length} blocks`);
    // An opened run gets the same treatment as a fresh one: its Veed master and its SRT go into
    // Sources, so "open an existing run" ends somewhere usable instead of in an empty panel.
    const filled = await reflectRunInSources({
      base: $('#transcribe-url').value,
      jobId,
      job,
    });
    if (filled.length) log(`sources: ${filled.join(' + ')} filled in from this run`);
    const audit = describeStudioAudit(job);
    for (const line of audit) log(`  ${line}`);
    stateOf(
      'transcribe',
      'ok',
      'opened',
      `Opened ${label} — ${doc.blocks.length} captions, ${words} words (${kind}), read from the ` +
        "server's own output. Nothing was transcribed again." +
        (filled.length ? `\nSources: ${filled.join(' + ')} filled in from this run.` : ''),
    );
  } catch (err) {
    log(`ERROR runs: ${err.toString()}`);
    stateOf('transcribe', 'failed', 'failed', `That run could not be opened.\n${err.toString()}`);
  }
}

/**
 * Transcribe a recording on the server and load the result as the AI source.
 *
 * The audio is also handed to the preview, because the track the captions were measured from is
 * the one a person wants to hear while checking them.
 */
async function onTranscribe() {
  const file = $('#transcribe-in').files?.[0];
  if (!file || transcribing) return;

  // The lyrics are read here, in the page, because the server never sees the user's disk. A file
  // that cannot be read stops the run before anything is uploaded: sending the recording anyway
  // would transcribe it and then quietly ignore the lyrics, which is the worst of both.
  //
  // Pasted words count exactly as much as a file does. This is the field that keeps a sung
  // transcript from drifting, and "save your lyrics as a .txt first" is a step nobody takes — so a
  // pasted reference is not a convenience, it is the difference between the feature being used and
  // the feature being skipped.
  const lyricsFile = $('#lyrics-in').files?.[0];
  let lyrics = $('#lyrics-text')?.value?.trim() || '';
  let lyricsName = lyrics ? 'pasted lyrics' : undefined;
  if (lyricsFile) {
    try {
      lyrics = await lyricsFile.text();
      lyricsName = lyricsFile.name;
    } catch (err) {
      log(`ERROR lyrics: could not read "${lyricsFile.name}" — ${err}`);
      setTranscribeNote(`could not read ${lyricsFile.name}`);
      stateOf('transcribe', 'failed', 'failed', `The lyrics file "${lyricsFile.name}" could not be read: ${err}`);
      return;
    }
  }

  const options = optionsFor({
    preset: $('#transcribe-preset').value,
    language: $('#transcribe-language').value.trim(),
    align: $('#transcribe-align').value,
    validate: $('#transcribe-validate').value,
    // 'auto' asks the studio to write the words the LLM validator picked to emphasise into the
    // Veed ranges — the AI auto-highlight. Empty means off, and is sent as absent.
    emphasis: $('#transcribe-emphasis').value || undefined,
    emit: 'json,veed,srt,vtt',
    referenceText: lyrics,
    referenceName: lyricsName,
  });

  transcribing = true;
  refreshTranscribeButton();
  $('#transcribe-bar').classList.remove('failed');
  $('#transcribe-bar').classList.add('busy');
  setTranscribeProgress(0);
  setStatus('transcribing…');
  stateOf(
    'transcribe',
    'busy',
    'transcribing…',
    `Transcribing "${file.name}" (${(file.size / 1e6).toFixed(1)} MB)` +
      (lyricsName ? ` with the words from ${lyricsName}.` : '. No reference lyrics: the transcriber decides both the words and the timing.'),
  );
  log(
    `transcribe: "${file.name}" (${(file.size / 1e6).toFixed(1)} MB)` +
      `${options.align ? ` · align ${options.align}` : ''}${options.validate ? ` · validate ${options.validate}` : ''}` +
      `${options.emphasis ? ` · emphasis ${options.emphasis}` : ''}` +
      `${lyricsName ? ` · lyrics "${lyricsName}"` : ''}`,
  );
  if (!lyricsName) {
    log('  note: no reference lyrics — the text and the timing both come from the audio alone');
  }

  let lastLogged = -1;
  try {
    const { veed, text, job } = await transcribeFile($('#transcribe-url').value, file, options, {
      onProgress: (fraction, message) => {
        setTranscribeProgress(fraction);
        setTranscribeNote(`${Math.floor(fraction * 100)}% — ${message}`);
        const percent = Math.floor(fraction * 100);
        if (percent >= lastLogged + 25) {
          lastLogged = percent;
          log(`  ${percent}% ${message}`);
        }
      },
    });

    const { document: doc, kind } = importJSON(text);
    store.setState({ aiDoc: doc });
    const words = doc.blocks.reduce((n, b) => n + b.words.length, 0);
    const seconds = job.summary?.seconds ?? job.seconds;
    log(`AI source: audio-studio → ${doc.blocks.length} blocks, ${words} words (${kind}${seconds ? `, ${seconds}s` : ''})`);

    // The provenance the other studio wrote is the reason a person can trust these timings, so it
    // is shown rather than swallowed.
    const audit = describeStudioAudit(veed);
    for (const line of audit) log(`  ${line}`);
    setTranscribeNote(audit.join('\n'));
    setTranscribeProgress(1);

    // The credits, and then the captions themselves: a run that finished and left the stage empty
    // would have done all the work and shown nothing, which is what used to happen here.
    //
    // A recording that is also a video is loaded as the picture as well. It is the same file the user
    // chose to transcribe — not a guess at a different one — and a project with a picture in it is
    // ready to export without a second trip to Sources.
    const isVideo = String(file.type ?? '').startsWith('video/');
    if (isVideo) await onVideo(file);
    await onAudio(file);
    await showDocument(
      doc,
      `transcribed captions → ${doc.blocks.length} blocks from "${file.name}"`,
    );

    // The run's own files, put where the next step looks for them. TRUTH is filled from the run's
    // own SRT — see `reflectRunInSources` for why the studio's file wins over the lyric sheet the
    // run was given, even when that sheet was a subtitle file.
    const filled = await reflectRunInSources({
      base: $('#transcribe-url').value,
      jobId: job.jobId ?? job.id,
      job,
      stem: exportStem(file),
    });
    if (filled.length) log(`sources: ${filled.join(' + ')} filled in from this run`);

    stateOf(
      'transcribe',
      'ok',
      'done',
      `Done — ${doc.blocks.length} captions, ${words} words from "${file.name}". They are on the stage and on the timeline now.` +
        (isVideo ? '\nThe recording is a video, so it is loaded as the picture too.' : '') +
        (filled.length ? `\nSources: ${filled.join(' + ')} filled in from this run.` : ''),
    );
    // The run that just finished is now the newest entry in the list.
    await refreshRuns({ announce: false });
  } catch (err) {
    $('#transcribe-bar').classList.add('failed');
    log(`ERROR transcribe: ${err.toString()}`);
    setTranscribeNote(err.toString());
    stateOf(
      'transcribe',
      'failed',
      'failed',
      `The transcription did not finish.\n${err.toString()}`,
    );
  } finally {
    transcribing = false;
    $('#transcribe-bar').classList.remove('busy');
    refreshTranscribeButton();
    refreshAlignButton();
    setStatus('idle');
  }
}

// ---------------------------------------------------------------------------
// export — writing the finished thing out
// ---------------------------------------------------------------------------

let exporting = false;
// The handle a running export can be stopped through. The encoder takes an `AbortSignal` for exactly
// this, so a long export is something the user can give up on rather than wait out.
let exportController = null;

/**
 * Ask a running export to stop.
 *
 * Aborting rejects `exportDocumentToVideo` with an `AbortError` at its next checkpoint, and its own
 * `finally` blocks close the encoder and remove the off-screen decoder, so nothing is left running.
 * The window reads the rejection as *cancelled*, not failed — it is the one that asked.
 */
function stopExport() {
  if (!exportController) return;
  log('export: stopping…');
  exportController.abort();
}

function setExportNote(text) {
  $('#export-note').textContent = text;
}

function setExportProgress(fraction) {
  const bar = $('#export-bar');
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

/**
 * Which export buttons make sense right now.
 *
 * A caption file needs only a document; the video needs a *picture* to burn the captions into, so it
 * stays disabled until one is loaded rather than failing when clicked. Every button is off while a
 * recording is in flight, because a second export would fight the first for the transport.
 */
function refreshExportButtons() {
  const doc = preview?.document;
  const ready = Boolean(doc) && !exporting;
  $('#download-video').disabled = !(ready && Boolean(store.getState().video));
  for (const id of ['#download-project', '#download-veed', '#download-srt', '#download-vtt']) {
    $(id).disabled = !ready;
  }
}

/** Save one of the caption files (`.caproj`, `.veed.json`, `.srt`, `.vtt`). */
function onDownloadFile(ext) {
  const doc = preview?.document;
  if (!doc) {
    const message = 'There are no captions to save yet — run the correction, transcribe a recording, or open the demo first.';
    log(`download: ${message}`);
    stateOf('export', 'warn', 'nothing to save', message);
    return;
  }
  const file = captionFiles(doc).find((candidate) => candidate.name.endsWith(ext));
  if (!file) return;
  downloadText(file.name, file.text, file.mime);
  const kb = (file.text.length / 1024).toFixed(1);
  log(`export: saved ${file.name} (${kb} KB)`);
  setExportNote(`saved ${file.name}`);
  stateOf(
    'export',
    'ok',
    'saved',
    `Saved ${file.name} — ${kb} KB, ${doc.blocks.length} captions.\nYour browser put it in its downloads folder.`,
  );
}

/**
 * Open the export window.
 *
 * Nothing is encoded until its Export button is pressed, so the resolution, frame rate, quality and
 * bitrates can be looked at — and changed — before a long encode starts.
 */
function openExportDialog() {
  const doc = preview?.document;
  if (!doc) {
    const message = 'There are no captions to burn in yet — run the correction, transcribe a recording, or open the demo first.';
    log(`export: ${message}`);
    stateOf('export', 'warn', 'nothing to export', message);
    return;
  }
  if (!store.getState().video) {
    const message =
      'A video export needs a picture to burn the captions into. Load one under Sources — the caption files can be saved without one.';
    log(`export video: ${message}`);
    stateOf('export', 'warn', 'no picture', message);
    return;
  }
  const ctx = exportContext();
  exportDialog.open({ ratioId: ctx.ratioId, sourceFps: ctx.sourceFps });
}

/**
 * Where the export gets its pixels, its shape and its frame rate: the document, the picture, and the
 * ratio the project is already on.
 */
function exportContext() {
  const doc = preview?.document ?? null;
  const video = $('#preview-video');
  // The **original** file's size, never the preview copy's. Once a preview copy exists the element on
  // screen is smaller than the master, and reading the size off it would quietly cap the export at the
  // preview's resolution — the one thing a proxy must never do. `previewSource` is the single place
  // that knows the difference; see `io/preview-source.js`.
  const sourceSize =
    previewSource.exportSize ??
    (video && video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
  const docSize = doc?.canvas ? { width: doc.canvas.width, height: doc.canvas.height } : sourceSize;
  return {
    doc,
    sourceSize,
    sourceFps: Number(doc?.canvas?.fps) || 0,
    docSize,
    aspect: docSize && docSize.height > 0 ? docSize.width / docSize.height : 16 / 9,
    ratioId: presetIdFor(doc?.canvas),
  };
}

/** The dialog's settings — what the Export window is currently set to. */
function exportSettings() {
  return exportDialog?.settings ?? defaultExportSettings();
}

/** The pixel size the export will produce, from those settings. */
function exportSize() {
  return outputSize(exportSettings(), exportContext());
}

/**
 * Render the captions into the video and download the result.
 *
 * This is a real encode, not a screen recording: the frame stepping and the encoder live in
 * `io/webcodecs-export.js`. It is handed a **URL**, not the element on screen, so the exporter
 * decodes from its own off-screen copy — the preview keeps playing (or stays parked) and is never
 * seeked out from under the user, which is what made the old burn-in look like a recording.
 *
 * **It resolves with the file it wrote** (`{name, bytes, seconds, frames}`) and rethrows a failure, so
 * the export window can end in a state a person can read — "Saved x.mp4 — 9.2 MB" or the reason it
 * could not — instead of leaving its last progress message on screen forever.
 */
async function runExport(settings) {
  const doc = preview?.document;
  const video = $('#preview-video');
  if (exporting || !doc) return;
  const encoder = encoderSettings(settings, exportContext());
  const { format, quality, size, fps } = encoder;
  const state = store.getState();
  const controller = new AbortController();
  exportController = controller;
  exporting = true;
  refreshExportButtons();
  $('#export-bar').classList.remove('failed');
  $('#export-bar').classList.add('busy');
  setExportProgress(0);
  setStatus('encoding\u2026');
  stateOf('export', 'busy', 'encoding\u2026', `Encoding at ${size.width}\u00d7${size.height}\u2026`);
  log(
    `export: rendering the captions into a .${format} at ${size.width}\u00d7${size.height}, ${fps}fps, ${quality} quality, ` +
      `${(encoder.videoBitsPerSecond / 1e6).toFixed(1)} Mbps video — frames are drawn and encoded, not recorded`,
  );
  // Honest about the one thing that silently costs quality: a frame smaller than the picture is a
  // downscale, and the ratio picker is where that gets fixed. Measured against the *original* file, so
  // a preview copy can never make a real downscale look like it is not one.
  const master = previewSource.exportSize;
  if (master && (master.width > size.width || master.height > size.height)) {
    log(
      `  ⚠ encoding at ${size.width}×${size.height} while the picture is ` +
        `${master.width}×${master.height} — the export is downscaled (set the frame ratio to the picture’s own)`,
    );
  }
  log(
    `  decoding from the file you loaded${previewSource.proxied ? ', not the preview copy' : ''}` +
      `${master ? ` (${master.width}×${master.height})` : ''}`,
  );
  // deliberately *not* `preview.pause()`: the exporter decodes from its own off-screen copy, so
  // leaving the transport exactly where the user put it is the point of this path

  try {
    const result = await exportDocumentToVideo({
      doc,
      // The original URL, deliberately not `video.src`: a preview copy may be what the element is
      // playing, and burning captions into a 720p copy would write the low-quality preview to disk.
      sourceUrl: previewSource.exportUrl || video.currentSrc || video.src,
      audioBlob: state.audio ?? null,
      // The files behind the overlay clips, by clip id. The export decodes them from elements of its own,
      // so neither the preview nor the export can disturb the other; a clip with no file is reported
      // below rather than dropped in silence.
      clipUrls: Object.fromEntries(
        mediaClips(doc)
          .map((clip) => [clip.id, mediaLibrary.url(clip.id)])
          .filter(([, url]) => Boolean(url)),
      ),
      format,
      fps,
      quality,
      size,
      videoBitsPerSecond: encoder.videoBitsPerSecond,
      audioBitsPerSecond: encoder.audioBitsPerSecond,
      signal: controller.signal,
      onProgress: (fraction, message) => {
        setExportProgress(fraction);
        setExportNote(message);
        exportDialog.setProgress(fraction, message);
      },
    });
    const name = `${exportStem(doc)}.${result.format}`;
    downloadBlob(name, result.blob);
    setExportProgress(1);
    // Which of the two decode paths the export actually got. It is one line, and it is the difference
    // between "this file is slow to export" being a mystery and being a fact about the file.
    log(`  the picture was ${result.picture}`);
    if (result.pictureNote) log(`  note: ${result.pictureNote}`);
    if (result.blankFrames) log(`  ⚠ ${result.blankFrames} frame(s) had no picture to draw — they are black`);
    if (result.audioSkipped) log(`  ⚠ ${result.audioSkipped}`);
    else if (result.audioNote) log(`  note: ${result.audioNote}`);
    if (result.clips) log(`  ${result.clips} overlay clip(s) rendered into the frames`);
    if (result.clipsMissing?.length) {
      log(`  ⚠ ${result.clipsMissing.length} clip(s) had no file loaded and are not in the export: ${result.clipsMissing.join(', ')}`);
    }
    const mb = (result.blob.size / 1e6).toFixed(1);
    const mbps = (result.videoBitsPerSecond / 1e6).toFixed(1);
    log(
      `export: ${name} — ${mb} MB, ${result.seconds.toFixed(1)}s, ${result.width}×${result.height} @ ${result.fps}fps, ` +
        `${result.frames} frames, ${result.videoCodec}, ${mbps} Mbps${result.audio ? ` with ${result.audioCodec} audio` : ' (no audio track)'}`,
    );
    setExportNote(
      `saved ${name} — ${mb} MB, ${result.frames} frames at ${mbps} Mbps${result.audio ? '' : ' (no audio track)'}`,
    );
    // The one place a finished export is reported. `warn` only when the encoder had to *drop*
    // something: a note about the track being shorter than the picture is the normal case for a
    // master track, and colouring every export amber is how a real warning stops being read.
    const caveat = result.audioSkipped || result.audioNote || '';
    stateOf(
      'export',
      result.audioSkipped ? 'warn' : 'ok',
      'saved',
      `Saved ${name} — ${mb} MB, ${result.seconds.toFixed(1)}s, ${result.width}×${result.height} @ ${result.fps}fps, ` +
        `${result.frames} frames${result.audio ? ' with sound' : ' with no audio track'}.` +
        (caveat ? `\n${caveat}` : '\nYour browser put it in its downloads folder.'),
    );
    return {
      name,
      bytes: result.blob.size,
      seconds: result.seconds,
      frames: result.frames,
      audio: Boolean(result.audio),
      audioNote: result.audioNote ?? '',
      audioSkipped: result.audioSkipped ?? '',
    };
  } catch (err) {
    // A cancel is not a failure. Nothing was written and nobody asked for a file, so it is reported as
    // what it is rather than as an error to go and read the log about.
    if (err?.name === 'AbortError') {
      log('export: stopped before it finished — no file was written');
      setExportNote('the export was stopped — no file was written');
      stateOf('export', 'warn', 'stopped', 'The export was stopped, so no file was written.');
      throw err;
    }
    $('#export-bar').classList.add('failed');
    log(`ERROR export: ${err.message}`);
    setExportNote(err.message);
    stateOf('export', 'failed', 'failed', `The export did not finish.\n${err.message}`);
    // Re-thrown on purpose: the caller opening the window is the one that has to say so on screen.
    throw err;
  } finally {
    exporting = false;
    if (exportController === controller) exportController = null;
    $('#export-bar').classList.remove('busy');
    refreshExportButtons();
    setStatus('idle');
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

    // The other half of the Sources panel's work, reported the same way its inputs are:
    // this ran from this panel's own two files, and it used to finish in the log alone, so
    // the panel a person was looking at said nothing about the step it had just run.
    stateOf(
      'sources',
      errors.length ? 'warn' : 'ok',
      errors.length ? `${errors.length} problem(s)` : 'aligned',
      `Corrected ${report.aligned}/${report.sourceWords} words against ${report.anchors} anchors, ` +
        `${corrections.length} correction(s); ${doc.blocks.length} captions are on the stage now.` +
        (warnings.length ? `\n${warnings.length} validation warning(s) — read the log.` : ''),
    );
  } catch (err) {
    log(`ERROR during alignment: ${err.message}`);
    console.error(err);
    // A failure here is the one that leaves the stage showing the *uncorrected* captions, so
    // silence is the worst answer: the panel says the alignment did not finish, and says it
    // in the same three places a failed transcription or export does.
    stateOf(
      'sources',
      'failed',
      'alignment failed',
      `The AI captions could not be corrected against the TRUTH file.\n${err.message}`,
    );
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
  // A new document brings its own frame, so the ratio lock belongs to the document that set it — and
  // if a picture is already loaded, the picture is still what decides the pixel size.
  aspectLocked = false;
  if (adoptSourceCanvas(doc)) log(`frame: adopted the picture’s ${doc.canvas.width}×${doc.canvas.height}`);
  applyStageAspect();
  syncAspectSelect();
  await syncStyleControls(doc.defaults);
  refreshSeekRange();
  // The cut belongs to the document, so a document that never had one starts as the whole recording.
  // An existing cut is left exactly as it is — that is what makes a saved project reopen with its
  // edits instead of with everything put back.
  ensureTimeline(doc, { video: trackSpan('video'), audio: trackSpan('audio') });
  selectedClip = null;
  // The overlay clips come with the document, and their files do not: a project opened in a fresh
  // session shows its clips as offline until they are relinked.
  adoptMedia(doc);
  // A new document invalidates any selection from the previous one.
  selectedBlockId = doc.blocks[0]?.id ?? null;
  renderBlocks();
  renderTemplates();
  selectBlock(selectedBlockId);
  refreshExportButtons();
  syncTimeline();
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
/**
 * Republish the document, the cut and the clock to the timeline, in one place.
 *
 * Everything that can change what the strip shows — a new document, an edit, a selection, a cut, a new
 * duration — goes through here, so the timeline can never drift from the preview it is a view of.
 */
function syncTimeline() {
  if (!timeline) return;
  const doc = preview?.document;
  timeline.setDocument(doc);
  timeline.setDuration(preview?.duration() ?? 0);
  timeline.setSelected(selectedBlockId);
  timeline.setSelectedClip(selectedClip);
  refreshTimelineRanges();
  updateTimelineStatus();
}

/**
 * The source length the cut is measured against — the whole recording, cuts and all.
 *
 * This is the **programme**: the longest part that was loaded, so a full-length master under a
 * shorter picture still gets a programme as long as the master.
 */
function sourceDuration() {
  return preview?.duration() ?? 0;
}

/**
 * The length one *track* is measured against: its own media, not the programme's.
 *
 * A 161 s picture and a 182 s master are two recordings of different lengths. Measuring both cuts
 * against one number is what let the audio lane be cut at the picture's length and the captions be
 * drawn past the end of the strip; the video track's range is about the video.
 */
function trackSpan(track) {
  return preview?.trackDuration?.(track) || sourceDuration();
}

/** Republish just the cut (the kept ranges), without rebuilding the caption row. */
function refreshTimelineRanges() {
  const doc = preview?.document;
  if (!timeline) return;
  if (!doc) {
    timeline.setRanges({ video: [], audio: [] });
    timeline.setDropped([]);
    return;
  }
  timeline.setRanges({
    video: trackRanges(doc, 'video', trackSpan('video')),
    audio: trackRanges(doc, 'audio', trackSpan('audio')),
  });
  timeline.setDropped(droppedCaptionIds(doc));
}

/**
 * The tag beside the timeline: how many captions, and how much of the recording survives the cut.
 *
 * Showing both lengths is what makes a cut legible at a glance — the file is the *output* length, not
 * the source length, and a strip that only ever showed one of them would make a trim look like it did
 * nothing.
 */
function updateTimelineStatus() {
  const tag = $('#timeline-status');
  if (!tag) return;
  const doc = preview?.document;
  const count = doc?.blocks?.length ?? 0;
  if (!count) {
    tag.textContent = '—';
    return;
  }
  // The arithmetic lives in the model (and is unit-tested there); this is only the wording.
  const { outputSeconds, sourceSeconds, trimmed } = timelineSummary(doc, sourceDuration());
  tag.textContent = trimmed
    ? `${count} caption${count === 1 ? '' : 's'} · ${outputSeconds.toFixed(1)}s of ${sourceSeconds.toFixed(1)}s after the cuts`
    : `${count} caption${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// the cut — trim, split, cut left / cut right, delete
// ---------------------------------------------------------------------------

/** Are two range lists the same cut? Used to tell a real edit from a no-op. */
function sameRanges(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((range, i) => Math.abs(range.srcIn - b[i].srcIn) < 1e-6 && Math.abs(range.srcOut - b[i].srcOut) < 1e-6);
}

/** Write a new cut for one track, keeping the timeline honest about it. */
function commitCut(track, next) {
  const doc = preview?.document;
  if (!doc) return false;
  const span = trackSpan(track);
  ensureTimeline(doc, { video: trackSpan('video'), audio: trackSpan('audio') });
  if (sameRanges(trackRanges(doc, track, span), next)) return false;
  setTrackRanges(doc, track, next);
  return true;
}

/**
 * One of the timeline's edit buttons.
 *
 * `split` cuts every track at the playhead (which is what a linked clip does); the rest act on the
 * selected clip's track when one is selected and on both when nothing is, because "cut everything to
 * the left" usually means the whole programme rather than one lane of it.
 */
function onTimelineCommand(command) {
  const doc = preview?.document;
  if (!doc) return;
  // Delete means the thing that is selected, and there are two kinds of selected clip. An overlay clip
  // is a whole object in the document (so Delete removes it), a cut clip is a range of the source (so
  // Delete removes that range) — and with a picture/sound clip selected, the range is the meaning.
  if (command === 'delete' && selectedMediaClipId && !selectedClip) {
    removeClip(selectedMediaClipId);
    return;
  }
  ensureTimeline(doc, { video: trackSpan('video'), audio: trackSpan('audio') });
  const time = Math.max(0, preview?.currentTime() ?? 0);
  if (command === 'reset') {
    let changed = false;
    for (const track of TIMELINE_TRACKS) {
      const span = trackSpan(track);
      if (!sameRanges(trackRanges(doc, track, span), fullRanges(span))) {
        resetTrack(doc, track, span);
        changed = true;
      }
    }
    if (changed) log('timeline: cuts cleared — the whole recording is back');
    else log('timeline: there were no cuts to clear');
  } else {
    const tracks = selectedClip ? [selectedClip.track] : TIMELINE_TRACKS;
    // Delete is the one command that prefers the *selected* clip over the playhead, because deleting
    // the thing you just clicked is the only reading of "Delete" that is not a surprise. When nothing
    // is selected it falls back to whatever the playhead is over, so the button still does something.
    const edit = {
      split: (ranges) => splitAt(ranges, time),
      'cut-left': (ranges) => cutBefore(ranges, time),
      'cut-right': (ranges) => cutAfter(ranges, time),
      delete: (ranges) => {
        if (!selectedClip) return removeAt(ranges, time);
        const index = ranges.findIndex((range) => range.id === selectedClip.id);
        return index < 0 ? ranges : ranges.filter((_, i) => i !== index);
      },
    }[command];
    if (!edit) return;
    let changed = 0;
    for (const track of tracks) {
      if (commitCut(track, edit(trackRanges(doc, track, trackSpan(track))))) changed += 1;
    }
    const where = selectedClip ? `the ${selectedClip.track} track` : 'the video and audio tracks';
    if (!changed) {
      log(
        command === 'split'
          ? 'timeline: nothing to split — the playhead has to be inside a clip, away from its edges'
          : `timeline: nothing to ${command.replace('-', ' ')} at ${time.toFixed(2)}s`,
      );
      return;
    }
    log(`timeline: ${command.replace('-', ' ')} at ${time.toFixed(2)}s on ${where}`);
    // The selected clip may be the one that just went away.
    if (command === 'delete' && selectedClip) {
      const stillThere = (trackRanges(doc, selectedClip.track, trackSpan(selectedClip.track)) ?? []).some(
        (r) => r.id === selectedClip.id,
      );
      if (!stillThere) {
        selectedClip = null;
        timeline?.setSelectedClip(null);
      }
    }
  }

  afterCut(time);
}

/**
 * A drag on a clip's edge. Applied live, so the strip follows the pointer.
 *
 * The lane decides which *kind* of clip this is, and the two are genuinely different edits: a cut range
 * is a part of the one source file (so trimming it is a statement about what survives), while an overlay
 * clip is a file of its own placed on the programme (so trimming it is a statement about the placed
 * clip, and its head trim also advances its own in-point — see `trimMediaClip`).
 */
function onTimelineTrim(track, id, edge, seconds) {
  if (track === 'media') return onMediaClipTrim(id, edge, seconds);
  const doc = preview?.document;
  if (!doc) return;
  const span = trackSpan(track);
  ensureTimeline(doc, { video: trackSpan('video'), audio: trackSpan('audio') });
  const ranges = trackRanges(doc, track, span);
  const index = ranges.findIndex((range) => range.id === id);
  if (index < 0) return;
  commitCut(track, trimEdge(ranges, index, edge, seconds, span));
  refreshTimelineRanges();
  updateTimelineStatus();
  refreshExportButtons();
}

/** Select a picture/sound clip, so the cut commands know which one is meant. */
function onTimelineSelectClip(track, id) {
  // The Clips lane selects an overlay clip, which is not a cut range at all — and is kept in its own
  // variable so that no cut command can ever mistake one for the other.
  if (track === 'media') {
    selectedClip = null;
    timeline?.setSelectedClip(null);
    return selectMediaClip(id);
  }
  selectedClip = track && id ? { track, id } : null;
  selectedMediaClipId = null;
  timeline?.setSelectedMediaClip(null);
  renderMediaList();
  timeline?.setSelectedClip(selectedClip);
  const range = (trackRanges(preview?.document, track, trackSpan(track)) ?? []).find((r) => r.id === id);
  if (range) {
    log(
      `timeline: selected the ${track} clip ${formatSeconds(range.srcIn)}–${formatSeconds(range.srcOut)} ` +
        `(${(range.srcOut - range.srcIn).toFixed(2)}s)`,
    );
  }
}

/**
 * Settle everything after a cut.
 *
 * The one thing that is not merely a repaint: the playhead may now be sitting in a region that no
 * longer exists, and leaving it there would put the preview on a frame the programme has cut away.
 */
function afterCut(time) {
  refreshTimelineRanges();
  updateTimelineStatus();
  refreshExportButtons();
  preview?.seek(time);
  overlay?.refresh();
}

/** `12.345` as `12.35s`, for log lines. */
function formatSeconds(value) {
  return `${(Number(value) || 0).toFixed(2)}s`;
}

function renderBlocks() {
  syncTimeline();
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
  syncTimeline();
}

/**
 * What the transport reads back, once per drawn frame.
 *
 * Every write here is guarded by "has it changed?" for one reason: this runs at the display's frame
 * rate, next to a video decoder that needs the CPU more than the DOM does. An unguarded
 * `textContent =` on a node that already holds that string still invalidates style for that subtree,
 * and there are four of them plus a range input — per frame, whether or not the tenth of a second
 * they display has actually advanced.
 */
const transportReadout = { time: '', position: '', button: '' };

function onFrame(t, doc) {
  timeline?.setTime(t);
  const time = `${t.toFixed(2)}s`;
  if (transportReadout.time !== time) {
    transportReadout.time = time;
    $('#preview-time').textContent = time;
  }
  const seek = $('#seek');
  // The input is left alone while it has focus: that is the user dragging the scrub bar, and writing
  // a value into it mid-drag is what makes a scrub fight the pointer.
  if (document.activeElement !== seek) {
    const value = t.toFixed(2);
    if (seek.value !== value) seek.value = value;
  }
  const position = `${t.toFixed(2)} / ${(preview?.duration() ?? 0).toFixed(2)}`;
  if (transportReadout.position !== position) {
    transportReadout.position = position;
    $('#seek-label').textContent = position;
  }
  if (doc) {
    const button = preview.playing ? '⏸ Pause' : '▶ Play';
    if (transportReadout.button !== button) {
      transportReadout.button = button;
      $('#play-btn').textContent = button;
    }
  }
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

/**
 * Fill the global animation pickers once.
 *
 * The vocabulary lives in `render/animation.js`, so it is built here rather than typed into the
 * HTML — a new registered preset then appears in the style bar without a second edit. "Out" gets a
 * single `none` (the presets list already contains one, and duplicating it would be a puzzle).
 */
function buildAnimationControls() {
  const names = animationNames();
  const fill = (select, values) => {
    if (!select || select.options.length) return;
    select.replaceChildren(
      ...values.map((n) => {
        const o = el('option', null, n);
        o.value = n;
        return o;
      }),
    );
  };
  fill($('#anim-in'), names);
  fill($('#anim-out'), ['none', ...names.filter((n) => n !== 'none')]);
}

async function syncStyleControls(defaults) {
  const style = defaults ?? preview.document?.defaults ?? createDefaultStyle();
  if (!$('#font-family').options.length) buildFontControls(style);
  buildAnimationControls();
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
  $('#autowrap-toggle').checked = style.autoWrap !== false;
  $('#underline-draw-toggle').checked = style.emphasis?.animate !== false;
  $('#font-case').value = style.font.case ?? 'none';
  $('#fill-color').value = style.fill?.color ?? '#ffffff';
  $('#display-mode').value = DISPLAY_MODES.includes(style.display) ? style.display : 'NORMAL';
  $('#reveal-mode').value = style.reveal ?? 'progressive';
  $('#emphasis-decoration').value = style.emphasis?.decoration ?? 'none';
  $('#emphasis-source').value = style.emphasis?.source ?? 'keyword';
  $('#emphasis-color').value = toHexColor(style.emphasis?.decorationColor, '#22c55e');
  $('#emphasis-color-out').textContent = style.emphasis?.decorationColor ?? '#22c55e';
  $('#anim-in').value = style.animation?.in ?? 'none';
  $('#anim-out').value = style.animation?.out ?? 'none';
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
  $('#video-audio-toggle').addEventListener('change', (e) => {
    preview.setVideoAudioEnabled(e.target.checked);
    log(e.target.checked ? "the video's own audio is on" : "the video's own audio is muted");
  });
  $('#audio-audio-toggle').addEventListener('change', (e) => {
    preview.setPlaybackAudioEnabled(e.target.checked);
    log(e.target.checked ? 'the uploaded playback audio is on' : 'the uploaded playback audio is muted');
  });
  $('#autowrap-toggle').addEventListener('change', async (e) => {
    await editDefaults({ autoWrap: e.target.checked });
    log(
      e.target.checked
        ? 'auto-wrap on — captions wrap at the frame edge and cannot overflow'
        : 'auto-wrap off — a long line stays on one line and can leave the frame',
    );
  });
  $('#underline-draw-toggle').addEventListener('change', async (e) => {
    await editDefaults({ emphasis: { animate: e.target.checked } });
    log(
      e.target.checked
        ? 'underline draw on — the emphasis line flows to its full length as each word appears'
        : 'underline draw off — the emphasis line appears already drawn (the static parity look)',
    );
  });
  $('#volume').addEventListener('input', (e) => preview.setVolume(Number(e.target.value)));
  $('#guides-toggle').addEventListener('change', (e) => preview.setOptions({ guides: e.target.checked }));
  $('#overlay-toggle').addEventListener('change', (e) => overlay?.setEnabled(e.target.checked));
  $('#drag-all-toggle').addEventListener('change', (e) => {
    dragAllState = null;
    log(e.target.checked ? 'drag: every caption moves together' : 'drag: only the caption you grab moves');
  });

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
  // `input` rather than `change`: the palette reports the colour continuously while it is dragged,
  // so the caption behind the picker keeps up instead of jumping once the dialog is dismissed.
  $('#emphasis-color').addEventListener('input', async (e) => {
    const decorationColor = e.target.value;
    $('#emphasis-color-out').textContent = decorationColor;
    await editDefaults({ emphasis: { decorationColor } });
  });
  $('#emphasis-color').addEventListener('change', (e) => log(`emphasis colour: ${e.target.value}`));
  $('#emphasis-source').addEventListener('change', async (e) => {
    await editDefaults({ emphasis: { source: e.target.value } });
    log(
      e.target.value === 'active'
        ? 'emphasis follows the spoken word (karaoke)'
        : 'emphasis marks the AI keywords (Veed)',
    );
  });
  $('#font-case').addEventListener('change', async (e) => {
    await editDefaults({ font: { case: e.target.value } });
  });
  // `input` for the same reason as the emphasis picker: the text behind it should follow the value
  // as it is typed, not only once the field is left.
  $('#fill-color').addEventListener('input', async (e) => {
    await editDefaults({ fill: { color: e.target.value } });
  });
  $('#display-mode').addEventListener('change', async (e) => {
    await editDefaults({ display: e.target.value });
  });
  $('#anim-in').addEventListener('change', async (e) => {
    await editDefaults({ animation: { in: e.target.value } });
  });
  $('#anim-out').addEventListener('change', async (e) => {
    await editDefaults({ animation: { out: e.target.value === 'none' ? null : e.target.value } });
  });
  $('#reset-style').addEventListener('click', () => useTemplate('veed-auto-highlight'));
  $('#template-parity').addEventListener('click', () => useTemplate('veed-auto-highlight'));

  buildAspectControls();
  $('#fullscreen-btn').addEventListener('click', () => toggleFullscreen());
  // The full-screen box is the project's aspect, which lives on the stage as a custom property; the
  // button itself is outside the stage, so it is covered while the preview is on the screen and
  // there is nothing to re-label. Escape (or the browser's own gesture) is the way out.
  document.addEventListener('fullscreenchange', () => {
    const on = Boolean(document.fullscreenElement);
    applyStageAspect();
    preview.resize();
    overlay?.refresh({ force: true });
    log(on ? 'full screen preview on — Esc to leave' : 'full screen preview off');
  });

}

// ---------------------------------------------------------------------------
// the frame ratio — and the full-screen preview that shows it at full size
// ---------------------------------------------------------------------------

/**
 * The picture's own size, when one is loaded — the cap every preset is scaled to.
 * `videoWidth`/`videoHeight` are the *decoded* size, so they are the authority over anything a
 * container header claims.
 */
function sourceCanvas() {
  const video = $('#preview-video');
  return video && video.videoWidth > 0 ? { width: video.videoWidth, height: video.videoHeight } : null;
}

/**
 * Give a document the picture's own *resolution*, when it is free to do so.
 *
 * Only the pixel count, never the shape: silently changing the frame's aspect would move every
 * caption. The case this fixes is the common one where the video is loaded first and the captions
 * arrive afterwards (transcribe, align, open a project) — the new document would otherwise carry
 * whatever canvas the subtitle file mentioned and export a 1080p clip at 720p.
 *
 * @returns {boolean} whether the frame was changed
 */
function adoptSourceCanvas(doc) {
  const source = sourceCanvas();
  if (!doc?.canvas || !source) return false;
  if (doc.canvas.width === source.width && doc.canvas.height === source.height) return false;
  const sameShape = Math.abs(doc.canvas.width / doc.canvas.height - source.width / source.height) < 0.01;
  if (!sameShape) return false;
  doc.canvas = { ...doc.canvas, width: source.width, height: source.height };
  return true;
}

/**
 * Give the stage the document's aspect ratio.
 *
 * The stage's box *is* the frame as far as the eye is concerned — the caption canvas is fitted inside
 * it and the video is `object-fit: contain` within it — so they only agree when the stage is the
 * project's shape. The same number is published as `--fs-ar`, because the `:fullscreen` rule cannot
 * read the canvas size out of JavaScript.
 */
function applyStageAspect() {
  const canvas = preview?.document?.canvas ?? { width: 16, height: 9 };
  const aspect = canvas.height > 0 ? canvas.width / canvas.height : 16 / 9;
  // The stage's box in the editor. On the full screen the stage is the black *surround* instead —
  // the browser pins a full-screen element to 100% of the display, overriding any size — and the
  // frame inside it is the caption canvas, which `renderer.fit` already keeps at the project's own
  // aspect (with the video pinned to the same box by `syncVideoBox`).
  $('#stage').style.setProperty('--fs-ar', String(aspect));
}

/** Point the picker at whatever ratio the document is actually on — both of them. */
function syncAspectSelect() {
  const select = $('#aspect-select');
  if (select) select.value = presetIdFor(preview?.document?.canvas);
  // the export window has a ratio control too, and it is the same setting
  exportDialog?.syncFromContext();
}

/** The frame-ratio picker: `source` plus one entry per preset, from the registry itself. */
function buildAspectControls() {
  const select = $('#aspect-select');
  const entries = [
    { value: 'source', label: 'source — the picture’s own ratio' },
    ...Object.entries(CANVAS_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
  ];
  select.replaceChildren(
    ...entries.map(({ value, label }) => {
      const option = el('option', null, label);
      option.value = value;
      return option;
    }),
  );
  select.addEventListener('change', () => applyAspect(select.value));
}

/**
 * Switch the frame ratio.
 *
 * `source` is the odd one out: it means "stop overriding and follow the picture", so it clears the
 * lock and adopts the video's own size. Every other choice *locks* the ratio, which is what stops a
 * video arriving later from silently resetting the frame back to its own shape.
 */
async function applyAspect(id) {
  const doc = preview?.document;
  if (!doc) {
    log('frame ratio: open a document first');
    return null;
  }
  const fps = doc.canvas?.fps ?? 30;
  if (id === 'source') {
    aspectLocked = false;
    const source = sourceCanvas();
    if (source) doc.canvas = { ...doc.canvas, width: source.width, height: source.height, fps };
    else log('frame ratio: no picture is loaded, so the frame keeps its current shape');
  } else {
    const next = canvasForPreset(id, { source: sourceCanvas(), fps });
    if (!next) return null;
    aspectLocked = true;
    doc.canvas = { ...doc.canvas, ...next };
  }
  // Resizing re-fits the caption canvas; the layout engine is invalidated by `resize()` and again by
  // `redraw()`, which is cheap and removes any chance of a measurement surviving a frame change.
  applyStageAspect();
  preview.resize();
  redraw();
  updateSizeReadout();
  syncAspectSelect();
  const { width, height } = preview.document.canvas;
  log(`frame ratio: ${id === 'source' ? 'the picture’s own' : id} → ${width}×${height}`);
  return preview.document.canvas;
}

/**
 * Show the frame on the whole screen.
 *
 * The **stage** goes full-screen, not the page. Everything inside it — the video, the caption canvas,
 * the drag overlay — already knows how to re-fit itself to its container, so full-screen is a CSS
 * change plus one resize rather than a second preview to keep in sync with the first. A 9:16 frame on
 * a 16:9 monitor comes out letterboxed against the stage's black, exactly as the editor shows it.
 */
async function toggleFullscreen() {
  const stage = $('#stage');
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    if (!preview?.document) {
      log('full screen: open a document first — there is nothing to show yet');
      return false;
    }
    await stage.requestFullscreen?.();
    return true;
  } catch (err) {
    // A browser or a policy can refuse full-screen; that is a limitation to report, not a crash.
    log(`full screen unavailable here: ${err?.message ?? err}`);
    return false;
  }
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
  if (swatch.emphasis === 'underline' || swatch.emphasis === 'sweep') {
    // The sweep is a curved stroke, which a CSS swatch cannot honestly draw; a rounded border in the
    // decoration colour is the nearest thing that still reads as "this template has an emphasis".
    mark.style.borderBottom = `3px solid ${swatch.emphasisColor ?? swatch.fill}`;
    if (swatch.emphasis === 'sweep') mark.style.borderBottomLeftRadius = '8px 3px';
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
    // Auto-select the first block so the inspector is useful the moment a document appears — but never
    // while an overlay clip is selected. A clip selection is a whole object the user just picked, and
    // auto-selecting a caption under it would take the selection back off the clip that was chosen.
    if (doc?.blocks?.length && !selectedMediaClipId && !findBlock(doc, selectedBlockId)) {
      selectedBlockId = doc.blocks[0].id;
      overlay?.select(selectedBlockId);
    }
    renderBlockStatus();
    document.querySelectorAll('#blocks .row').forEach((row) => {
      row.classList.toggle('active', row.dataset.blockId === selectedBlockId);
    });
    timeline?.setSelected(selectedBlockId);
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
  syncTimeline();
}

/**
 * Apply a style edit from the inspector.
 *
 * Where it lands depends on the inspector's scope toggle: off, it is a sparse patch on the selected
 * block's overrides (the default, unchanged); on, the same patch becomes a *document* setting and
 * the matching keys are cleared from every block, so the change really does reach every caption
 * instead of being masked by an existing override. Content and position never come through here, so
 * flipping the toggle can never rewrite the words or move the captions.
 */
function applyBlockPatch(patch) {
  const doc = preview?.document;
  const block = selectedBlock();
  if (!doc || !block) return null;
  if (styleScopeAll) {
    applyStyleToAll(doc, patch);
    redraw();
    renderTemplates();
    renderBlocks();
    renderBlockStatus();
    return doc.defaults;
  }
  setBlockOverrides(doc, block.id, patch);
  redraw();
  renderBlockStatus();
  renderBlocks();
  return block.overrides;
}

/** Is "apply to all" on? Read at the moment of the move, like every other control. */
function dragAllEnabled() {
  return Boolean($('#drag-all-toggle')?.checked);
}

/**
 * Commit a position for the selected block (used by the overlay's drag/nudge callbacks).
 *
 * With "drag all captions" on, the move is applied to the *whole layout* instead: see
 * `shiftAllCaptions`. Either way the drag's own value is the only thing that decides where the
 * text goes, so the overlay never has to know which mode is on.
 */
function placeSelected(blockId, anchor, info = {}) {
  const doc = preview?.document;
  if (!doc || !blockId) return null;
  selectedBlockId = blockId;
  const block = findBlock(doc, blockId);
  if (!block) return null;
  if (dragAllEnabled()) return shiftAllCaptions(doc, blockId, block, anchor, info);
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
 * The "apply to all" variant of a drag: move every caption by the same delta.
 *
 * The delta is measured against the anchor the *dragged* block had at the start of the gesture, and
 * the dragged block's own target is clamped to the frame first — then that same, already-clamped
 * delta is handed to the whole layout. Clamping per block instead would let a caption near one edge
 * lag behind while the rest kept moving, which is exactly the relative drift a group move must not
 * introduce.
 *
 * The live preview on every pointer move is the same edit applied repeatedly; nothing is written
 * until the pointer releases, at which point the running anchor is forgotten so the next drag starts
 * from where this one left off.
 */
function shiftAllCaptions(doc, blockId, block, anchor, info) {
  const layout = (preview.layouts ?? []).find((l) => l.blockId === blockId);
  const box = layout ? { width: layout.width, height: layout.height } : null;
  const target = box ? clampAnchorToCanvas(anchor, { canvas: preview.renderer.size, box }).anchor : anchor;

  if (!dragAllState || dragAllState.blockId !== blockId) {
    const start = resolveAnchor(doc, block);
    dragAllState = { blockId, lastX: start.posX, lastY: start.posY };
  }
  const dx = target.posX - dragAllState.lastX;
  const dy = target.posY - dragAllState.lastY;
  if (dx || dy) shiftDocumentPlacements(doc, { dx, dy });
  dragAllState.lastX = target.posX;
  dragAllState.lastY = target.posY;

  if (info.live) redraw();
  else {
    dragAllState = null;
    afterBlockEdit();
  }
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

/**
 * A colour picker.
 *
 * The *shown* colour is normalised into what the input can hold (`toHexColor`) while the value
 * written back is always a plain `#rrggbb` — so picking a colour is one round trip through the
 * document, never a reformatting of a colour the user did not touch.
 */
function buildColor(value, onChange, fallback) {
  const input = el('input');
  input.type = 'color';
  input.value = toHexColor(value, fallback);
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

  // The scope switch sits directly under the header because it governs *every* appearance edit
  // below it: off (the default) edits this caption alone, on edits the whole document. It is
  // deliberately its own control — separate from the transport's "drag all captions" (that moves
  // positions) and from "Push this caption's look to all" (that folds a whole look into the
  // document in one go). Content and position are never routed through it, so it can only ever
  // change how the captions *look*.
  const scopeToggle = el('input');
  scopeToggle.type = 'checkbox';
  scopeToggle.id = 'style-all-toggle';
  scopeToggle.checked = styleScopeAll;
  scopeToggle.addEventListener('change', () => {
    styleScopeAll = scopeToggle.checked;
    log(
      styleScopeAll
        ? 'style scope: every caption — edits below now change the document'
        : 'style scope: only the selected caption',
    );
  });
  const scopeRow = el('label', 'scope-row');
  scopeRow.append(scopeToggle, document.createTextNode(' Apply style edits to every caption'));
  scopeRow.title =
    'While checked, appearance edits in this panel change every caption, not just the selected one';
  host.append(scopeRow);

  const grid = el('div', 'inspector-grid');
  const weights = getFont(style.font.family)?.weights ?? [style.font.weight];
  // Section headings are grid rows: they span the full width and leave the responsive column count
  // of the fields beneath them untouched, so the panel reads top-to-bottom as Content → Placement →
  // Look → Animation instead of one undifferentiated slab of controls.
  const sectionHead = (title) => el('div', 'inspector-section', title);

  // The content edit sits first and spans the grid: it is the reason most people open this panel.
  const textInput = buildText(block.text, (v) => onBlockText(v), {
    placeholder: 'the caption exactly as it should read',
  });
  textInput.id = 'block-text-input';
  const textField = fieldInline('Caption text', textInput);
  textField.classList.add('field-wide');

  grid.append(
    sectionHead('Content'),
    textField,
    fieldInline(
      'Block',
      buildSelect(
        doc.blocks.map((b, i) => ({ value: b.id, label: `${i + 1}. ${b.text.slice(0, 28)}` })),
        block.id,
        (id) => selectBlock(id),
      ),
    ),
    sectionHead('Placement'),
    fieldInline(
      'Position',
      buildSelect(
        [{ value: 'inherit', label: 'inherit (document default)' }, ...PRESET_IDS, { value: 'custom', label: 'custom (dragged)' }],
        block.placement ? (presetFor(block.placement) ?? 'custom') : 'inherit',
        (id) => (id === 'custom' ? null : applyAnchorPreset(id)),
      ),
    ),
    sectionHead('Look'),
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
    fieldInline(
      'Emphasis',
      buildSelect(['underline', 'sweep', 'highlight', 'none'], style.emphasis?.decoration ?? 'none', (v) =>
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
      buildColor(style.emphasis?.decorationColor, (v) => applyBlockPatch({ emphasis: { decorationColor: v } })),
    ),
    sectionHead('Animation'),
    fieldInline('Reveal', buildSelect(REVEAL_MODES, style.reveal, (v) => applyBlockPatch({ reveal: v }))),
    fieldInline(
      'Animation in',
      buildSelect(animationNames(), style.animation?.in ?? 'none', (v) => applyBlockPatch({ animation: { in: v } })),
    ),
    fieldInline(
      'Animation out',
      buildSelect(['none', ...animationNames().filter((n) => n !== 'none')], style.animation?.out ?? 'none', (v) =>
        applyBlockPatch({ animation: { out: v === 'none' ? null : v } }),
      ),
    ),
  );
  host.append(grid);

  const words = el('div', 'word-list');
  words.id = 'word-editor';
  host.append(words);
  renderWordEditor();
  host.append(
    el(
      'div',
      'hint',
      '✂ between two words splits the caption there — every word keeps its own timing, and each line then reveals on its own.',
    ),
  );

  // One row for edits that change the *shape* of the document (how many captions there are),
  // one for the edits that change how the selected one looks. The shape row gets its own class
  // rather than sharing `.actions`, so "the buttons that edit the look" stays a single, nameable
  // group — position in a list is not an identity.
  const structure = el('div', 'shape-actions');
  const splitPlayhead = el('button', 'ghost', 'Split at playhead');
  splitPlayhead.id = 'split-at-playhead';
  splitPlayhead.title = 'Split this caption in two at the word boundary nearest the playhead';
  splitPlayhead.addEventListener('click', () => splitSelected('playhead'));
  const joinPrevious = el('button', 'ghost', 'Join with previous');
  joinPrevious.id = 'join-previous';
  joinPrevious.title = 'Merge this caption back into the one before it';
  // Nothing precedes the first caption, so the inverse of a split is not available on it.
  joinPrevious.disabled = doc.blocks[0] === block;
  joinPrevious.addEventListener('click', () => joinSelected());
  structure.append(splitPlayhead, joinPrevious);
  host.append(structure);

  const actions = el('div', 'actions');
  const applyAll = el('button', 'ghost', "Push this caption's look to all");
  applyAll.id = 'apply-to-all';
  applyAll.title =
    'Fold this caption\'s whole look and position into the document and clear its overrides, so every caption matches it';
  applyAll.addEventListener('click', () => {
    promoteBlockToDocument(doc, block.id);
    afterBlockEdit();
    renderTemplates();
    log('promoted this block\'s look (and position) to every caption');
  });
  const resetBlock = el('button', 'ghost', 'Reset this block');
  resetBlock.id = 'reset-block';
  resetBlock.addEventListener('click', () => {
    clearBlockOverrides(doc, block.id);
    afterBlockEdit();
    log('block reset — it inherits the document style and position again');
  });
  const resetPosition = el('button', 'ghost', 'Reset position');
  resetPosition.id = 'reset-position';
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
    // A split handle after every word but the last: a click can only mean "break the caption here".
    if (i < block.words.length - 1) {
      const split = el('button', 'word-split', '✂');
      split.dataset.splitAt = String(i + 1);
      split.title = `Split here — “${w.text}” keeps ${fmt(w.start)}–${fmt(w.end)}`;
      split.setAttribute('aria-label', `Split the caption after “${w.text}”`);
      split.addEventListener('click', () => splitSelected(i + 1));
      host.append(split);
    }
  });
}

/**
 * Split the selected caption in two — at a word boundary (`at` = the first word of the new block)
 * or at the playhead.
 *
 * The two things it does *after* the edit are the point of it being in one place rather than inline
 * in the handlers:
 *
 * - `selectAfterShapeEdit` — one more caption exists, so the picker list has to be rebuilt and the
 *   overlay has to be told which half is now selected.
 * - the **remainder** becomes the selection. Carving one long line into three is the normal use, and
 *   this leaves the next split one click away instead of one click plus a row pick.
 */
function splitSelected(at) {
  const doc = preview?.document;
  const block = selectedBlock();
  if (!doc || !block) return null;
  const parts =
    at === 'playhead' ? splitBlockAtTime(doc, block.id, preview.currentTime()) : splitBlock(doc, block.id, at);
  if (!parts) {
    if (at === 'playhead') log('nothing to split — the playhead has to be inside a caption of more than one word');
    return null;
  }
  selectAfterShapeEdit(parts.second.id);
  log(`split caption at ${parts.cut.toFixed(2)}s → "${parts.first.text}" | "${parts.second.text}"`);
  return parts;
}

/** Merge the selected caption back into the one before it (undo a split). */
function joinSelected() {
  const doc = preview?.document;
  const block = selectedBlock();
  if (!doc || !block) return null;
  const merged = joinBlockWithPrevious(doc, block.id);
  if (!merged) {
    log('this is the first caption — there is nothing before it to join with');
    return null;
  }
  selectAfterShapeEdit(merged.id);
  log(`joined with the previous caption → "${merged.text}"`);
  return merged;
}

/**
 * Finish a split or a join: move the selection to the surviving caption and refresh every view.
 *
 * This is an `afterBlockEdit`, not the `selectBlock` shortcut, because the *number* of captions
 * changed — the picker list has to be rebuilt, not merely re-highlighted. The overlay is told
 * separately: it keeps its own selection for hit-testing and dragging, and left alone it would go
 * on outlining the half the user did not ask for.
 */
function selectAfterShapeEdit(id) {
  selectedBlockId = id ?? null;
  // redraw first: `afterBlockEdit` repaints the overlay from the layouts of the last frame, so a
  // selection drawn before the new caption has been laid out would outline the wrong box.
  afterBlockEdit();
  overlay?.select(selectedBlockId);
}

/**
 * The sidebar's tabs: Sources / Transcribe / Export, one visible at a time.
 *
 * They are three workflows you do in sequence but never simultaneously, and as three columns each got
 * a third of the width and its own height — the "vertical" arrangement this replaces. The panels are
 * all present in the DOM (so every control keeps its state and every test can still reach it); only
 * `hidden` moves.
 */
function wireTabs() {
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  if (!tabs.length) return null;
  const panels = new Map(tabs.map((tab) => [tab.dataset.tab, $(`#tab-${tab.dataset.tab}`)]));
  const select = (name) => {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const [key, panel] of panels) if (panel) panel.hidden = key !== name;
    // A panel that was hidden had no width, so anything that measures itself has to be told to look
    // again; the export window reads the project's ratio, which never changed but may never have
    // been read either.
    if (name === 'export') exportDialog?.syncFromContext();
  };
  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.tab));
  select(tabs[0].dataset.tab ?? 'sources');
  return select;
}

/** Build the overlay once a document exists — it needs the renderer's size and layouts. */
function createOverlay() {
  if (overlay) return overlay;
  overlay = createCanvasOverlay({
    canvas: $('#preview-canvas'),
    overlay: $('#overlay-canvas'),
    preview,
    // The clips to hit-test and draw handles for, the size of each clip's own file (for a shape-locked
    // resize), the panel's shape lock and its crop mode — all read live, because the overlay outlives any
    // of them, and a mode read once at construction would be a mode that stops working after a reload.
    getClips: () => mediaClips(preview?.document),
    clipSize: (id) => mediaLibrary.size(id),
    keepAspect: () => clipShapeLocked(),
    cropMode: () => clipCropMode(),
    onSelect: (id) => {
      selectedBlockId = id ?? null;
      updateSelectionUI();
    },
    onPlace: (blockId, anchor, info) => placeSelected(blockId, anchor, info),
    // A selection made *in the preview*: the clip's own callbacks publish it, so the lane, the list and
    // the transform panel all follow the click that made it. Nothing is re-entered here — `selectClip`
    // on the overlay is only called by the other two ways in, so a click cannot loop back through it.
    onClipSelect: (id) => {
      selectedMediaClipId = id ?? null;
      if (selectedMediaClipId) {
        selectedClip = null;
        timeline?.setSelectedClip(null);
      }
      timeline?.setSelectedMediaClip(selectedMediaClipId);
      renderMediaList();
      renderClipInspector();
    },
    onClipBox: (id, box, info) => onClipBox(id, box, info),
    onClipRotate: (id, degrees, info) => onClipRotation(id, degrees, info),
    onClipCrop: (id, crop, info) => onClipCrop(id, crop, info),
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
  // The overlay clips are drawn on their own canvas, between the picture and the captions.
  mediaCanvas: $('#media-canvas'),
  onFrame,
});

createOverlay();
wireClipInspector();

timeline = createTimeline({
  container: $('#timeline'),
  onSeek: (t) => {
    preview?.seek(t);
    overlay?.refresh();
  },
  onSelectBlock: (id) => {
    selectBlock(id);
    const block = findBlock(preview?.document, id);
    if (block) preview?.seek(block.start + 0.01);
  },
  onSelectClip: (track, id) => onTimelineSelectClip(track, id),
  onTrim: (track, id, edge, seconds) => onTimelineTrim(track, id, edge, seconds),
  onMoveClip: (id, start) => onMediaClipMove(id, start),
  onCommand: (command) => onTimelineCommand(command),
});
syncTimeline();

exportDialog = createExportDialog({
  getContext: exportContext,
  onExport: (settings) => runExport(settings),
  onCancel: () => stopExport(),
  // The dialog's ratio is the *project's* ratio, not a second opinion: choosing it here moves the
  // preview's frame too, and the preview's picker moves this one.
  onRatioChange: (id) => applyAspect(id),
});
document.body.append(exportDialog.element);
wireTabs();

$('#video-in').addEventListener('change', (e) => onVideo(e.target.files?.[0]));
$('#audio-in').addEventListener('change', (e) => onAudio(e.target.files?.[0]));
// `multiple`, because a set of lower-thirds or logos is normally added in one go — and each one is
// placed at the playhead, where the user can see it before the next.
$('#media-in').addEventListener('change', (e) => onMediaFiles(e.target.files));

// A file that the browser cannot play used to fail in complete silence: the element simply never
// fired `loadedmetadata`, so the stage stayed black, no caption appeared and nothing said why. These
// two listeners are the whole difference between that and a sentence naming the file.
for (const [id, label] of [['#preview-video', 'video'], ['#preview-audio', 'audio']]) {
  $(id).addEventListener('error', () => {
    const element = $(id);
    const detail = describeMediaError(element.error);
    log(`ERROR ${label}: ${detail}`);
    stateOf('sources', 'failed', `${label} failed`, `The ${label} could not be loaded — ${detail}`);
    $(label === 'video' ? '#video-note' : '#audio-note').textContent = `failed: ${detail}`;
  });
}
$('#ai-in').addEventListener('change', (e) => onAi(e.target.files?.[0]));
$('#truth-in').addEventListener('change', (e) => onTruth(e.target.files?.[0]));
$('#align-btn').addEventListener('click', runAlignment);

$('#transcribe-in').addEventListener('change', refreshTranscribeButton);
$('#lyrics-in').addEventListener('change', () => {
  const file = $('#lyrics-in').files?.[0];
  log(file ? `lyrics: "${file.name}" will be sent with the next transcription` : 'lyrics: cleared');
  setTranscribeNote(
    file
      ? `the original lyrics come from "${file.name}" — the text is the file's, the timing is the audio's`
      : "no lyrics file: the transcript's own text is used as-is",
  );
});
// Pasted words and a chosen file are two ways to say the same thing, so saying one withdraws the
// other rather than leaving the studio to guess which was meant.
$('#lyrics-text').addEventListener('input', () => {
  const typed = $('#lyrics-text').value.trim();
  if (typed && $('#lyrics-in').files?.length) {
    $('#lyrics-in').value = '';
    log('lyrics: the pasted words replace the chosen file');
  }
  setTranscribeNote(typed ? 'using the pasted lyrics — the text is theirs, the timing is the audio\'s' : 'no reference lyrics: the transcript\'s own text is used as-is');
});
$('#transcribe-btn').addEventListener('click', onTranscribe);
$('#transcribe-probe').addEventListener('click', onTranscribeProbe);
// The model behind the preset is worth re-reading whenever the preset changes: which file runs is the
// thing a person is actually choosing here.
$('#transcribe-preset').addEventListener('change', refreshModelNote);
$('#proxy-build').addEventListener('click', onBuildProxy);
$('#proxy-clear').addEventListener('click', onClearProxy);
buildProxySizeSelect();
refreshProxyControls();
$('#runs-refresh').addEventListener('click', () => refreshRuns());
$('#runs-open').addEventListener('click', onOpenRun);
$('#runs-select').addEventListener('change', (e) => {
  $('#runs-open').disabled = !e.target.value;
});
refreshTranscribeButton();

$('#download-video').addEventListener('click', openExportDialog);
$('#download-project').addEventListener('click', () => onDownloadFile('.caproj'));
$('#download-veed').addEventListener('click', () => onDownloadFile('.veed.json'));
$('#download-srt').addEventListener('click', () => onDownloadFile('.srt'));
$('#download-vtt').addEventListener('click', () => onDownloadFile('.vtt'));
refreshExportButtons();

wirePreview();
applyStageAspect();
syncStyleControls(createDefaultStyle());
renderTemplates();
log('ready — load an AI source and a TRUTH subtitle file, or click "Demo document"');
log('tip: add the original Audio (optional) to hear the preview play, even with no video');
log('tip: click a caption to select it, drag it to move, arrow keys to nudge (shift = ×4)');
