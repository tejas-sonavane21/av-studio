/**
 * render/media-layer.js — the overlay clips, drawn onto a canvas.
 *
 * `model/media.js` owns the arithmetic — a clip's window, its box, which clips are on at time `t`, and
 * where the media is fitted inside its box — and is pure, so it is unit-tested in Node without a
 * browser. This module is the other half: the few lines that touch a 2D context.
 *
 * It is **one** function because there are two callers that have to agree pixel for pixel — the preview,
 * drawing at the fitted frame size, and the export, drawing at the output resolution. A second
 * implementation would be a second answer to "where is that clip", and the two would drift a frame at a
 * time with nothing to catch it.
 *
 * Nothing here knows about device pixel ratio: a caller that wants device pixels pre-scales its context
 * (the preview does), and `size` is always the frame expressed in the units the context is drawing in.
 */

import { boxRect, clipDrawRect, clipsAt, cropSourceRect } from '../model/media.js';

/**
 * A media's own pixel size, whichever kind of drawing source it is — 0×0 until it has one.
 *
 * Three sources reach this, and the third is why it is not two lines:
 *
 * * an `<img>` reports `naturalWidth`/`naturalHeight`;
 * * a `<video>` reports `videoWidth`/`videoHeight`;
 * * a **canvas** — which is what the export's own decoder hands over when a clip is decoded in order
 *   rather than seeked (`io/webcodecs-export.js`) — reports neither, because those properties are about
 *   a file and a canvas is already pixels. Its `width`/`height` are its own size, and they are read
 *   only for a canvas: an element with a `width` *attribute* but no metadata yet must still measure as
 *   0×0 and draw nothing, rather than being painted into a box on the strength of a layout number.
 */
export function mediaSizeOf(element) {
  const own = element?.naturalWidth || element?.videoWidth;
  if (own) {
    return { width: own, height: element.naturalHeight || element.videoHeight || 0 };
  }
  if (typeof element?.getContext === 'function') {
    return { width: element.width || 0, height: element.height || 0 };
  }
  return { width: 0, height: 0 };
}

/**
 * Draw every clip active at `time` onto `ctx`, clearing it first.
 *
 * A clip whose element is missing (its file is not loaded) or whose own size is not known yet draws
 * *nothing* — skipped, not stretched into its box. That is the honest answer, and it matches
 * `clipDrawRect`, which returns an empty rectangle rather than inventing a shape for a file nobody can
 * measure. (A clip set to `stretch` is the one exception and deliberately so: it needs no measurement,
 * because the box *is* the drawn rectangle.)
 *
 * A turned or mirrored clip is drawn inside a transform of its own, about the **box's** centre — not the
 * drawn rectangle's. The box is what the preview's handles move, so a rotated clip is turned about the
 * shape the user is dragging; taking the centre of the fitted rectangle instead would shift a
 * letterboxed clip sideways by half its letterbox every time it was rotated. The transform is set once,
 * so the cost is two matrix operations on the clips that are actually turned.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {Array<object>} options.clips                the document's clips (`doc.media`)
 * @param {{width:number,height:number}} options.size  the frame, in the context's current units
 * @param {number} options.time                        source time in seconds — the clock captions use
 * @param {(id:string)=>(HTMLImageElement|HTMLVideoElement|null)} [options.resolve]
 * @returns {number} how many clips were actually painted
 *
 * A **cropped** clip is drawn with the nine-argument `drawImage`: the crop's rectangle out of the file,
 * fitted into the box. That is what makes a crop a re-frame rather than a hole in the picture — see
 * `clipDrawRect`, which fits the *cropped* shape so nothing is ever distorted by a crop.
 */
export function drawMediaClips(ctx, { clips, size, time, resolve = () => null } = {}) {
  const width = Math.max(0, Number(size?.width) || 0);
  const height = Math.max(0, Number(size?.height) || 0);
  ctx.clearRect(0, 0, width, height);
  if (!clips?.length || !(width > 0) || !(height > 0)) return 0;
  let drawn = 0;
  for (const clip of clipsAt({ media: clips }, time)) {
    const element = resolve(clip.id);
    if (!element) continue;
    const media = mediaSizeOf(element);
    const rect = clipDrawRect(clip, media, { width, height });
    if (!(rect.width > 0 && rect.height > 0)) continue;
    // Which part of the file is drawn. The nine-argument `drawImage` is what makes a crop a *re-frame*
    // rather than a mask: the surviving piece is fitted into the box by the same `fit` as ever, and the
    // preview and the export hand the same source rectangle over — so neither can crop differently.
    // A file whose size is not known yet has no source rectangle, and is drawn whole (the stretch case,
    // which needs no measurement at all); an empty one would ask for zero pixels and paint nothing.
    const source = cropSourceRect(clip.crop, media);
    const cropped = source.width > 0 && source.height > 0;
    ctx.globalAlpha = clip.opacity;
    const turned = Math.abs(Number(clip.rotation) || 0) > 1e-6;
    const mirrored = clip.flipX === true || clip.flipY === true;
    const wrapped = turned || mirrored;
    try {
      if (wrapped) {
        const box = boxRect(clip.box, { width, height });
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        ctx.save?.();
        ctx.translate?.(cx, cy);
        if (turned) ctx.rotate?.(((Number(clip.rotation) || 0) * Math.PI) / 180);
        if (mirrored) ctx.scale?.(clip.flipX ? -1 : 1, clip.flipY ? -1 : 1);
        ctx.translate?.(-cx, -cy);
      }
      if (cropped) {
        ctx.drawImage(element, source.x, source.y, source.width, source.height, rect.x, rect.y, rect.width, rect.height);
      } else {
        ctx.drawImage(element, rect.x, rect.y, rect.width, rect.height);
      }
      if (wrapped) ctx.restore?.();
      drawn += 1;
    } catch {
      /* a frame that is not decodable yet — the next one tries again */
      if (wrapped) ctx.restore?.();
    }
  }
  ctx.globalAlpha = 1;
  return drawn;
}
