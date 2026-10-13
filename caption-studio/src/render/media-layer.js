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

import { clipDrawRect, clipsAt } from '../model/media.js';

/** An element's own pixel size, whichever kind of element it is — 0×0 until it has one. */
export function mediaSizeOf(element) {
  return {
    width: element?.naturalWidth || element?.videoWidth || 0,
    height: element?.naturalHeight || element?.videoHeight || 0,
  };
}

/**
 * Draw every clip active at `time` onto `ctx`, clearing it first.
 *
 * A clip whose element is missing (its file is not loaded) or whose own size is not known yet draws
 * *nothing* — skipped, not stretched into its box. That is the honest answer, and it matches
 * `clipDrawRect`, which returns an empty rectangle rather than inventing a shape for a file nobody can
 * measure.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} options
 * @param {Array<object>} options.clips                the document's clips (`doc.media`)
 * @param {{width:number,height:number}} options.size  the frame, in the context's current units
 * @param {number} options.time                        source time in seconds — the clock captions use
 * @param {(id:string)=>(HTMLImageElement|HTMLVideoElement|null)} [options.resolve]
 * @returns {number} how many clips were actually painted
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
    const rect = clipDrawRect(clip, mediaSizeOf(element), { width, height });
    if (!(rect.width > 0 && rect.height > 0)) continue;
    ctx.globalAlpha = clip.opacity;
    try {
      ctx.drawImage(element, rect.x, rect.y, rect.width, rect.height);
      drawn += 1;
    } catch {
      /* a frame that is not decodable yet — the next one tries again */
    }
  }
  ctx.globalAlpha = 1;
  return drawn;
}
