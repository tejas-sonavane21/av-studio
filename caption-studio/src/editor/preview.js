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
import { outputToSource, playbackTarget, sourceToOutput, trackRanges } from '../model/timeline.js';

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
  // The picture has run out and the programme has not. Latched rather than derived per frame, so
  // that the last frames of a track are not drawn under a picture that flickers back in when the
  // transport is paused, and cleared by seeking back inside the picture ('show video' is still the
  // user's switch; this only says there is nothing left to show).
  let pictureDone = false;

  /** Has this element a source and enough metadata loaded that it can be read or seeked? */
  const isReady = (m) => Boolean(m) && Number.isFinite(m.currentTime) && m.readyState > 0;

  /**
   * Which element the clock follows: the video while it still has material, else the audio.
   *
   * The picture is preferred *while it is running* — when both are loaded the video is normally the
   * full-length stream, and `resyncAudio()` keeps the track glued to it so two independent decoders
   * cannot drift apart.
   *
   * A picture that has **run out** is not a clock any more, and this is the half that used to be
   * missed: a video element that reaches its end holds its last frame and freezes `currentTime` at
   * its duration. With a picture shorter than the track — a cut-down music video against the
   * full-length master, which is the normal case here — the clock stopped at the picture's end, the
   * track kept playing underneath, and `resyncAudio()` pulled it back to the frozen time on every
   * frame. That is what "the audio collapses when the video is shorter" was. The programme's length
   * is its longest part (see `duration()`), so the track takes the clock over and the picture simply
   * stops showing anything.
   */
  function activeMedia() {
    if (isReady(video) && !video.ended) return video;
    if (isReady(audio) && !audio.ended) return audio;
    // Both run out, or neither is loaded: keep whichever of the two there is, so a paused-at-the-end
    // transport still reports the time it is parked on rather than falling back to the wall clock.
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

  /**
   * The cut, if the document has one: the kept ranges each element plays.
   *
   * `null` when there is no timeline at all, which keeps the no-cut path exactly as it has always
   * been — one branch fewer to get wrong for the common case of a project nobody has trimmed.
   */
  function mediaMap() {
    if (!doc?.timeline) return null;
    const spanOf = (media) => (Number.isFinite(media?.duration) && media.duration > 0 ? media.duration : 0);
    return {
      video: trackRanges(doc, 'video', spanOf(video)),
      audio: trackRanges(doc, 'audio', spanOf(audio)),
    };
  }

  /**
   * Step over a region the cut removed — and stop when the cut reaches the end.
   *
   * A cut is a gap in the source, not a shorter programme, so playback has to *jump* it — otherwise
   * trimming a clip would leave the preview playing exactly the seconds that were cut away, which is
   * the one thing a cut is supposed to mean. Skipped per element, because the two tracks can be cut in
   * different places.
   *
   * The end is the half that used to be missed. A media element plays its own whole file and knows
   * nothing about the cut, so after the last kept frame it simply carries on: cutting the tail off a
   * clip (`Cut right`) looked like it had done nothing at all while the preview ran on into material the
   * programme had dropped. `playbackTarget()` answers that too — when it reports `ended`, this track has
   * no kept material at or after the playhead, and the transport stops instead of sailing past the cut.
   */
  function skipCuts() {
    const map = mediaMap();
    if (!map) return;
    for (const [media, ranges] of [
      [video, map.video],
      [audio, map.audio],
    ]) {
      if (!ranges.length || !isReady(media) || media.paused) continue;
      const at = media.currentTime;
      const target = playbackTarget(ranges, at);
      if (target.ended) {
        // Nothing at or after this point survives the cut. The picture ending is the programme ending;
        // a track that has run out stops rather than playing what was removed.
        if (media === video) pause();
        else media.pause();
        continue;
      }
      if (target.time === at) continue; // still on kept material — leave the decoder alone
      try {
        media.currentTime = target.time;
      } catch {
        /* not seekable yet — the next frame tries again */
      }
    }
  }

  /**
   * Keep the audio track glued to the video, which owns the clock.
   *
   * With a cut in play the two are on *different* source times at the same moment — that is what two
   * independent tracks mean — so the glue is the *output* clock: where the picture is in the finished
   * file, and therefore where the sound should be too.
   */
  function resyncAudio() {
    if (!isReady(video) || !isReady(audio)) return;
    // A picture that has run out is not a clock — see `activeMedia()`. Gluing the track to a frozen
    // picture is worse than letting the two loose for a moment: it would seek the audio backwards on
    // every frame, which is heard as the track stuttering to a halt.
    if (video.ended) return;
    let target = video.currentTime;
    const map = mediaMap();
    if (map) {
      const out = sourceToOutput(map.video, video.currentTime);
      const mapped = out == null ? null : outputToSource(map.audio, out);
      if (mapped == null) return;
      target = mapped;
    }
    if (Math.abs(target - audio.currentTime) < DRIFT_LIMIT) return;
    try {
      audio.currentTime = target;
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
    if (playing) {
      skipCuts();
      resyncAudio();
    }
    syncPictureCoverage();

    renderFrame(currentTime());
    raf = requestAnimationFrame(loop);
  }

  function currentTime() {
    const media = activeMedia();
    return media ? media.currentTime : clock;
  }

  /**
   * Decide whether there is still a picture to show, and only touch the DOM when that changes.
   *
   * This is the "blank screen" half of a shorter picture: the track carries the programme on, and the
   * layer goes away rather than freezing on its last frame, which would read as the video being stuck
   * rather than finished. Seeking back inside the picture brings it straight back.
   */
  function syncPictureCoverage() {
    if (!video) return;
    const videoLength = trackDuration('video');
    const next = Boolean(
      videoLength > 0 &&
        (video.ended || currentTime() >= videoLength - 1e-3) &&
        trackDuration('audio') > videoLength + 1e-3,
    );
    if (next === pictureDone) return;
    pictureDone = next;
    applyVideoVisibility();
    if (pictureDone) log.info('the picture has run out; the track carries on over a blank frame');
  }

  /**
   * The length of one track's own recording — 0 when it is not loaded.
   *
   * A cut is measured against *its own* media, not against the programme: a 161 s picture and a
   * 182 s master are two recordings of different lengths, and using one number for both is what let
   * a caption be drawn past the end of the track it was timed to.
   */
  function trackDuration(track) {
    const media = track === 'audio' ? audio : video;
    const value = Number(media?.duration);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * Duration used by the transport: **the longest part that was loaded**, else the document's end.
   *
   * The longest, not the first: a programme is as long as its longest element. Taking the video's
   * length whenever a video was present made the transport stop early on the very common project
   * this editor exists for — a full-length master track under a shorter picture — and the captions
   * past that point then had nowhere to be drawn.
   */
  function duration() {
    const longest = Math.max(trackDuration('video'), trackDuration('audio'));
    if (longest > 0) return longest;
    if (!doc?.blocks?.length) return 0;
    return doc.blocks[doc.blocks.length - 1].end;
  }

  function start() {
    if (playing) return;
    if (currentTime() < trackDuration('video') - 1e-3) {
      pictureDone = false;
      applyVideoVisibility();
    }
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

  /**
   * Seek every loaded clock at once, so the picture and the sound cannot disagree.
   *
   * The requested time is a *source* time (that is the clock the captions and the strip share), so a
   * seek into a region the cut removed lands on the nearest frame that still exists — forward to the
   * next kept frame, or back onto the last one when the picture has run out. A playhead parked on a
   * frame the file does not contain would show a caption over a picture that is not there.
   */
  function seek(t) {
    const clamped = Math.max(0, t);
    // Seeking is the one thing that can put the picture back: the latching above is a statement about
    // where the playhead *is*, and the playhead is about to move.
    if (clamped < trackDuration('video') - 1e-3) {
      pictureDone = false;
      applyVideoVisibility();
    }
    const map = mediaMap();
    const target = map?.video?.length ? playbackTarget(map.video, clamped) : null;
    const videoTime = target ? target.time : clamped;
    clock = videoTime;
    if (isReady(video)) {
      try {
        video.currentTime = videoTime;
      } catch {
        /* seeking before metadata is ready throws in some browsers — ignore, next frame is fine */
      }
    }
    if (isReady(audio)) {
      let audioTime = videoTime;
      if (map) {
        const out = sourceToOutput(map.video, videoTime);
        const mapped = out == null ? null : outputToSource(map.audio, out);
        if (mapped != null) audioTime = mapped;
      }
      try {
        audio.currentTime = audioTime;
      } catch {
        /* ignore, as above */
      }
    }
    renderFrame(videoTime);
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
    if (video?.style) video.style.visibility = videoVisible && !pictureDone ? 'visible' : 'hidden';
  }

  function setVideoVisible(next) {
    videoVisible = !!next;
    applyVideoVisibility();
    renderFrame(currentTime());
    return videoVisible;
  }

  function setVideo(element) {
    video = element;
    // A different picture has not run out yet, whatever the last one did.
    pictureDone = false;
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
    /** The length of one track's own media, for the cut to be measured against. */
    trackDuration,
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
