/**
 * io/project-file.js — `.caproj` save/load plus format sniffing and routing.
 */

import { normalizeDocument } from '../model/document.js';
import { parseVeedJSON } from './veed-json.js';

export const PROJECT_EXT = '.caproj';

/** Sniff the kind of an imported JSON object. */
export function detectProjectKind(obj) {
  if (!obj || typeof obj !== 'object') return 'unknown';
  if (obj.schemaVersion && Array.isArray(obj.blocks)) return 'caption-studio';
  if (obj.canvas || obj.subtitles) return 'veed';
  if (obj.materials || obj.tracks) return 'capcut';
  return 'unknown';
}

export function serializeProject(doc) {
  const clone = { ...doc, meta: { ...doc.meta, updatedAt: Date.now() } };
  return JSON.stringify(clone, null, 2);
}

export function parseProject(text) {
  const obj = JSON.parse(text);
  return normalizeDocument(obj);
}

/**
 * Import any supported JSON text into a caption document.
 * @returns {{ document: object, kind: string, warnings: string[] }}
 */
export function importJSON(text) {
  const obj = JSON.parse(text);
  const kind = detectProjectKind(obj);
  const warnings = [];
  if (kind === 'caption-studio') {
    return { document: normalizeDocument(obj), kind, warnings };
  }
  if (kind === 'veed') {
    const doc = parseVeedJSON(obj);
    warnings.push(...(doc.sources?.ai?.version === 1 ? ['Veed v1 import has no AI keyword ranges'] : []));
    return { document: doc, kind, warnings };
  }
  if (kind === 'capcut') {
    warnings.push('CapCut import is experimental and may be incomplete');
    return { document: normalizeDocument(obj), kind, warnings };
  }
  throw new Error('Unrecognised JSON: not a caption-studio, Veed or CapCut project');
}
