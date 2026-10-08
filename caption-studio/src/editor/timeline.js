/**
 * editor/timeline.js — the timeline strip, in the shape a video editor uses.
 *
 * A ruler, a track of caption clips laid out along the document's own clock, and a playhead. It is a
 * *view* of the document and the preview, never a second source of truth: the clips are read from
 * `doc.blocks`, the playhead is driven by the preview's clock, and any interaction is handed straight
 * back out through `onSeek` / `onSelectBlock`. Nothing here computes time of its own.
 *
 * It is plain DOM rather than a canvas on purpose. A canvas would need a manual redraw on every
 * transport tick and would lose text selection, hover and accessibility for free; a few absolutely
 * positioned boxes cost nothing at this count and the browser re-lays them out itself.
 *
 * The time-to-pixels mapping is one number — `pxPerSecond` — so zooming is a single multiplication
 * and every element (ticks, clips, playhead) stays consistent without renegotiating.
 */

const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_PPS = 3;
const MAX_PPS = 600;

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
 * @param {HTMLElement} options.container   the host element the strip is built into
 * @param {(seconds:number)=>void} [options.onSeek]
 * @param {(blockId:string)=>void} [options.onSelectBlock]
 */
export function createTimeline({ container, onSeek = null, onSelectBlock = null } = {}) {
  if (!container) throw new Error('createTimeline(): a container element is required');

  container.replaceChildren();
  const toolbar = el('div', 'timeline-toolbar');
  const clock = el('span', 'timeline-clock mono', '0:00.0 / 0:00.0');
  const spacer = el('span', 'spacer');
  const zoomOut = el('button', 'ghost', '−');
  zoomOut.title = 'Zoom out';
  const zoomIn = el('button', 'ghost', '+');
  zoomIn.title = 'Zoom in';
  const zoomFit = el('button', 'ghost', 'Fit');
  zoomFit.title = 'Fit the whole timeline in view';
  toolbar.append(clock, spacer, zoomOut, zoomFit, zoomIn);

  const scroll = el('div', 'timeline-scroll');
  const inner = el('div', 'timeline-inner');
  const ruler = el('div', 'timeline-ruler');
  const track = el('div', 'timeline-track');
  const playhead = el('div', 'timeline-playhead');
  const empty = el('div', 'timeline-empty', 'No captions yet — load a source or open the demo.');
  inner.append(ruler, track, playhead);
  scroll.append(inner, empty);
  container.append(toolbar, scroll);

  let doc = null;
  let duration = 0;
  let time = 0;
  let selectedId = null;
  let zoom = 1;

  const viewWidth = () => Math.max(120, scroll.clientWidth || 640);
  const pxPerSecond = () => {
    if (duration <= 0) return MIN_PPS;
    const base = Math.min(MAX_PPS, Math.max(MIN_PPS, viewWidth() / duration));
    return Math.min(MAX_PPS, Math.max(MIN_PPS, base * zoom));
  };

  function renderRuler(pps, innerWidth) {
    ruler.replaceChildren();
    const step = tickStep(pps);
    const minor = step / 5;
    // A minor tick every fifth of a major one: enough orientation without the ruler turning into a
    // grey band at high zoom.
    for (let t = 0; t <= duration + 1e-6; t += minor) {
      const major = Math.abs((t / step) - Math.round(t / step)) < 1e-6;
      const tick = el('div', major ? 'timeline-tick major' : 'timeline-tick');
      tick.style.left = `${t * pps}px`;
      if (major) tick.append(el('span', 'timeline-tick-label', formatClock(t)));
      ruler.append(tick);
    }
    ruler.style.width = `${innerWidth}px`;
  }

  function renderTrack(pps) {
    track.replaceChildren();
    const blocks = doc?.blocks ?? [];
    for (const block of blocks) {
      const width = Math.max(3, (Number(block.end) - Number(block.start)) * pps);
      const clip = el('button', 'timeline-clip');
      clip.style.left = `${Math.max(0, Number(block.start) || 0) * pps}px`;
      clip.style.width = `${width}px`;
      clip.dataset.blockId = block.id;
      clip.title = `${formatClock(block.start)} – ${formatClock(block.end)}  ${block.text ?? ''}`;
      clip.append(el('span', 'timeline-clip-text', block.text ?? ''));
      if (block.id === selectedId) clip.classList.add('active');
      clip.addEventListener('click', (event) => {
        event.stopPropagation();
        onSelectBlock?.(block.id);
      });
      track.append(clip);
    }
    track.style.width = `${innerWidth}px`;
  }

  function layout() {
    const pps = pxPerSecond();
    const innerWidth = Math.max(viewWidth(), duration * pps);
    inner.style.width = `${innerWidth}px`;
    renderRuler(pps, innerWidth);
    renderTrack(pps);
    positionPlayhead();
    empty.hidden = Boolean(doc?.blocks?.length);
  }

  function positionPlayhead() {
    playhead.style.left = `${Math.max(0, time) * pxPerSecond()}px`;
    clock.textContent = `${formatClock(time)} / ${formatClock(duration)}`;
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

  function fractionFromEvent(event) {
    const rect = inner.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  let scrubbing = false;
  const scrubTo = (event) => {
    const fraction = fractionFromEvent(event);
    if (duration <= 0) return;
    onSeek?.(fraction * duration);
  };
  scroll.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.timeline-clip')) return; // a click on a clip selects, not scrubs
    scrubbing = true;
    scroll.setPointerCapture?.(event.pointerId);
    scrubTo(event);
  });
  scroll.addEventListener('pointermove', (event) => {
    if (scrubbing) scrubTo(event);
  });
  const endScrub = () => {
    scrubbing = false;
  };
  scroll.addEventListener('pointerup', endScrub);
  scroll.addEventListener('pointercancel', endScrub);

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
  const observer =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
  observer?.observe(scroll);

  return {
    /** Show a document's blocks. Resets the playhead window to fit. */
    setDocument(next) {
      doc = next ?? null;
      layout();
    },
    /** The length of the strip. */
    setDuration(seconds) {
      duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      layout();
    },
    /** Move the playhead (called from the preview's clock). */
    setTime(seconds) {
      time = Math.max(0, Number(seconds) || 0);
      positionPlayhead();
      follow();
    },
    /** Highlight the selected block's clip. */
    setSelected(id) {
      selectedId = id ?? null;
      if (!doc) return;
      for (const clip of track.querySelectorAll('.timeline-clip')) {
        clip.classList.toggle('active', clip.dataset.blockId === selectedId);
      }
    },
    /** Redraw clips after the document was edited. */
    refresh() {
      layout();
    },
    destroy() {
      observer?.disconnect();
      container.replaceChildren();
    },
  };
}
