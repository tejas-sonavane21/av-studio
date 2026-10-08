/**
 * editor/preview.js — the preview surface: a video, a caption canvas over it, and a clock.
 *
 * Owns three things and nothing else:
 *
 * 1. **The render loop.** One `requestAnimationFrame` loop that draws the current frame. It is the
 *    only place `renderer.draw()` is called from, so the "drawing is a pure function of
 *    `(document, time, opts)`" rule stays enforceable.
 * 2. **The clock.** Time comes from the media when any is loaded — video first, then audio — and
 *    otherwise advances by wall-clock time while playing, so a document imported from an SRT/VTT
 *    (or the built-in demo) can still be previewed on its own. That is what makes the renderer
 *    testable without any media at all.
 * 3. **Sizing.** The canvas is fitted to the document's aspect ratio inside its container, at
 *    device resolution, and re-fitted on resize. Export never uses this path (plan §9.8: output
 *    size must not depend on the window), it is preview-only convenience.
 */

import { createRenderer } from '../render/renderer.js';
import { createLogger } from '../util/log.js';
import { mergeDeep } from '../util/math.js';

const log = createLogger('preview');

export function createPreview({ canvas, video = null, audio = null, container = null, onFrame = null } = {}) {
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
  // The sound. Three orthogonal switches, because "mute" alone could never say *what* to mute:
  // a master mute and volume that apply to everything, and a per-source enable for each of the two
  // things that can make noise — the picture's own track and the uploaded playback file. All of them
  // are independent of `videoVisible`: muting must not stop the picture, and hiding the video must
  // not mute the track.
  let muted = false; // master mute — silences both sources at once
  let volume = 1; // master volume
  let videoAudioEnabled = true; // the picture's own soundtrack
  let playbackAudioEnabled = true; // the uploaded audio file

  /** Has this element a source and enough metadata loaded that it can be read or seeked? */
  const isReady = (m) => Boolean(m) && Number.isFinite(m.currentTime) && m.readyState > 0;

  /**
   * Which element the clock follows: the video when it is loaded, else the audio.
   *
   * Video wins on purpose. When both are loaded the video is the picture and normally the
   * full-length stream; the audio element is the track, and `resyncAudio()` keeps it glued to the
   * video so two independent decoders cannot drift apart over a long preview.
   */
  function activeMedia() {
    if (isReady(video)) return video;
    if (isReady(audio)) return audio;
    return null;
  }

  /**
   * Route the sound, in one place, from one rule: **each source is heard unless it is switched off**.
   *
   * The old rule force-muted the picture the moment a separate audio file was loaded, which avoided
   * two tracks playing over each other but took the choice away. Now the choice is explicit: the
   * caller turns the picture's own sound off when it hands over a master track (that is still the
   * sensible default), and can turn it back on. The master mute/volume sit above both.
   */
  function applyAudioRouting() {
    if (video) {
      video.muted = muted || !videoAudioEnabled;
      video.volume = volume;
    }
    if (audio) {
      audio.muted = muted || !playbackAudioEnabled;
      audio.volume = volume;
    }
  }

  // How far the audio may drift from the video before it is snapped back. Large enough that ordinary
  // frame-to-frame jitter never triggers a seek (which would click), small enough to stay invisible.
  const DRIFT_LIMIT = 0.25;

  /** Keep the audio track glued to the video, which owns the clock. */
  function resyncAudio() {
    if (!isReady(video) || !isReady(audio)) return;
    if (Math.abs(video.currentTime - audio.currentTime) < DRIFT_LIMIT) return;
    try {
      audio.currentTime = video.currentTime;
    } catch {
      /* not seekable yet — the next frame tries again */
    }
  }

  const box = () => {
    const el = container ?? canvas.parentElement;
    const width = el?.clientWidth || canvas.clientWidth || 960;
    // leave room for the transport strip below the canvas
    const height = Math.max(120, (el?.clientHeight || width * 0.5625) - 0);
    return { width, height };
  };

  /**
   * Put the video layer exactly where the caption canvas is.
   *
   * The two have to agree pixel-for-pixel or the captions drift off the picture they were timed
   * against. Letting the video position itself with `inset: 0` works only while its container is the
   * frame's own shape — which is true in the editor but *not* on the full screen, where the browser
   * forces the full-screen element to fill the display and the frame can only be letterboxed inside
   * it. Copying the canvas's box is one rule that holds in both places, and it costs a couple of
   * layout reads per resize rather than per frame.
   */
  function syncVideoBox() {
    if (!video?.style || !canvas) return;
    const host = container ?? canvas.parentElement;
    const frame = canvas.getBoundingClientRect?.();
    const parent = host?.getBoundingClientRect?.();
    if (!frame || !parent || !frame.width || !frame.height) return;
    video.style.inset = 'auto';
    video.style.left = `${frame.left - parent.left}px`;
    video.style.top = `${frame.top - parent.top}px`;
    video.style.width = `${frame.width}px`;
    video.style.height = `${frame.height}px`;
  }

  /** Re-fit the canvas to the document's aspect inside its container. */
  function resize() {
    if (!doc) return null;
    const size = renderer.fit(doc, box());
    // after the fit, not before: the box to copy is the one the fit just produced
    syncVideoBox();
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
    // The wall clock is only a fallback: as soon as any media can drive the time, it does.
    if (playing && !activeMedia()) clock += (now - lastTick) / 1000;
    lastTick = now;
    if (playing) resyncAudio();

    renderFrame(currentTime());
    raf = requestAnimationFrame(loop);
  }

  function currentTime() {
    const media = activeMedia();
    return media ? media.currentTime : clock;
  }

  /** Duration used by the transport: the media if there is any, else the document's end. */
  function duration() {
    for (const m of [video, audio]) {
      if (m && Number.isFinite(m.duration) && m.duration > 0) return m.duration;
    }
    if (!doc?.blocks?.length) return 0;
    return doc.blocks[doc.blocks.length - 1].end;
  }

  function start() {
    if (playing) return;
    playing = true;
    lastTick = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    resyncAudio();
    // autoplay may be blocked before a user gesture; the button click *is* the gesture
    for (const m of [video, audio]) {
      if (m) m.play().catch((err) => log.warn('media.play() refused:', err?.message ?? err));
    }
  }

  function pause() {
    playing = false;
    for (const m of [video, audio]) if (m && !m.paused) m.pause();
  }

  function toggle() {
    playing ? pause() : start();
    return playing;
  }

  /** Seek every loaded clock at once, so the picture and the sound cannot disagree. */
  function seek(t) {
    const clamped = Math.max(0, t);
    clock = clamped;
    for (const m of [video, audio]) {
      if (!isReady(m)) continue;
      try {
        m.currentTime = clamped;
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
    syncVideoBox();
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
    applyAudioRouting();
    syncVideoBox();
    return video;
  }

  /** Swap in the audio track (or `null` to remove it). Routing is re-applied to the new element. */
  function setAudio(element) {
    audio = element;
    applyAudioRouting();
    return audio;
  }

  /** Master mute — silences both sources without changing either per-source switch. */
  function setMuted(next) {
    muted = !!next;
    applyAudioRouting();
    return muted;
  }

  /** The picture's own soundtrack on/off. */
  function setVideoAudioEnabled(next) {
    videoAudioEnabled = !!next;
    applyAudioRouting();
    return videoAudioEnabled;
  }

  /** The uploaded playback file on/off. */
  function setPlaybackAudioEnabled(next) {
    playbackAudioEnabled = !!next;
    applyAudioRouting();
    return playbackAudioEnabled;
  }

  function setVolume(next) {
    const value = Number(next);
    volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    applyAudioRouting();
    return volume;
  }

  function dispose() {
    pause();
    cancelAnimationFrame(raf);
    raf = 0;
    renderer.dispose();
  }

  // Publish the initial routing, so a `<video muted>` in the markup is not left as the source of
  // truth for whether the preview is audible.
  applyAudioRouting();

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
    setAudio,
    setMuted,
    setVolume,
    setVideoAudioEnabled,
    setPlaybackAudioEnabled,
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
    get audio() {
      return audio;
    },
    get muted() {
      return muted;
    },
    get volume() {
      return volume;
    },
    get videoAudioEnabled() {
      return videoAudioEnabled;
    },
    get playbackAudioEnabled() {
      return playbackAudioEnabled;
    },
    get options() {
      return { ...options };
    },
    dispose,
  };
}
