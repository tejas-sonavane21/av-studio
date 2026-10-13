/**
 * io/preview-source.js — which picture the *preview* shows, and which one the *export* encodes.
 *
 * Two different questions, and conflating them is how an editor silently degrades a finished file. The
 * preview may play a smaller copy of the picture (see `preview-proxy.js`) because decoding 4K is what
 * makes the transport stutter; the export must never see that copy. It has to encode the file the user
 * loaded, at its own resolution, with every cut, split and trim applied — an export that quietly came
 * out of the proxy would be the low-quality preview written to disk, which is the one outcome this
 * whole feature has to avoid.
 *
 * So the bookkeeping lives here, in one object, rather than in three variables in `main.js`:
 *
 *   original  the file the user loaded — the URL the export decodes, and its true size and length
 *   proxy     a smaller copy made from it, used *only* by the `<video>` element on screen
 *
 * `url` is what the preview element should be showing; `exportUrl`/`exportSize` are what the encoder
 * must be given. Nothing here touches the DOM, so the rule that the export ignores the proxy is
 * unit-tested in Node rather than hoped for in a browser.
 */

/**
 * The two sides of the picture, as one small state object.
 *
 * @returns {{
 *   setOriginal: (info: {name?: string, url: string, width?: number, height?: number, duration?: number}) => object,
 *   setOriginalSize: (info: {width?: number, height?: number, duration?: number}) => object,
 *   setProxy: (info: {url: string, width?: number, height?: number, seconds?: number, bytes?: number, mimeType?: string, audio?: boolean, frames?: number, averageFps?: number}) => object,
 *   clearProxy: () => boolean,
 *   original: object|null,
 *   proxy: object|null,
 *   url: string,
 *   exportUrl: string,
 *   exportSize: {width: number, height: number}|null,
 *   proxied: boolean,
 *   describe: () => string,
 * }}
 */
export function createPreviewSource() {
  /** @type {{name: string, url: string, width: number, height: number, duration: number}|null} */
  let original = null;
  /** @type {{url: string, width: number, height: number, seconds: number, bytes: number, mimeType: string, audio: boolean, frames: number, averageFps: number}|null} */
  let proxy = null;

  const clean = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

  function setOriginal(info = {}) {
    const url = String(info.url ?? '');
    if (!url) return null;
    // A different file means the old copy is a copy of something else: keeping it would show the
    // previous recording's pictures under the new recording's captions.
    proxy = null;
    original = {
      name: String(info.name ?? ''),
      url,
      width: clean(info.width),
      height: clean(info.height),
      duration: clean(info.duration),
    };
    return original;
  }

  function setOriginalSize(info = {}) {
    if (!original) return null;
    // Metadata arrives after the URL is set (the element has to load first), so the size is filled in
    // a second time. Only numbers that are actually there are taken: an element that has not read its
    // metadata yet reports 0, and overwriting a good size with 0 would lose the export's resolution.
    if (clean(info.width)) original.width = clean(info.width);
    if (clean(info.height)) original.height = clean(info.height);
    if (clean(info.duration)) original.duration = clean(info.duration);
    return original;
  }

  function setProxy(info = {}) {
    const url = String(info.url ?? '');
    if (!url || !original) return null;
    proxy = {
      url,
      width: clean(info.width),
      height: clean(info.height),
      seconds: clean(info.seconds),
      bytes: clean(info.bytes),
      mimeType: String(info.mimeType ?? ''),
      audio: Boolean(info.audio),
      // How many frames the copy really holds, and the rate they come out at. The copy is written
      // from the frames the decoder actually gave up (see `preview-proxy.js`), so its rate is a
      // measurement rather than the rate that was asked for — and a copy of a file that decodes at
      // 16 frames a second says 16, which is the difference between "the copy is broken" and "the
      // original never had more to give".
      frames: Math.round(clean(info.frames) || 0),
      averageFps: clean(info.averageFps),
    };
    return proxy;
  }

  function clearProxy() {
    const had = Boolean(proxy);
    proxy = null;
    return had;
  }

  function describe() {
    if (!original) return 'no picture loaded.';
    if (!proxy) return `${original.name || 'the picture'} — ${original.width}×${original.height}, ${original.duration.toFixed(2)}s. Previewing the original.`;
    const scale = original.width ? proxy.width / original.width : 0;
    return (
      `${original.name || 'the picture'} — the preview is a ${proxy.width}×${proxy.height} copy ` +
      `(${(scale * 100).toFixed(0)}% wide, ${(proxy.bytes / 1e6).toFixed(1)} MB, ` +
      `${proxy.frames} frame${proxy.frames === 1 ? '' : 's'}${proxy.averageFps ? ` at ${proxy.averageFps}/s` : ''}), ` +
      `so the transport is lighter to decode. Export still encodes the original ` +
      `${original.width}×${original.height} file.`
    );
  }

  return {
    setOriginal,
    setOriginalSize,
    setProxy,
    clearProxy,
    get original() {
      return original;
    },
    get proxy() {
      return proxy ? { ...proxy } : null;
    },
    /** What the on-screen `<video>` should be playing: the copy when there is one. */
    get url() {
      return proxy?.url || original?.url || '';
    },
    /**
     * What the encoder must decode: *never* the copy.
     *
     * Exporting the proxy would hand the user the low-quality preview as their master, which is the
     * whole reason this object exists rather than a `video.src` read.
     */
    get exportUrl() {
      return original?.url || '';
    },
    /** The export's own resolution: the original file's, not the copy's. */
    get exportSize() {
      if (!original || !(original.width > 0 && original.height > 0)) return null;
      return { width: original.width, height: original.height };
    },
    get proxied() {
      return Boolean(proxy);
    },
    describe,
  };
}
