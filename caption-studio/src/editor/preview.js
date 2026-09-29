/**
 * editor/preview.js — the preview surface: a video, a caption canvas over it, and a clock.
 *
 * Owns three things and nothing else:
 *
 * 1. **The render loop.** One `requestAnimationFrame` loop that draws the current frame. It is the
 *    only place `renderer.draw()` is called from, so the "drawing is a pure function of
 *    `(document, time, opts)`" rule stays enforceable.
 * 2. **The clock.** Time comes from the `<video>` when one is loaded; without a video it advances
 *    by wall-clock time while playing, so a document imported from an SRT/VTT (or the built-in
 *    demo) can still be previewed on its own. That is what makes the renderer testable without any
 *    media at all.
 * 3. **Sizing.** The canvas is fitted to the document's aspect ratio inside its container, at
 *    device resolution, and re-fitted on resize. Export never uses this path (plan §9.8: output
 *    size must not depend on the window), it is preview-only convenience.
 */

import { createRenderer } from '../render/renderer.js';
import { createLogger } from '../util/log.js';
import { mergeDeep } from '../util/math.js';

const log = createLogger('preview');

export function createPreview({ canvas, video = null, container = null, onFrame = null } = {}) {
  if (!canvas) throw new Error('createPreview(): a canvas element is required');

  const renderer = createRenderer('canvas2d');
  renderer.attach(canvas);

  let doc = null;
  let raf = 0;
  let playing = false;
  let clock = 0; // seconds, used when there is no video
  let lastTick = 0;
  let options = { guides: false, safeAreas: false };
  // The layouts produced by the most recent draw. The editor overlay hit-tests against these
  // rather than re-measuring: they are exactly the boxes that are on screen right now, which is
  // what makes "drag the text you can see" cheap and impossible to desync from the render.
  let layouts = [];
  // Whether the *video layer* is shown. Deliberately unrelated to caption drawing: hiding the
  // video must not stop the caption preview (that would make "show video" a rendering switch).
  let videoVisible = true;

  const box = () => {
    const el = container ?? canvas.parentElement;
    const width = el?.clientWidth || canvas.clientWidth || 960;
    // leave room for the transport strip below the canvas
    const height = Math.max(120, (el?.clientHeight || width * 0.5625) - 0);
    return { width, height };
  };

  /** Re-fit the canvas to the document's aspect inside its container. */
  function resize() {
    if (!doc) return null;
    const size = renderer.fit(doc, box());
    return size;
  }

  /**
   * Draw exactly one frame at `t`, then notify `onFrame`.
   * The notification lives here rather than in the loop so that scrubbing, a style edit and a
   * normal animation frame all update the transport UI identically.
   */
  function renderFrame(t) {
    if (!doc) return null;
    const result = renderer.draw(doc, t, options);
    layouts = result?.layouts ?? [];
    onFrame?.(t, doc);
    return result;
  }

  function loop() {
    if (!doc) {
      raf = requestAnimationFrame(loop);
      return;
    }
    const now = performance.now();
    if (playing && !video) clock += (now - lastTick) / 1000;
    lastTick = now;

    renderFrame(currentTime());
    raf = requestAnimationFrame(loop);
  }

  function currentTime() {
    if (video && Number.isFinite(video.currentTime) && video.readyState > 0) return video.currentTime;
    return clock;
  }

  /** Duration used by the transport: the media if there is any, else the document's end. */
  function duration() {
    if (video && Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    if (!doc?.blocks?.length) return 0;
    return doc.blocks[doc.blocks.length - 1].end;
  }

  function start() {
    if (playing) return;
    playing = true;
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    if (video) {
      // autoplay may be blocked before a user gesture; the button click *is* the gesture
      video.play().catch((err) => log.warn('video.play() refused:', err?.message ?? err));
    }
  }

  function pause() {
    playing = false;
    if (video && !video.paused) video.pause();
  }

  function toggle() {
    playing ? pause() : start();
    return playing;
  }

  /** Seek both clocks. */
  function seek(t) {
    const clamped = Math.max(0, t);
    clock = clamped;
    if (video && video.readyState > 0) {
      try {
        video.currentTime = clamped;
      } catch {
        /* seeking before metadata is ready throws in some browsers — ignore, next frame is fine */
      }
    }
    renderFrame(clamped);
  }

  /** Swap in a new document (after alignment, loading a project, or a style change). */
  async function setDocument(next, { autoplay = false } = {}) {
    doc = next;
    clock = next?.blocks?.[0]?.start ?? 0;
    resize();
    // fonts must resolve before the first measurement, or the layout is built with a fallback face
    const fonts = await renderer.ensureFonts(next);
    renderFrame(currentTime());
    if (autoplay) start();
    return fonts;
  }

  /**
   * Update the document's defaults (style edits) and redraw.
   * Deep-merged, so `{ font: { family } }` changes only the family. When the patch touches the
   * font, the faces are awaited *before* measuring — measuring with a fallback face and then
   * swapping is exactly how the old project ended up with text that "doesn't match".
   */
  async function setDefaults(patch) {
    if (!doc) return null;
    doc.defaults = mergeDeep(doc.defaults, patch);
    if (patch?.font) await renderer.ensureFonts(doc);
    renderer.layoutEngine?.invalidate();
    renderFrame(currentTime());
    return doc.defaults;
  }

  function setOptions(patch) {
    options = { ...options, ...patch };
    renderFrame(currentTime());
    return options;
  }

  function applyVideoVisibility() {
    if (video?.style) video.style.visibility = videoVisible ? 'visible' : 'hidden';
  }

  function setVideoVisible(next) {
    videoVisible = !!next;
    applyVideoVisibility();
    renderFrame(currentTime());
    return videoVisible;
  }

  function setVideo(element) {
    video = element;
    applyVideoVisibility();
    return video;
  }

  function dispose() {
    pause();
    cancelAnimationFrame(raf);
    raf = 0;
    renderer.dispose();
  }

  // keep the canvas fitted to its container
  const observer =
    typeof ResizeObserver !== 'undefined' && (container ?? canvas.parentElement)
      ? new ResizeObserver(() => resize())
      : null;
  observer?.observe(container ?? canvas.parentElement);

  return {
    renderer,
    resize,
    renderFrame,
    setDocument,
    setDefaults,
    setOptions,
    setVideo,
    setVideoVisible,
    start,
    pause,
    toggle,
    seek,
    currentTime,
    duration,
    get document() {
      return doc;
    },
    /** Boxes drawn in the last frame — the overlay's hit-test and snap inputs. */
    get layouts() {
      return layouts;
    },
    get playing() {
      return playing;
    },
    get options() {
      return { ...options };
    },
    dispose,
  };
}
