/**
 * editor/timeline.js — the timeline strip, in the shape a video editor uses.
 *
 * A ruler, four lanes laid out along the source clock, and a playhead:
 *
 *   * **Captions** — the document's blocks, where they appear;
 *   * **Clips** — the overlay clips (`doc.media`), each in its own window;
 *   * **Video** — the parts of the picture that are kept;
 *   * **Audio** — the parts of the track that are kept.
 *
 * All four share **one** clock — the source's own — and that is the central decision. The timeline is
 * a view of the *same* clock the captions were timed against, so a caption can never be drawn over
 * the wrong frame: a cut is a gap in a track, not a change to when things happen (see
 * `model/timeline.js` for why).
 *
 * It is plain DOM rather than a canvas on purpose. A canvas would need a manual redraw on every
 * transport tick and would lose text selection, hover and accessibility for free; a few absolutely
 * positioned boxes cost nothing at this count and the browser re-lays them out itself.
 *
 * The time-to-pixels mapping is one number — `pxPerSecond` — so zooming is a single multiplication
 * and every element (ticks, clips, playhead) stays consistent without renegotiating.
 *
 * What it is *not* is a second source of truth. The ranges come in through `setRanges`, the clips
 * through `setMediaClips`, the playhead is driven by the preview's clock, and every edit goes straight
 * back out as a callback (`onTrim`, `onMoveClip`, `onCommand`, `onSelectClip`) for the editor to apply
 * to the document. Nothing here mutates a document.
 *
 * The two kinds of clip are deliberately **not** the same thing. A cut range is a part of the one
 * source file, so it can only ever be trimmed (its position is a fact about the file). An overlay clip
 * is a separate file placed on the programme, so it can be *moved* as well — and it is, by dragging its
 * body, which is the only gesture a person would try first.
 */

const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_PPS = 3;
const MAX_PPS = 600;

/** One press of `+` / `−`, and how far in it is allowed to go. */
const ZOOM_STEP = 1.7;
const MAX_ZOOM = 50;

/** A clip is never drawn thinner than this, however short it is. */
const MIN_CLIP_PX = 3;

/** How much one wheel notch zooms, when the wheel is used to zoom. */
const WHEEL_ZOOM = 1.16;

/** Row geometry, in one place so the CSS and the hit-testing cannot disagree. */
const RULER_H = 22;
const ROW_TOP = { captions: RULER_H + 2, media: RULER_H + 36, video: RULER_H + 66, audio: RULER_H + 100 };
const ROW_H = { captions: 32, media: 28, video: 32, audio: 26 };
const INNER_H = ROW_TOP.audio + ROW_H.audio + 6;

/** How close (in pixels) a drag has to come to the playhead or to zero before it snaps. */
const SNAP_PX = 7;

/** The lanes whose clips are *parts of one file* — trimmed, never moved. */
const TRACKS = ['video', 'audio'];
/** The lane of overlay clips — separate files, so they move as well as trim. */
const MEDIA_TRACK = 'media';
const ROW_LABEL = { captions: 'Captions', media: 'Clips', video: 'Video', audio: 'Audio' };

/** `12.34` seconds as `0:12.3` (or `1:02:03.4` past an hour). Pure. */
export function formatClock(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const whole = secs.toFixed(1).padStart(4, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${whole}` : `${minutes}:${whole}`;
}

/** The ruler tick spacing (seconds) that keeps ticks at least `minPx` apart. Pure. */
export function tickStep(pxPerSecond, minPx = 72) {
  for (const step of TICK_STEPS) {
    if (step * pxPerSecond >= minPx) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * A caption's span, clipped to the recording it belongs to. **Pure.**
 *
 * A caption cannot outlive the audio it was timed against, so one that claims to is not drawn over
 * the end of the strip: it is drawn up to the limit, and flagged. The flag is the point — silently
 * shortening the clip would hide a real timing fault (a transcript aligned against the wrong file,
 * or a document from a longer cut of the same song), and hiding it is how it survives to the export.
 *
 * `outside` is the harder case: a caption that begins *after* the recording ends has no honest
 * position at all, so it is pinned to the limit as a marker rather than being placed where there is
 * no material.
 *
 * @returns {{start:number, end:number, beyond:boolean, outside:boolean}}
 */
export function captionSpan(block, sourceEnd) {
  const rawStart = Math.max(0, Number(block?.start) || 0);
  const rawEnd = Math.max(rawStart, Number(block?.end) || 0);
  const limit = Number(sourceEnd) > 0 ? Number(sourceEnd) : Infinity;
  const start = Math.min(rawStart, limit);
  const end = Math.min(Math.max(rawEnd, start), limit);
  return {
    start,
    end,
    beyond: rawEnd > limit + 1e-3,
    outside: rawStart >= limit - 1e-3,
  };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container        the host element the strip is built into
 * @param {(seconds:number)=>void} [options.onSeek]
 * @param {(blockId:string)=>void} [options.onSelectBlock]
 * @param {(track:string, id:string)=>void} [options.onSelectClip]
 * @param {(track:string, id:string, edge:'in'|'out', seconds:number)=>void} [options.onTrim]
 * @param {(id:string, seconds:number)=>void} [options.onMoveClip]  an overlay clip dragged to a new start
 * @param {(command:string)=>void} [options.onCommand]  `split` | `cut-left` | `cut-right` | `delete` | `reset`
 * @param {(ranges:object)=>void} [options.onRanges]    a finished drag, as whole range lists
 */
export function createTimeline({
  container,
  onSeek = null,
  onSelectBlock = null,
  onSelectClip = null,
  onTrim = null,
  onMoveClip = null,
  onCommand = null,
} = {}) {
  if (!container) throw new Error('createTimeline(): a container element is required');

  container.replaceChildren();
  const toolbar = el('div', 'timeline-toolbar');
  const clock = el('span', 'timeline-clock mono', '0:00.0 / 0:00.0');
  const editGroup = el('span', 'timeline-actions');
  const button = (label, command, title) => {
    const node = el('button', 'ghost', label);
    node.title = title;
    node.dataset.command = command;
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      onCommand?.(command);
    });
    return node;
  };
  const splitBtn = button('Split', 'split', 'Split the video and audio tracks at the playhead');
  const cutLeftBtn = button('Cut left', 'cut-left', 'Remove everything to the left of the playhead');
  const cutRightBtn = button('Cut right', 'cut-right', 'Remove everything to the right of the playhead');
  const deleteBtn = button('Delete', 'delete', 'Remove the selected clip');
  const resetBtn = button('Reset cuts', 'reset', 'Put the whole recording back');
  editGroup.append(splitBtn, cutLeftBtn, cutRightBtn, deleteBtn, resetBtn);
  const spacer = el('span', 'spacer');
  const zoomOut = el('button', 'ghost', '−');
  zoomOut.title = 'Zoom out (−) · wheel over the strip, or ctrl+wheel';
  const zoomIn = el('button', 'ghost', '+');
  zoomIn.title = 'Zoom in (+) · wheel over the strip, or ctrl+wheel';
  const zoomFit = el('button', 'ghost', 'Fit');
  zoomFit.title = 'Fit the whole recording in view (F)';
  const zoomReadout = el('span', 'timeline-zoom mono', '100%');
  zoomReadout.title = 'How much of the recording is in view';
  toolbar.append(clock, editGroup, spacer, zoomOut, zoomReadout, zoomIn, zoomFit);

  const scroll = el('div', 'timeline-scroll');
  const inner = el('div', 'timeline-inner');
  const ruler = el('div', 'timeline-ruler');
  const rows = {
    captions: el('div', 'timeline-track captions'),
    media: el('div', 'timeline-track media'),
    video: el('div', 'timeline-track video'),
    audio: el('div', 'timeline-track audio'),
  };
  for (const [track, row] of Object.entries(rows)) {
    row.style.top = `${ROW_TOP[track]}px`;
    row.style.height = `${ROW_H[track]}px`;
    const label = el('span', 'timeline-row-label', ROW_LABEL[track]);
    label.style.top = `${ROW_TOP[track]}px`;
    label.style.height = `${ROW_H[track]}px`;
    row.append(label);
  }
  const playhead = el('div', 'timeline-playhead');
  // Where the recording stops. Without it the strip runs to its own right-hand edge and the two are
  // only the same thing at zoom 1, so "the captions go past the end" was impossible to see.
  const endMark = el('div', 'timeline-end');
  endMark.title = 'End of the recording';
  const empty = el('div', 'timeline-empty', 'No captions yet — load a source or open the demo.');
  inner.append(ruler, rows.captions, rows.media, rows.video, rows.audio, endMark, playhead);
  inner.style.height = `${INNER_H}px`;
  scroll.append(inner, empty);
  container.append(toolbar, scroll);

  let doc = null;
  let duration = 0;
  let time = 0;
  let selectedId = null;
  let selectedClip = null; // { track, id }
  let ranges = { video: [], audio: [] };
  let dropped = new Set();
  let mediaClips = [];
  let selectedMediaId = null;
  let offlineMedia = new Set();
  let zoom = 1;
  // Re-entrancy guard for `layout()`: it writes the strip's width, and a width change is itself a
  // resize event on some browsers, so without this the observer can call back into the layout that
  // is still running and the strip loses its scroll position (or loops).
  let layingOut = false;

  // The viewport width is *measured*, never read per frame.
  //
  // `scroll.clientWidth` is a layout read: it forces the browser to settle any pending style and
  // layout work before it can answer. Reading it from `setTime` meant one forced synchronous layout
  // per animation frame for the whole time the transport was playing — on top of the video decode,
  // which is where the CPU was actually needed. It changes when the element is resized, and that is
  // the only time it is re-read.
  let viewportWidth = 640;
  const measureViewport = () => {
    viewportWidth = Math.max(120, scroll.clientWidth || 640);
    return viewportWidth;
  };
  const viewWidth = () => viewportWidth;

  // ...and the scroll position is tracked rather than asked for, for the same reason: `scrollLeft` is
  // a layout-dependent read in a browser that has work queued. It is kept up to date from the scroll
  // event (the user dragging the bar or using the wheel) and from the one place this module scrolls.
  let scrolledTo = 0;
  const setScrollLeft = (value) => {
    const next = Math.max(0, value);
    scrolledTo = next;
    if (scroll.scrollLeft !== next) scroll.scrollLeft = next;
  };
  scroll.addEventListener('scroll', () => {
    scrolledTo = scroll.scrollLeft;
  }, { passive: true });
  /** Pixels per second at a given zoom level, with the fit and the clamps applied. */
  const pxPerSecondFor = (level) => {
    if (duration <= 0) return MIN_PPS;
    const base = Math.min(MAX_PPS, Math.max(MIN_PPS, viewWidth() / duration));
    return Math.min(MAX_PPS, Math.max(MIN_PPS, base * level));
  };
  const pxPerSecond = () => pxPerSecondFor(zoom);

  /** Nearest range to a time, and which edge a point is closest to. */
  function hitSegment(track, t) {
    for (const range of ranges[track] ?? []) {
      if (t >= range.srcIn && t < range.srcOut) return range;
    }
    return null;
  }

  function renderRuler(pps, innerWidth) {
    ruler.replaceChildren();
    const step = tickStep(pps);
    const minor = step / 5;
    // A minor tick every fifth of a major one: enough orientation without the ruler turning into a
    // grey band at high zoom.
    for (let t = 0; t <= duration + 1e-6; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      const tick = el('div', major ? 'timeline-tick major' : 'timeline-tick');
      tick.style.left = `${t * pps}px`;
      if (major) tick.append(el('span', 'timeline-tick-label', formatClock(t)));
      ruler.append(tick);
    }
    ruler.style.width = `${innerWidth}px`;
  }

  function renderCaptions(pps) {
    rows.captions.replaceChildren();
    for (const block of doc?.blocks ?? []) {
      const span = captionSpan(block, duration);
      const width = Math.max(MIN_CLIP_PX, (span.end - span.start) * pps);
      const clip = el('button', 'timeline-clip');
      clip.style.left = `${span.start * pps}px`;
      clip.style.width = `${width}px`;
      clip.style.height = `${ROW_H.captions}px`;
      clip.dataset.blockId = block.id;
      clip.title =
        `${formatClock(block.start)} – ${formatClock(block.end)}  ${block.text ?? ''}` +
        (span.beyond
          ? `\n⚠ this caption ends ${(Number(block.end) - duration).toFixed(2)}s after the recording does`
          : '');
      clip.append(el('span', 'timeline-clip-text', block.text ?? ''));
      if (block.id === selectedId) clip.classList.add('active');
      // A caption the cut removed is still shown — it is how you see what you cut away — but it is
      // dimmed, and the export will not draw it.
      if (dropped.has(block.id)) clip.classList.add('dropped');
      // A caption that outlives the recording is drawn up to the end and marked, never past it: the
      // strip's own length is the truth about the material, so the clip has to be too.
      if (span.beyond) clip.classList.add('beyond');
      if (span.outside) clip.classList.add('outside');
      clip.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectBlock?.(block.id);
      });
      rows.captions.append(clip);
    }
  }

  function renderTrackSegments(track, pps) {
    const row = rows[track];
    row.replaceChildren(row.querySelector('.timeline-row-label') ?? el('span', 'timeline-row-label', ROW_LABEL[track]));
    for (const range of ranges[track] ?? []) {
      const segment = el('div', 'timeline-segment');
      segment.style.left = `${range.srcIn * pps}px`;
      segment.style.width = `${Math.max(2, (range.srcOut - range.srcIn) * pps)}px`;
      segment.style.height = `${ROW_H[track] - 8}px`;
      segment.dataset.track = track;
      segment.dataset.clipId = range.id;
      segment.title = `${ROW_LABEL[track]} ${formatClock(range.srcIn)} – ${formatClock(range.srcOut)}  (${(range.srcOut - range.srcIn).toFixed(2)}s)`;
      if (selectedClip?.track === track && selectedClip?.id === range.id) segment.classList.add('active');
      for (const edge of ['in', 'out']) {
        const handle = el('span', `timeline-handle ${edge === 'in' ? 'left' : 'right'}`);
        handle.dataset.edge = edge;
        handle.title = edge === 'in' ? 'Drag to trim the start' : 'Drag to trim the end';
        segment.append(handle);
      }
      segment.append(el('span', 'timeline-segment-text', `${(range.srcOut - range.srcIn).toFixed(2)}s`));
      // Selecting is a *click*, not a pointerdown: a pointerdown that turns into a drag is a trim, and
      // a clip that re-selected itself halfway through a drag would be unusable.
      segment.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectClip?.(track, range.id);
      });
      row.append(segment);
    }
    row.style.width = `${inner.style.width || '100%'}`;
  }

  /**
   * The overlay-clip lane.
   *
   * A clip is drawn from its own window on the source clock, exactly like a caption — sharing the ruler
   * is what makes "this logo sits under that caption" something you can *see* rather than work out. The
   * two trim handles are at its edges, and its body drags it along the clock (see the pointer handlers),
   * which is the difference between this lane and the video/audio ones.
   */
  function renderMediaClips(pps) {
    const row = rows.media;
    row.replaceChildren(row.querySelector('.timeline-row-label') ?? el('span', 'timeline-row-label', ROW_LABEL.media));
    for (const clip of mediaClips) {
      const node = el('div', 'timeline-media-clip');
      node.style.left = `${clip.start * pps}px`;
      node.style.width = `${Math.max(MIN_CLIP_PX, (clip.end - clip.start) * pps)}px`;
      node.style.height = `${ROW_H.media - 6}px`;
      node.dataset.clipId = clip.id;
      node.dataset.kind = clip.kind;
      node.title =
        `${clip.name} — ${clip.kind}, ${formatClock(clip.start)} – ${formatClock(clip.end)}\n` +
        'drag to move it in time · drag an edge to trim it';
      if (clip.id === selectedMediaId) node.classList.add('active');
      // The file behind the clip has not been loaded (a project reopened without its media, or one that
      // failed to decode). Drawn dimmed and marked, because a clip that is in the programme is a fact
      // about the programme — the missing bytes are a fact about *this* session.
      if (offlineMedia.has(clip.id)) node.classList.add('offline');
      for (const edge of ['in', 'out']) {
        const handle = el('span', `timeline-handle timeline-media-handle ${edge === 'in' ? 'left' : 'right'}`);
        handle.dataset.edge = edge;
        handle.title = edge === 'in' ? 'Drag to trim the start of the clip' : 'Drag to trim the end of the clip';
        node.append(handle);
      }
      node.append(el('span', 'timeline-clip-text', clip.name));
      // Selecting is a click, like the cut clips: a pointerdown that turns into a move is a drag.
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectClip?.(MEDIA_TRACK, clip.id);
      });
      row.append(node);
    }
    row.style.width = `${inner.style.width || '100%'}`;
  }

  function layout() {
    if (layingOut) return;
    layingOut = true;
    try {
      // The scroll position is the user's, not this function's: a relayout (a zoom, a new clip, a
      // resize) must not silently throw the strip back to the start.
      const keepLeft = scrolledTo;
      measureViewport();
      const pps = pxPerSecond();
      const innerWidth = Math.max(viewWidth(), duration * pps);
      inner.style.width = `${innerWidth}px`;
      renderRuler(pps, innerWidth);
      renderCaptions(pps);
      renderMediaClips(pps);
      for (const track of TRACKS) renderTrackSegments(track, pps);
      endMark.style.left = `${duration * pps}px`;
      endMark.hidden = !(duration > 0);
      positionPlayhead();
      empty.hidden = Boolean(doc?.blocks?.length);
      updateZoomReadout();
      updateButtons();
      setScrollLeft(keepLeft);
    } finally {
      layingOut = false;
    }
  }

  /** The zoom level, as the percentage of the recording that is on screen. */
  function updateZoomReadout() {
    zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
    zoomOut.disabled = zoom <= 1 + 1e-6;
    zoomFit.classList.toggle('active', zoom <= 1 + 1e-6);
  }

  /**
   * Zoom about a point, so the frame under the pointer stays under the pointer.
   *
   * Zooming about the *centre* is the version that feels broken: the material you were looking at
   * slides off to one side at every notch, and finding it again is a hunt. This keeps it still.
   */
  function zoomBy(factor, anchorX = null) {
    const previous = zoom;
    zoom = Math.min(MAX_ZOOM, Math.max(1, zoom * factor));
    if (Math.abs(zoom - previous) < 1e-9) return;
    const ppsBefore = pxPerSecondFor(previous);
    const pointer = anchorX == null ? viewWidth() / 2 : anchorX;
    const secondUnderPointer = (scrolledTo + pointer) / ppsBefore;
    layout();
    setScrollLeft(secondUnderPointer * pxPerSecond() - pointer);
  }

  /**
   * Move the playhead's line and its clock.
   *
   * Both writes are skipped when the value has not changed: this runs once per animation frame while
   * the transport plays, and setting a style property or writing a text node that already holds that
   * value invalidates style for the subtree — for a strip with a ruler and three lanes of clips, that
   * is real work per frame spent on nothing.
   */
  function positionPlayhead() {
    const left = `${Math.max(0, time) * pxPerSecond()}px`;
    if (playhead.style.left !== left) playhead.style.left = left;
    const text = `${formatClock(time)} / ${formatClock(duration)}`;
    if (clock.textContent !== text) clock.textContent = text;
  }

  function updateButtons() {
    const inside = TRACKS.some((track) => {
      const range = hitSegment(track, time);
      return range && time - range.srcIn > 0.05 && range.srcOut - time > 0.05;
    });
    const anyCut = TRACKS.some((track) => {
      const list = ranges[track] ?? [];
      return list.length !== 1 || Math.abs(list[0].srcIn) > 1e-6 || Math.abs(list[0].srcOut - duration) > 1e-6;
    });
    // `disabled = false` on a button that is already enabled is not free on a strip this size.
    set(splitBtn, !inside);
    set(cutLeftBtn, !TRACKS.some((track) => (ranges[track] ?? []).some((r) => r.srcIn < time - 0.05)));
    set(cutRightBtn, !TRACKS.some((track) => (ranges[track] ?? []).some((r) => r.srcOut > time + 0.05)));
    set(deleteBtn, !selectedClip && !selectedMediaId && !TRACKS.some((track) => hitSegment(track, time)));
    set(resetBtn, !anyCut);
  }

  /** Assign `disabled` only when it differs. */
  function set(button, disabled) {
    if (button.disabled !== disabled) button.disabled = disabled;
  }

  /**
   * Keep the playhead on screen while the transport runs.
   *
   * Two rules, both about not fighting the hand that is dragging: nothing moves while a scrub or a
   * trim is in flight (the pointer is the authority on where the view should be then), and the strip
   * only scrolls when the playhead has actually left the visible window — a playhead in view is not a
   * reason to move anything.
   */
  function follow() {
    if (scrubbing || trimming || layingOut) return;
    if (duration <= 0) return;
    const pps = pxPerSecond();
    const x = time * pps;
    const left = scrolledTo;
    const right = left + viewWidth();
    if (x < left + 12) setScrollLeft(x - 12);
    else if (x > right - 24) setScrollLeft(x - viewWidth() + 24);
  }

  /** A pointer's x, in seconds on the source clock. */
  function timeFromEvent(event, pps = pxPerSecond()) {
    const rect = inner.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(duration, (event.clientX - rect.left) / pps));
  }

  /** Snap a dragged edge to the playhead or to the start, when it is close enough to matter. */
  function snap(seconds, pps) {
    const tolerance = SNAP_PX / pps;
    for (const target of [0, time]) {
      if (Math.abs(seconds - target) <= tolerance) return target;
    }
    return seconds;
  }

  let scrubbing = false;
  let trimming = null; // { track, id, edge }
  let moving = null; // { id, grab }  — an overlay clip dragged along the clock

  const scrubTo = (event) => {
    if (duration <= 0) return;
    onSeek?.(timeFromEvent(event));
  };

  scroll.addEventListener('pointerdown', (event) => {
    if (duration <= 0) return;
    const handle = event.target.closest?.('.timeline-handle');
    const segment = event.target.closest?.('.timeline-segment');
    const mediaClip = event.target.closest?.('.timeline-media-clip');
    // A trim starts on a handle, and only there — grabbing the middle of a clip has to keep meaning
    // "this clip", not "shrink this clip".
    if (handle && segment) {
      scroll.setPointerCapture?.(event.pointerId);
      trimming = { track: segment.dataset.track, id: segment.dataset.clipId, edge: handle.dataset.edge };
      event.preventDefault();
      return;
    }
    if (mediaClip) {
      const pps = pxPerSecond();
      const clip = mediaClips.find((c) => c.id === mediaClip.dataset.clipId);
      if (clip) {
        scroll.setPointerCapture?.(event.pointerId);
        // The edge handles trim; the body moves. Both are the same pointerdown, so which one it is has
        // to be decided here — and the *offset* of the grab is what stops the clip jumping so its start
        // lands under the pointer the moment the drag begins.
        trimming = handle ? { track: MEDIA_TRACK, id: clip.id, edge: handle.dataset.edge } : null;
        moving = handle ? null : { id: clip.id, grab: timeFromEvent(event, pps) - clip.start };
        event.preventDefault();
        return;
      }
    }
    // Every kind of clip selects on click, so the strip does not scrub when a clip was the target.
    if (segment || event.target.closest?.('.timeline-clip')) return;
    scroll.setPointerCapture?.(event.pointerId);
    scrubbing = true;
    scrubTo(event);
  });

  scroll.addEventListener('pointermove', (event) => {
    const pps = pxPerSecond();
    if (trimming) {
      onTrim?.(trimming.track, trimming.id, trimming.edge, snap(timeFromEvent(event, pps), pps));
      return;
    }
    if (moving) {
      // Snapped like a trim: a clip dragged near the playhead or the start lands exactly on it, which
      // is what makes "put it under this caption" a gesture rather than a measurement.
      onMoveClip?.(moving.id, snap(timeFromEvent(event, pps) - moving.grab, pps));
      return;
    }
    if (scrubbing) scrubTo(event);
  });

  const endDrag = () => {
    scrubbing = false;
    trimming = null;
    moving = null;
  };
  scroll.addEventListener('pointerup', endDrag);
  scroll.addEventListener('pointercancel', endDrag);

  zoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP));
  zoomOut.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
  const resetZoom = () => {
    zoom = 1;
    layout();
    setScrollLeft(0);
  };
  zoomFit.addEventListener('click', resetZoom);

  /**
   * The wheel, which is how a timeline is actually moved around.
   *
   * Three gestures, all of them the ones a video editor uses: the wheel pans along the strip (a
   * timeline has no vertical content, so a vertical wheel notch is a horizontal scroll), a
   * horizontal wheel or shift+wheel pans too — that is the trackpad — and ctrl+wheel (which a
   * trackpad sends for a pinch) zooms about the pointer.
   *
   * Without this the only way to scroll was to drag the scrollbar, and `touch-action: none` on the
   * strip — which is there so scrubbing and trimming work on a touch screen — ruled out the pan
   * gestures that would otherwise have covered for it.
   */
  scroll.addEventListener(
    'wheel',
    (event) => {
      if (duration <= 0) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const anchor = event.clientX - rect.left;
      if (event.ctrlKey || event.metaKey) {
        zoomBy(event.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM, anchor);
        return;
      }
      const dx = event.shiftKey ? event.deltaY : event.deltaX || event.deltaY;
      setScrollLeft(scrolledTo + dx);
    },
    { passive: false },
  );

  /** Keyboard, for the two things a keyboard is genuinely faster at: stepping and zooming. */
  const onKeyDown = (event) => {
    if (event.target !== scroll && !container.contains(event.target)) return;
    if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (event.key.toLowerCase() === 'f') resetZoom();
    else return;
    event.preventDefault();
  };
  scroll.tabIndex = 0;
  scroll.addEventListener('keydown', onKeyDown);

  // Re-fit when the strip changes width (the window, or the panel being shown for the first time).
  // The guard inside `layout()` is what stops a width change from re-entering it.
  let lastWidth = 0;
  const observer =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const width = scroll.clientWidth;
          if (width === lastWidth) return;
          lastWidth = width;
          viewportWidth = Math.max(120, width || 640);
          layout();
        })
      : null;
  observer?.observe(scroll);

  return {
    /** Show a document's blocks. */
    setDocument(next) {
      doc = next ?? null;
      layout();
    },
    /** The length of the source the strip is drawn against. */
    setDuration(seconds) {
      duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      layout();
    },
    /** The kept ranges per track — what the cut currently is. */
    setRanges(next) {
      ranges = { video: next?.video ?? [], audio: next?.audio ?? [] };
      layout();
      return ranges;
    },
    /** Which caption clips the cut removed from the picture. */
    setDropped(ids) {
      dropped = ids instanceof Set ? ids : new Set(ids ?? []);
      layout();
    },
    /** The overlay clips (`doc.media`), each drawn in its own window. */
    setMediaClips(clips) {
      mediaClips = Array.isArray(clips) ? clips : [];
      layout();
      return mediaClips;
    },
    /** Which overlay clips have no file loaded in this session — drawn, but marked. */
    setMediaOffline(ids) {
      offlineMedia = ids instanceof Set ? ids : new Set(ids ?? []);
      layout();
    },
    /** Highlight the selected overlay clip. */
    setSelectedMediaClip(id) {
      selectedMediaId = id ?? null;
      for (const node of rows.media.querySelectorAll('.timeline-media-clip')) {
        node.classList.toggle('active', node.dataset.clipId === selectedMediaId);
      }
      updateButtons();
    },
    get selectedMediaClipId() {
      return selectedMediaId;
    },
    setSelected(id) {
      selectedId = id ?? null;
      if (!doc) return;
      for (const clip of rows.captions.querySelectorAll('.timeline-clip')) {
        clip.classList.toggle('active', clip.dataset.blockId === selectedId);
      }
    },
    /** Highlight the selected video/audio clip. */
    setSelectedClip(selection) {
      selectedClip = selection ?? null;
      for (const track of TRACKS) {
        for (const segment of rows[track].querySelectorAll('.timeline-segment')) {
          segment.classList.toggle(
            'active',
            selectedClip?.track === track && selectedClip?.id === segment.dataset.clipId,
          );
        }
      }
      updateButtons();
    },
    get selectedClip() {
      return selectedClip;
    },
    /** Move the playhead (called from the preview's clock). */
    setTime(seconds) {
      time = Math.max(0, Number(seconds) || 0);
      positionPlayhead();
      follow();
      updateButtons();
    },
    /** The zoom level, as a number where 1 fits the recording on screen. For tests and callers. */
    get zoom() {
      return zoom;
    },
    /** Zoom to an absolute level (`1` fits). */
    setZoom(level) {
      zoomBy(Math.max(1, Number(level) || 1) / zoom);
      return zoom;
    },
    get time() {
      return time;
    },
    get element() {
      return container;
    },
    /** Redraw after the document or the cut changed. */
    refresh() {
      layout();
    },
    destroy() {
      observer?.disconnect();
      scroll.removeEventListener('keydown', onKeyDown);
      container.replaceChildren();
    },
  };
}
