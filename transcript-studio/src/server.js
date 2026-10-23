/**
 * server.js — the local studio, for the GUI and for other tools.
 *
 * One job at a time, on purpose. There is one Chrome window, one free-service
 * queue and one site cooldown; a second concurrent job would wait for the first
 * anyway, and pretending otherwise would make the progress bar a lie.
 *
 * The API is deliberately small and loopback-only, like audio-studio's:
 *
 *   GET  /health                       what this studio is and what it accepts
 *   POST /transcribe?name=...          raw audio bytes in, `{jobId}` out
 *   GET  /jobs/<id>                    status, progress, summary, artifact list
 *   GET  /jobs/<id>/files/<kind>       one artifact (srt, vtt, json, speech, veed, txt)
 *
 * `provider` is injectable so the tests can exercise the whole HTTP surface
 * without a browser.
 */

import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTIFACTS, artifactNames, normalizeArtifacts, safeStem } from './core/emit.js';
import { LIMITS, LANGUAGES, checkFile, checkLanguage } from './core/contract.js';
import { runTranscription } from './core/run.js';
import { VERSION } from './core/transcript.js';
import { FreeTranscriber } from './provider/aifreeforever.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..', 'web');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const ARTIFACT_TYPES = {
  json: 'application/json; charset=utf-8',
  speech: 'application/json; charset=utf-8',
  veed: 'application/json; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** Phase → the fraction of the bar it starts at. Not a measurement; a layout. */
const PHASE_PROGRESS = {
  queued: 0.05,
  opening: 0.08,
  uploading: 0.12,
  verifying: 0.18,
  'cooling down': 0.24,
  transcribing: 0.55,
  done: 1,
};

function cors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
}

function json(response, status, body) {
  cors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

function text(response, status, body, type = 'text/plain; charset=utf-8') {
  cors(response);
  response.writeHead(status, { 'Content-Type': type });
  response.end(body);
}

function readBody(request, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`the upload is larger than ${(limit / (1024 * 1024)).toFixed(0)} MB`);
        error.code = 'too-large';
        rejectBody(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', rejectBody);
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress * 1000) / 1000,
    phase: job.phase,
    detail: job.detail,
    error: job.error,
    hint: job.hint,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    name: job.name,
    language: job.language,
    summary: job.summary,
    files: job.files.map((file) => ({
      kind: file.kind,
      label: file.label,
      filename: file.filename,
      url: `/jobs/${job.id}/files/${file.kind}`,
    })),
  };
}

/**
 * Build the server without starting it.
 *
 * `provider` must expose `transcribe({filePath, fileName, language, onProgress})`
 * and may expose `close()`. The default is the real browser provider; tests pass
 * an object with one method.
 */
export function createServer({ outDir = resolve('out'), provider = null, chromePath = null, profileDir = null } = {}) {
  const root = resolve(outDir);
  const jobs = new Map();
  const queue = [];
  let running = false;

  const activeProvider = provider || new FreeTranscriber({ chromePath, profileDir });

  async function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    job.status = 'running';
    job.phase = 'opening';
    job.progress = PHASE_PROGRESS.opening;
    try {
      const result = await runTranscription({
        provider: activeProvider,
        filePath: job.path,
        language: job.language,
        artifacts: job.artifacts,
        stem: job.stem,
        outDir: job.dir,
        onProgress: (update) => {
          job.phase = update.phase;
          job.detail = update.detail || '';
          job.progress = Math.max(job.progress, PHASE_PROGRESS[update.phase] ?? job.progress);
        },
      });
      job.status = 'done';
      job.phase = 'done';
      job.progress = 1;
      job.finishedAt = Date.now();
      job.files = result.files.map((file) => ({
        kind: file.kind,
        label: file.label,
        filename: file.filename,
        path: file.path,
      }));
      job.summary = {
        duration: result.doc.duration,
        chunks: result.doc.stats.chunks,
        words: result.doc.stats.words,
        predictionId: result.doc.provider.predictionId,
        warnings: result.doc.warnings,
      };
    } catch (error) {
      job.status = 'error';
      job.phase = 'error';
      job.progress = 1;
      job.finishedAt = Date.now();
      job.error = error?.message || String(error);
      job.hint = error?.hint || '';
      job.detail = '';
    } finally {
      running = false;
      pump();
    }
  }

  function enqueue(job) {
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return job;
  }

  /** Serve the static UI, refusing anything that resolves outside `web/`. */
  async function serveStatic(response, urlPath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const target = resolve(WEB_ROOT, relative);
    if (!target.startsWith(WEB_ROOT)) return text(response, 403, 'forbidden\n');
    try {
      const body = await readFile(target);
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(target).toLowerCase()] || 'application/octet-stream' });
      response.end(body);
    } catch {
      text(response, 404, 'not found\n');
    }
  }

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      cors(response);
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && path === '/health') {
      json(response, 200, {
        ok: true,
        name: 'transcript-studio',
        version: VERSION,
        provider: 'aifreeforever',
        page: 'https://aifreeforever.com/transcribe-audio-to-text',
        limits: { ...LIMITS, extensions: [...LIMITS.extensions] },
        languages: LANGUAGES.map(([code, label]) => ({ code, label })),
        artifacts: artifactNames(),
        queue: { running: running ? 1 : 0, waiting: queue.length },
      });
      return;
    }

    if (request.method === 'POST' && path === '/transcribe') {
      let body;
      try {
        body = await readBody(request, LIMITS.maxBytes + 1);
      } catch (error) {
        json(response, 413, { error: error.message, hint: 'the free service accepts at most 25 MB' });
        return;
      }

      const name = url.searchParams.get('name') || '';
      let language;
      let artifacts;
      try {
        checkFile({ name, size: body.length });
        language = checkLanguage(url.searchParams.get('language'));
        artifacts = normalizeArtifacts(url.searchParams.get('emit'));
      } catch (error) {
        json(response, 400, { error: error.message, hint: error.hint || '' });
        return;
      }

      const id = randomBytes(6).toString('hex');
      const dir = join(root, 'jobs', id);
      await mkdir(dir, { recursive: true });
      const path_ = join(dir, safeStem(name));
      await writeFile(path_, body);

      const job = enqueue({
        id,
        dir,
        path: path_,
        name,
        stem: url.searchParams.get('stem') || safeStem(name.replace(/\.[^.]+$/, '')),
        language,
        artifacts,
        status: 'queued',
        phase: 'queued',
        detail: 'waiting for the browser',
        progress: PHASE_PROGRESS.queued,
        error: null,
        hint: '',
        files: [],
        summary: null,
        createdAt: Date.now(),
        finishedAt: null,
      });
      json(response, 202, { jobId: id, id, status: job.status, job: publicJob(job) });
      return;
    }

    const jobMatch = path.match(/^\/jobs\/([a-f0-9]+)$/);
    if (request.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(response, 404, { error: `no job ${jobMatch[1]}` });
      return json(response, 200, publicJob(job));
    }

    const fileMatch = path.match(/^\/jobs\/([a-f0-9]+)\/files\/([a-z]+)$/);
    if (request.method === 'GET' && fileMatch) {
      const job = jobs.get(fileMatch[1]);
      if (!job) return json(response, 404, { error: `no job ${fileMatch[1]}` });
      const file = job.files.find((entry) => entry.kind === fileMatch[2]);
      if (!file) return json(response, 404, { error: `job ${job.id} has no ${fileMatch[2]} artifact` });
      try {
        const body = await readFile(file.path);
        cors(response);
        response.writeHead(200, {
          'Content-Type': ARTIFACT_TYPES[file.kind] || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${file.filename}"`,
        });
        response.end(body);
      } catch {
        json(response, 410, { error: 'that artifact is no longer on disk' });
      }
      return;
    }

    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      return serveStatic(response, path);
    }
    if (request.method === 'GET' && /^\/(app|styles)\.(js|css)$/.test(path)) {
      return serveStatic(response, path);
    }

    // A job's own files are the only dynamic thing; anything else that looks
    // like a static asset still has to stay inside `web/`.
    if (request.method === 'GET' && !path.startsWith('/jobs/')) {
      return serveStatic(response, path);
    }
    json(response, 404, { error: `no route for ${request.method} ${path}` });
  });

  return {
    server,
    jobs,
    provider: activeProvider,
    listen({ port = 8757, host = '127.0.0.1' } = {}) {
      return new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, host, () => {
          const address = server.address();
          resolveListen({ url: `http://${host}:${address.port}`, port: address.port });
        });
      });
    },
    async close() {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      if (activeProvider && typeof activeProvider.close === 'function') await activeProvider.close();
    },
    /** The artifact definitions, for tests and for the UI's download labels. */
    artifacts: ARTIFACTS,
  };
}

/** Start listening and report the URL; used by `npm start` and the CLI's `serve`. */
export async function startServer({ port = 8757, outDir = resolve('out'), profileDir = null, chromePath = null, provider = null } = {}) {
  const studio = createServer({ outDir, profileDir, chromePath, provider });
  const { url } = await studio.listen({ port });
  process.stdout.write(`transcript-studio ${VERSION} listening on ${url}\n`);
  const shutdown = async () => {
    await studio.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return studio;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const port = Number(process.argv[2]) || 8757;
  startServer({ port }).catch((error) => {
    process.stderr.write(`transcript-studio: ${error.message}\n`);
    process.exit(1);
  });
}
