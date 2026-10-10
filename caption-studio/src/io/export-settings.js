/**
 * io/export-settings.js — what the export dialog decides, and the arithmetic behind it.
 *
 * The old export offered one control ("quality") and hid everything else inside a bits-per-pixel
 * constant. A professional export surface says all of it out loud — the container, the frame shape,
 * the resolution, the frame rate, the quality and the bitrate — and, crucially, keeps those settings
 * *consistent*: choosing 1080p and leaving the bitrate on a value that belonged to 480p is how an
 * export ends up looking worse than it should.
 *
 * The rule is therefore: **a preset re-tunes the rest, a manual change sticks.** Picking a resolution
 * applies its recommended frame rate and quality and recomputes the bitrate; after that, anything the
 * user touches stays touched until another preset is chosen, and the bitrate stops following on its
 * own the moment it is set by hand (`bitrateMode: 'custom'`).
 *
 * All of this is pure, so the recommendation table and the size arithmetic are unit-tested rather
 * than checked by exporting a file and looking at it.
 */

import { QUALITY_PRESETS, DEFAULT_QUALITY } from './download.js';
import { evenSize, resolutionFor } from './webcodecs-export.js';

/**
 * The resolutions a delivery is normally cut for.
 *
 * Each preset names the **short edge** — "1080p" is 1920×1080 landscape and 1080×1920 portrait — so
 * one setting covers every frame shape. `quality` is the encoder setting that suits that size: at
 * 480p a high bitrate is wasted, at 4K a low one is visible.
 */
export const RESOLUTION_PRESETS = Object.freeze({
  source: { shortEdge: 0, quality: 'high', label: 'Source — the document’s own resolution' },
  '480p': { shortEdge: 480, quality: 'balanced', label: '480p — SD, smallest' },
  '720p': { shortEdge: 720, quality: 'high', label: '720p — HD' },
  '1080p': { shortEdge: 1080, quality: 'high', label: '1080p — Full HD, recommended' },
  '1440p': { shortEdge: 1440, quality: 'best', label: '1440p — 2K / QHD' },
  '2160p': { shortEdge: 2160, quality: 'best', label: '2160p — 4K UHD' },
});

/** The frame rates worth offering. 30 is the sane default; 24 is film, 50/60 for motion. */
export const FPS_OPTIONS = Object.freeze([24, 25, 30, 50, 60]);
export const DEFAULT_FPS = 30;
export const DEFAULT_RESOLUTION = '1080p';

/** The bitrate units the dialog speaks, so a number means the same thing everywhere. */
export const MBPS = 1000000;

/**
 * The offered frame rate closest to what the source actually runs at.
 *
 * Matching the source avoids a pointless conversion: re-timing 25→30 duplicates frames for no visible
 * gain, and it is the kind of "professional" default that quietly makes an export worse.
 */
export function recommendedFps(sourceFps) {
  const value = Number(sourceFps);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_FPS;
  let best = FPS_OPTIONS[0];
  let gap = Infinity;
  for (const option of FPS_OPTIONS) {
    const distance = Math.abs(option - value);
    if (distance < gap) {
      gap = distance;
      best = option;
    }
  }
  return best;
}

/** A fresh set of settings. `source` keeps the document's own pixels; 1080p is the everyday export. */
export function defaultExportSettings(overrides = {}) {
  return {
    format: 'mp4',
    resolution: DEFAULT_RESOLUTION,
    fps: DEFAULT_FPS,
    quality: DEFAULT_QUALITY,
    // 'auto' follows quality/size; 'custom' means the user typed a number and it must not be touched
    videoBitrateMode: 'auto',
    videoBitrate: 0,
    audioBitrateMode: 'auto',
    audioBitrate: 0,
    ...overrides,
  };
}

/** The recommended frame rate and quality for a resolution preset. Pure. */
export function recommendFor(resolutionId, { sourceFps = 0 } = {}) {
  const preset = RESOLUTION_PRESETS[resolutionId] ?? RESOLUTION_PRESETS[DEFAULT_RESOLUTION];
  return { fps: recommendedFps(sourceFps), quality: preset.quality };
}

/**
 * Apply a resolution preset: it re-tunes the frame rate and quality, and lets the bitrate follow.
 *
 * This is the "automatically tuned" half of the dialog. Only choosing a preset moves the other
 * controls — a manual edit never does, or the surface would fight the user.
 */
export function applyResolution(settings, resolutionId, { sourceFps = 0 } = {}) {
  const next = { ...settings, resolution: RESOLUTION_PRESETS[resolutionId] ? resolutionId : DEFAULT_RESOLUTION };
  const recommended = recommendFor(next.resolution, { sourceFps });
  return { ...next, fps: recommended.fps, quality: recommended.quality };
}

/** The bitrates the encoder is actually configured with, from the settings and the frame size. Pure. */
export function effectiveBitrates(settings, { width, height, quality = settings.quality } = {}) {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS[DEFAULT_QUALITY];
  const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
  const rate = Math.min(60, Math.max(1, Number(settings?.fps) || DEFAULT_FPS));
  const auto = Math.round(Math.min(50000000, Math.max(250000, pixels * rate * preset.bpp)));
  const custom = Math.round(Number(settings?.videoBitrate) || 0);
  return {
    videoBitsPerSecond: settings?.videoBitrateMode === 'custom' && custom > 0 ? custom : auto,
    audioBitsPerSecond:
      settings?.audioBitrateMode === 'custom' && Math.round(Number(settings?.audioBitrate) || 0) > 0
        ? Math.round(settings.audioBitrate)
        : preset.audio,
  };
}

/**
 * Where the file will actually land, in pixels. Pure.
 *
 * `source` keeps the document's own resolution; any preset derives the other edge from the frame
 * shape, so 1080p in a 9:16 project is 1080×1920 rather than a letterboxed 1920×1080.
 */
export function outputSize(settings, { aspect = 16 / 9, docSize = null } = {}) {
  const preset = RESOLUTION_PRESETS[settings?.resolution] ?? RESOLUTION_PRESETS[DEFAULT_RESOLUTION];
  if (!preset.shortEdge) {
    const fallback = docSize ?? { width: Math.round(aspect * 720), height: 720 };
    return evenSize(fallback.width, fallback.height);
  }
  return resolutionFor(preset.shortEdge, aspect);
}

/**
 * Everything the encoder needs, from the dialog's settings. Pure.
 *
 * One function, so the dialog's readout and the export cannot disagree about what was chosen.
 */
export function encoderSettings(settings, { aspect = 16 / 9, docSize = null } = {}) {
  const size = outputSize(settings, { aspect, docSize });
  const rates = effectiveBitrates(settings, { ...size, quality: settings.quality });
  return {
    format: settings.format === 'webm' ? 'webm' : 'mp4',
    quality: settings.quality,
    fps: Math.min(60, Math.max(1, Math.round(Number(settings.fps) || DEFAULT_FPS))),
    size,
    ...rates,
    resolutionId: settings.resolution,
  };
}

/** One line describing the file that will be produced — the dialog's readout. Pure. */
export function describeSettings(settings, { aspect = 16 / 9, docSize = null } = {}) {
  const encoder = encoderSettings(settings, { aspect, docSize });
  const pixels = `${encoder.size.width}×${encoder.size.height}`;
  return `${encoder.format.toUpperCase()} · ${pixels} · ${encoder.fps} fps · ${settings.quality} · ${(encoder.videoBitsPerSecond / MBPS).toFixed(1)} Mbps video · ${Math.round(encoder.audioBitsPerSecond / 1000)} kbps audio`;
}
