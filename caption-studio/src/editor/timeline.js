/**
 * editor/timeline.js — the timeline strip, in the shape a video editor uses.
 *
 * A ruler, three tracks laid out along the source clock, and a playhead:
 *
 *   * **Captions** — the document's blocks, where they appear;
 *   * **Video** — the parts of the picture that are kept;
 *   * **Audio** — the parts of the track that are kept.
 *
 * All three share **one** clock — the source's own — and that is the central decision. The timeline is
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
 * What it is *not* is a second source of truth. The ranges come in through `setRanges`, the playhead
 * is driven by the preview's clock, and every edit goes straight back out as a callback (`onTrim`,
 * `onCommand`, `onSelectClip`) for the editor to apply to the document. Nothing here mutates a
 * document.
 */

const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_PPS = 3;
const MAX_PPS = 600;

/** Row geometry, in one place so the CSS and the hit-testing cannot disagree. */
const RULER_H = 22;
const ROW_TOP = { captions: RULER_H + 2, video: RULER_H + 38, audio: RULER_H + 74 };
const ROW_H = { captions: 32, video: 32, audio: 26 };
const INNER_H = ROW_TOP.audio + ROW_H.audio + 6;

/** How close (in pixels) a drag has to come to the playhead or to zero before it snaps. */
const SNAP_PX = 7;

const TRACKS = ['video', 'audio'];
const ROW_LABEL = { captions: 'Captions', video: 'Video', audio: 'Audio' };

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
 * @param {(command:string)=>void} [options.onCommand]  `split` | `cut-left` | `cut-right` | `delete` | `reset`
 * @param {(ranges:object)=>void} [options.onRanges]    a finished drag, as whole range lists
 */
export function createTimeline({
  container,
  onSeek = null,
  onSelectBlock = null,
  onSelectClip = null,
  onTrim = null,
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
  zoomOut.title = 'Zoom out';
  const zoomIn = el('button', 'ghost', '+');
  zoomIn.title = 'Zoom in';
  const zoomFit = el('button', 'ghost', 'Fit');
  zoomFit.title = 'Fit the whole timeline in view';
  toolbar.append(clock, editGroup, spacer, zoomOut, zoomFit, zoomIn);

  const scroll = el('div', 'timeline-scroll');
  const inner = el('div', 'timeline-inner');
  const ruler = el('div', 'timeline-ruler');
  const rows = {
    captions: el('div', 'timeline-track captions'),
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
  const empty = el('div', 'timeline-empty', 'No captions yet — load a source or open the demo.');
  inner.append(ruler, rows.captions, rows.video, rows.audio, playhead);
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
  let zoom = 1;

  const viewWidth = () => Math.max(120, scroll.clientWidth || 640);
  const pxPerSecond = () => {
    if (duration <= 0) return MIN_PPS;
    const base = Math.min(MAX_PPS, Math.max(MIN_PPS, viewWidth() / duration));
    return Math.min(MAX_PPS, Math.max(MIN_PPS, base * zoom));
  };

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
      const width = Math.max(3, (Number(block.end) - Number(block.start)) * pps);
      const clip = el('button', 'timeline-clip');
      clip.style.left = `${Math.max(0, Number(block.start) || 0) * pps}px`;
      clip.style.width = `${width}px`;
      clip.style.height = `${ROW_H.captions}px`;
      clip.dataset.blockId = block.id;
      clip.title = `${formatClock(block.start)} – ${formatClock(block.end)}  ${block.text ?? ''}`;
      clip.append(el('span', 'timeline-clip-text', block.text ?? ''));
      if (block.id === selectedId) clip.classList.add('active');
      // A caption the cut removed is still shown — it is how you see what you cut away — but it is
      // dimmed, and the export will not draw it.
      if (dropped.has(block.id)) clip.classList.add('dropped');
      clip.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectBlock?.(block.id);
      });
      rows.captions.append(clip);
    }
    rows.captions.style.width = `${rows.captions.closest('.timeline-inner')?.clientWidth || 0}px`;
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

  function layout() {
    const pps = pxPerSecond();
    const innerWidth = Math.max(viewWidth(), duration * pps);
    inner.style.width = `${innerWidth}px`;
    renderRuler(pps, innerWidth);
    renderCaptions(pps);
    for (const track of TRACKS) renderTrackSegments(track, pps);
    positionPlayhead();
    empty.hidden = Boolean(doc?.blocks?.length);
    updateButtons();
  }

  function positionPlayhead() {
    playhead.style.left = `${Math.max(0, time) * pxPerSecond()}px`;
    clock.textContent = `${formatClock(time)} / ${formatClock(duration)}`;
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
    splitBtn.disabled = !inside;
    cutLeftBtn.disabled = !TRACKS.some((track) => (ranges[track] ?? []).some((r) => r.srcIn < time - 0.05));
    cutRightBtn.disabled = !TRACKS.some((track) => (ranges[track] ?? []).some((r) => r.srcOut > time + 0.05));
    deleteBtn.disabled = !selectedClip && !TRACKS.some((track) => hitSegment(track, time));
    resetBtn.disabled = !anyCut;
  }

  /** Keep the playhead on screen while the transport runs; do nothing while the user is scrubbing. */
  function follow() {
    const pps = pxPerSecond();
    const x = time * pps;
    const left = scroll.scrollLeft;
    const right = left + viewWidth();
    if (x < left + 12) scroll.scrollLeft = Math.max(0, x - 12);
    else if (x > right - 24) scroll.scrollLeft = x - viewWidth() + 24;
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

  const scrubTo = (event) => {
    if (duration <= 0) return;
    onSeek?.(timeFromEvent(event));
  };

  scroll.addEventListener('pointerdown', (event) => {
    if (duration <= 0) return;
    const handle = event.target.closest?.('.timeline-handle');
    const segment = event.target.closest?.('.timeline-segment');
    // A trim starts on a handle, and only there — grabbing the middle of a clip has to keep meaning
    // "this clip", not "shrink this clip".
    if (handle && segment) {
      scroll.setPointerCapture?.(event.pointerId);
      trimming = { track: segment.dataset.track, id: segment.dataset.clipId, edge: handle.dataset.edge };
      event.preventDefault();
      return;
    }
    // Both kinds of clip select on click, so the strip does not scrub when a clip was the target.
    if (segment || event.target.closest?.('.timeline-clip')) return;
    scroll.setPointerCapture?.(event.pointerId);
    scrubbing = true;
    scrubTo(event);
  });

  scroll.addEventListener('pointermove', (event) => {
    if (trimming) {
      const pps = pxPerSecond();
      onTrim?.(trimming.track, trimming.id, trimming.edge, snap(timeFromEvent(event, pps), pps));
      return;
    }
    if (scrubbing) scrubTo(event);
  });

  const endDrag = () => {
    scrubbing = false;
    trimming = null;
  };
  scroll.addEventListener('pointerup', endDrag);
  scroll.addEventListener('pointercancel', endDrag);

  zoomIn.addEventListener('click', () => {
    zoom = Math.min(50, zoom * 1.7);
    layout();
  });
  zoomOut.addEventListener('click', () => {
    zoom = Math.max(1, zoom / 1.7);
    layout();
  });
  zoomFit.addEventListener('click', () => {
    zoom = 1;
    scroll.scrollLeft = 0;
    layout();
  });

  // Re-fit when the strip changes width (the window, or the panel being shown for the first time).
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
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
      container.replaceChildren();
    },
  };
}
