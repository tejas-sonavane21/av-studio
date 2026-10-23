/**
 * core/run.js — one transcription, from a path on disk to files on disk.
 *
 * Shared by the CLI and the local server so there is one answer to "what does a
 * job produce", which is the same reason audio-studio routes its CLI and its HTTP
 * server through one pipeline. The provider is an argument rather than an import:
 * the server tests drive this with a stand-in, and the browser is not something a
 * unit test should need.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { checkFile, checkDuration, parseResponse } from './contract.js';
import { buildTranscript } from './transcript.js';
import { normalizeArtifacts, renderArtifacts } from './emit.js';

/** `{name, size, sha256, bytes}` for a file, or a clear failure. */
export async function fileFacts(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const failure = new Error(`cannot read ${path}: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
    failure.code = 'missing-file';
    throw failure;
  }
  if (!info.isFile()) {
    const failure = new Error(`${path} is not a file`);
    failure.code = 'not-a-file';
    throw failure;
  }
  const bytes = await readFile(path);
  return {
    path,
    name: basename(path),
    size: info.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

/**
 * Validate, transcribe, build, render and (optionally) write.
 *
 * `provider.transcribe({filePath, fileName, language, onProgress})` must resolve
 * to `{payload, request, duration}` - the shape `FreeTranscriberPage` returns.
 * Everything after that is this studio's own business.
 */
export async function runTranscription({
  provider,
  filePath,
  language = 'auto',
  artifacts = null,
  stem = null,
  outDir = null,
  onProgress = null,
  fetchedAt = new Date().toISOString(),
}) {
  const facts = await fileFacts(filePath);
  checkFile({ name: facts.name, size: facts.size });
  // Resolve the artifact list *before* the job: a typo in `--emit` should not
  // cost a minute of the site's queue to discover.
  const kinds = normalizeArtifacts(artifacts);

  const answer = await provider.transcribe({
    filePath: facts.path,
    fileName: facts.name,
    language,
    onProgress,
  });

  const parsed = parseResponse(answer.payload);
  if (answer.duration !== null && answer.duration !== undefined) {
    checkDuration(answer.duration, { name: facts.name });
  }

  const doc = buildTranscript({
    chunks: parsed.chunks,
    duration: answer.duration ?? 0,
    source: {
      name: facts.name,
      bytes: facts.size,
      sha256: facts.sha256,
    },
    provider: {
      language,
      predictionId: parsed.predictionId,
    },
    warnings: parsed.warnings,
    fetchedAt,
  });

  const rendered = renderArtifacts(doc, kinds, stem || facts.name.replace(/\.[^.]+$/, ''));

  const files = [];
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    for (const artifact of rendered) {
      const path = join(outDir, artifact.filename);
      await writeFile(path, artifact.text, 'utf8');
      files.push({ ...artifact, path });
    }
  } else {
    files.push(...rendered);
  }

  return {
    doc,
    files,
    request: {
      ...(answer.request || {}),
      endpoint: doc.provider.endpoint,
      predictionId: doc.provider.predictionId,
    },
  };
}
