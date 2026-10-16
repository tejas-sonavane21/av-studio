/**
 * editor/media-library.js — the files behind the overlay clips.
 *
 * A clip in the document is *timing and placement*, not bytes: a `.caproj` is JSON, and nobody wants a
 * 4K B-roll embedded in one. So the bytes live here, keyed by the clip's own id, and the two are joined
 * by that id. It is the same split every editor makes, and it is why "this project has a clip whose
 * file is not loaded" is a real state the UI has to be able to say — see `missing()`.
 *
 * Two decisions worth stating:
 *
 * **Elements are loaded once and kept.** A video element that is re-created per frame would re-decode
 * from scratch every frame; one that is kept plays and seeks like any other media element, and the
 * preview and the export can both draw from it (the export seeks its own copy of the base picture, but
 * a clip is drawn from the same small element — see the note in `io/webcodecs-export.js`).
 *
 * **Clips are silent.** `element.muted` is set on load, and nothing here ever captures a clip's audio:
 * the master track loaded under Sources is the programme's sound. Trying to mix a second stream would
 * need a real mixer on both the preview and the export, and doing half of it would put sound in one and
 * not the other.
 */

import { kindFromFile } from '../model/media.js';

/** Load an image and report its own size. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () =>
      resolve({ element: image, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height, duration: 0 }),
    );
    image.addEventListener('error', () => reject(new Error('the image could not be decoded')), { once: true });
    image.src = url;
  });
}

/**
 * Load a video's metadata and report its own size and length.
 *
 * The element is parked off-screen but **in the document**: a detached element is decoded only as a
 * courtesy by most browsers, and a clip that draws as a blank rectangle is worse than one that says it
 * could not be loaded. Two pixels and `opacity: 0` paint nothing anywhere.
 */
function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    video.addEventListener(
      'loadedmetadata',
      () => resolve({ element: video, width: video.videoWidth, height: video.videoHeight, duration: video.duration }),
      { once: true },
    );
    video.addEventListener('error', () => reject(new Error('the video could not be decoded')), { once: true });
    document.body.appendChild(video);
    video.src = url;
    video.load?.();
  });
}

/**
 * The registry.
 *
 * @param {object} [options]
 * @param {(url: string) => void} [options.revoke]  injectable so a test can watch the URLs be released
 */
export function createMediaLibrary({ revoke = (url) => URL.revokeObjectURL(url) } = {}) {
  const entries = new Map();
  let counter = 0;

  /**
   * Release one entry: its object URL, its element, and its slot.
   *
   * A *shared* entry (the file behind a duplicated clip — see `copy()`) gives up its slot and nothing
   * else. The element is still on screen in the other clip, and revoking a URL the other clip draws from
   * is how one clip's removal blanks its twin.
   */
  function release(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    entries.delete(id);
    if (entry.owned === false) return true;
    try {
      if (entry.kind === 'video') entry.element.removeAttribute?.('src');
    } catch {
      /* already torn down */
    }
    entry.element.remove?.();
    if (entry.url) revoke(entry.url);
    return true;
  }

  /**
   * Read a file into an entry: its own URL, size and length. Does not store it.
   *
   * The failure is returned rather than thrown, because the caller is a loop over what a person
   * selected and one file it cannot read must not stop the rest.
   */
  async function read(file) {
    const kind = kindFromFile(file);
    if (!kind) return { ok: false, error: `"${file?.name ?? 'that file'}" is not an image or a video` };
    const url = URL.createObjectURL(file);
    try {
      const loaded = kind === 'image' ? await loadImage(url) : await loadVideo(url);
      return {
        ok: true,
        entry: {
          id: '',
          kind,
          name: String(file.name ?? (kind === 'image' ? 'image' : 'video')),
          url,
          width: loaded.width,
          height: loaded.height,
          duration: Number.isFinite(loaded.duration) ? loaded.duration : 0,
          element: loaded.element,
        },
      };
    } catch (err) {
      revoke(url);
      return { ok: false, error: `"${file?.name ?? 'that file'}" could not be loaded — ${err.message}` };
    }
  }

  return {
    /** Read a file and store it under `id` (or a fresh one). Returns `{ok, entry}` or `{ok, error}`. */
    async add(file, { id = null } = {}) {
      const result = await read(file);
      if (!result.ok) return result;
      const key = id ?? `clip-${++counter}`;
      // Re-linking replaces whatever was there: two clips pointing at the same id with two elements
      // would be one clip drawn twice, and only one of them would be the file the user picked.
      release(key);
      result.entry.id = key;
      entries.set(key, result.entry);
      return { ok: true, entry: result.entry };
    },
    get(id) {
      return entries.get(id) ?? null;
    },
    /**
     * Point a second id at the same file, for a duplicated clip.
     *
     * A copy is a *copy of a clip*, not of the bytes: the picture on screen is one file, and duplicating
     * it must not re-download, re-decode or re-encode anything. So the entry is shared - same element,
     * same object URL, its own id - and `release()` is told which of the two is being dropped, because a
     * clip removed from the programme must not take the other clip's picture with it.
     *
     * Nothing is registered when the source is not loaded: a copy of an offline clip is offline too, and
     * pretending otherwise would draw an empty rectangle under a name that says the file is there.
     */
    copy(fromId, toId) {
      const entry = entries.get(fromId);
      if (!entry || !toId) return null;
      const shared = { ...entry, id: toId, owned: false };
      entries.set(toId, shared);
      return shared;
    },
    /** The object URL for a clip's file, or `null` when it is not loaded — what the export decodes from. */
    url(id) {
      return entries.get(id)?.url ?? null;
    },
    /** The drawable element for a clip, or `null` when its file is not loaded. */
    element(id) {
      return entries.get(id)?.element ?? null;
    },
    /** A clip's own pixel size, or `null` when it is not loaded. */
    size(id) {
      const entry = entries.get(id);
      if (!entry || !(entry.width > 0 && entry.height > 0)) return null;
      return { width: entry.width, height: entry.height };
    },
    has(id) {
      return entries.has(id);
    },
    /** Which of these ids have no file loaded — what the panel calls "offline". */
    missing(ids) {
      return (Array.isArray(ids) ? ids : []).filter((id) => !entries.has(id));
    },
    remove(id) {
      return release(id);
    },
    /** Every loaded id — what a new document is pruned against. */
    ids() {
      return [...entries.keys()];
    },
    /**
     * How many files are loaded.
     *
     * `count`, not `size` — and that is a fixed bug rather than a preference: an object literal cannot
     * hold a `size(id)` method and a `size` getter at once, and the getter (being later in the literal)
     * silently won, so every `mediaLibrary.size(clipId)` threw "not a function". Nothing called it until
     * the clip's transform panel wanted a file's own size, which is exactly when it would have broken.
     */
    get count() {
      return entries.size;
    },
    /** Forget everything, releasing every URL. */
    clear() {
      const ids = [...entries.keys()];
      for (const id of ids) release(id);
      return ids.length;
    },
  };
}
