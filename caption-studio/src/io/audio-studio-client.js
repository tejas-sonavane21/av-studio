/**
 * io/audio-studio-client.js — the door to the Python studio next door.
 *
 * `caption-studio` inherits its word timings from Veed, and the drift that causes is the reason
 * `audio-studio` exists (see the sibling project's README). This module is how the two talk: it
 * asks the local Python server to transcribe an audio file, waits for the job, and hands back the
 * Veed-shaped master JSON that `io/project-file.js` already knows how to import.
 *
 * Three things about it are deliberate.
 *
 * **It uploads the file, it does not name a path.** A browser cannot read a path off the user's
 * disk — that is a privacy feature, not an oversight — so a client that only sent `{path}` would
 * make its user retype an absolute Windows path from memory. The bytes are already here; they go
 * over the wire.
 *
 * **It keeps the network out of the rest of the app.** This module holds no document, no state and
 * no DOM: it is a function from (base URL, file, options) to (job, veed JSON), with `fetch`
 * injectable so the whole flow can be tested against a stand-in server.
 *
 * **It fails with something a person can act on.** The common failure by far is "the Python server
 * is not running", and a bare `TypeError: Failed to fetch` is the least useful possible way to say
 * so. Every error here carries a hint, including the exact command to start the server.
 *
 * Plain HTTP to `127.0.0.1` by default: the server is loopback-only precisely so this file never
 * has to think about hosting.
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8756';

/**
 * How long the health probe waits before giving up.
 *
 * Not a tuned number — a *measured* one. Answering `/health` means asking every backend whether it
 * is installed, which means importing its dependencies, and on this machine a cold `import torch`
 * plus `import transformers` costs **6.3 s**. The server now resolves that in the background at
 * startup, but the client has to survive a cold one too, and four seconds (the first attempt at this)
 * guaranteed the very first click on a perfectly healthy server reported it as missing.
 */
export const HEALTH_TIMEOUT_MS = 20000;

/** The request the server actually understands, and what each field means. */
export const TRANSCRIBE_OPTIONS = {
  engine: 'transcription backend (whisper, fake)',
  preset: 'fast | balanced | accurate',
  model: 'override the preset\'s model',
  language: 'force a language code (e.g. en); default: autodetect',
  align: 're-time words against the audio: off | wav2vec | fake',
  validate: 'police the transcript text: off | rules | llm',
  llmProvider: 'auto | google | openrouter',
  llmModel: 'model name for the validation pass',
  emit: 'comma list of artifacts to produce: json,veed,srt,vtt',
  emphasis: 'none | all',
  referenceText: "the original lyrics themselves (or `reference`, a path the server can read)",
  referenceName: 'what to call that file in the artifact; the browser cannot send a path',
  referenceMinMatch: 'share of words that must agree before the lyrics are trusted (default 0.5)',
};

/**
 * The most a query string may carry before the server refuses the request line.
 *
 * Not a guess: Python's `http.server` reads the request line with a 64 KB ceiling and
 * answers 414 past it, and this client sends the lyric file as an option (see
 * `startUpload`). A lyric sheet is a few kilobytes, so a 48 KB budget has room to
 * spare — and passing it means a message that says what to do, rather than a bare 414.
 */
export const MAX_QUERY_CHARS = 48000;

export class AudioStudioError extends Error {
  constructor(message, { status = 0, detail = null, hint = '' } = {}) {
    super(message);
    this.name = 'AudioStudioError';
    this.status = status;
    this.detail = detail;
    this.hint = hint;
  }

  /** The whole story, for a log line. */
  toString() {
    return this.hint ? `${this.message} — ${this.hint}` : this.message;
  }
}

/** Strip a trailing slash so `${base}/health` never becomes `//health`. */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_BASE_URL;
  return text.replace(/\/+$/, '');
}

/**
 * Turn the UI's options into a query string.
 *
 * The same names `POST /transcribe` takes in its JSON body, because the server routes both through
 * one validator — an option that exists in one and not the other would be a bug waiting to happen.
 */
export function buildQuery(options = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      params.set(key, value.join(','));
      continue;
    }
    if (typeof value === 'boolean') {
      params.set(key, value ? 'true' : 'false');
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

async function readError(response) {
  let detail = null;
  try {
    detail = await response.json();
  } catch {
    /* a proxy or a crash can return something that is not JSON; the status carries it */
  }
  const message = detail?.error ?? `the server answered ${response.status}`;
  return new AudioStudioError(message, { status: response.status, detail });
}

function unreachable(baseUrl, cause) {
  if (cause?.name === 'AbortError') {
    // A server that is *busy* is not a server that is *absent*, and conflating the two sends the
    // user off to start something that is already running. This distinction was added after the
    // first `Check server` click on a healthy server reported it as unreachable: the probe had been
    // abandoned at 4 s while the payload was still importing torch.
    const error = new AudioStudioError(`audio-studio at ${baseUrl} did not answer in time`, {
      hint:
        'it is running but still busy — a cold start imports torch and transformers (a few seconds), ' +
        'and a transcription job saturates the CPU. Wait a moment and press Check server again.',
      detail: cause,
    });
    error.timedOut = true;
    return error;
  }
  return new AudioStudioError(`cannot reach audio-studio at ${baseUrl}`, {
    hint:
      'start it with:  python -m audio_studio serve   (in the audio-studio folder, inside .venv)',
    detail: cause,
  });
}

async function withTimeout(fetchImpl, url, init, timeoutMs) {
  if (!timeoutMs) return fetchImpl(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the server what it can do.
 *
 * Worth doing before a job rather than after one: `{aligners: [{name: 'wav2vec', available: false}]}`
 * is the difference between "alignment is not installed here" and a job that fails a minute later.
 */
export async function health(baseUrl = DEFAULT_BASE_URL, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  let response;
  try {
    response = await withTimeout(fetchImpl, `${base}/health`, { method: 'GET' }, timeoutMs);
  } catch (cause) {
    throw unreachable(base, cause);
  }
  if (!response.ok) throw await readError(response);
  return response.json();
}

/**
 * Send a file's bytes and get a job id back.
 *
 * The file's own name rides in the query string, because it is the only thing the server needs that
 * cannot come from the body — and it is what the artifacts on disk get named after.
 */
export async function startUpload(baseUrl, file, options = {}, { fetchImpl = fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const query = buildQuery({ name: file?.name, ...options });
  if (query.length > MAX_QUERY_CHARS) {
    throw new AudioStudioError(`the job request is ${query.length} characters long`, {
      hint:
        `the lyrics ride in the query string, which the server caps at 64 KB — trim the file to the ` +
        `sung lines (the limit is ${MAX_QUERY_CHARS} characters) and try again`,
    });
  }
  let response;
  try {
    response = await fetchImpl(`${base}/transcribe/upload?${query}`, {
      method: 'POST',
      // Not multipart: the body is the recording, and a browser sets this header itself when a
      // `File` is the body — set explicitly because an injected fetch in a test has no idea.
      headers: { 'Content-Type': file?.type || 'application/octet-stream' },
      body: file,
    });
  } catch (cause) {
    throw unreachable(base, cause);
  }
  if (!response.ok) throw await readError(response);
  return response.json();
}

/** One status read. */
export async function getJob(baseUrl, jobId, { fetchImpl = fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${base}/jobs/${jobId}`, { method: 'GET' });
  } catch (cause) {
    throw unreachable(base, cause);
  }
  if (!response.ok) throw await readError(response);
  return response.json();
}

/**
 * Poll until the job finishes.
 *
 * A Python transcription is minutes, not milliseconds, so this is a poll and not a long request:
 * a request that outlives a proxy's patience is a request that fails for reasons that have nothing
 * to do with the work. Progress is reported on the way, and `onProgress` is the only reason to
 * watch at all.
 */
export async function waitForJob(
  baseUrl,
  jobId,
  { fetchImpl = fetch, intervalMs = 750, timeoutMs = 0, onProgress, shouldStop } = {},
) {
  const started = Date.now();
  for (;;) {
    if (shouldStop?.()) throw new AudioStudioError('the job was cancelled');
    const job = await getJob(baseUrl, jobId, { fetchImpl });
    onProgress?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') {
      throw new AudioStudioError(job.error ?? 'the transcription failed', { detail: job });
    }
    if (timeoutMs && Date.now() - started > timeoutMs) {
      throw new AudioStudioError(`still ${job.status} after ${Math.round(timeoutMs / 1000)}s`, {
        hint: 'the server is still working; raise the timeout rather than starting another job',
        detail: job,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Fetch one artifact as text. */
export async function fetchArtifact(baseUrl, jobId, kind = 'veed', { fetchImpl = fetch } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${base}/jobs/${jobId}/${kind}`, { method: 'GET' });
  } catch (cause) {
    throw unreachable(base, cause);
  }
  if (!response.ok) throw await readError(response);
  return response.text();
}

/**
 * The whole flow: upload, wait, fetch the Veed master JSON.
 *
 * @returns {Promise<{job: object, veed: object, text: string}>} `text` is the raw artifact, so the
 *   caller feeds it to `importJSON` — the same path a file from disk takes, which is the point.
 */
export async function transcribeFile(baseUrl, file, options = {}, hooks = {}) {
  if (!file) throw new AudioStudioError('choose an audio or video file first');
  const job = await startUpload(baseUrl, file, options, hooks);
  const done = await waitForJob(baseUrl, job.jobId, { ...hooks, onProgress: (state) => {
    hooks.onProgress?.(state.progress ?? 0, state.message ?? state.status, state);
  } });
  const text = await fetchArtifact(baseUrl, job.jobId, 'veed', hooks);
  return { job: done, veed: JSON.parse(text), text };
}

/**
 * Read the provenance block the Python studio puts in every Veed master JSON it writes.
 *
 * The point of the round trip is that the timings are no longer borrowed, and this is where that
 * becomes visible to the person using the editor: which model transcribed, which aligner re-timed,
 * how confident it was, how far the words moved, and what the validation ledger did. None of it is
 * needed to render a caption — it is needed to *trust* one.
 *
 * @returns {string[]} one line per fact, ready to log.
 */
export function describeStudioAudit(veed) {
  const audit = veed?.audioStudio;
  if (!audit) return ['no audio-studio provenance in this file']; // e.g. a real Veed extract

  const lines = [];
  const engine = veed.engine ?? {};
  const engineName = [engine.name, engine.model].filter(Boolean).join('/') || 'unknown';
  lines.push(`engine ${engineName}${engine.preset ? ` (preset ${engine.preset})` : ''}`);

  // The reference pass is reported before the alignment, because that is the order they
  // ran in and because it explains the text the alignment numbers below refer to.
  const reference = audit.reference;
  if (reference) {
    const name = reference.name || 'lyrics';
    const rolling = reference.rolling ? ' (rolling)' : '';
    if (reference.outcome === 'applied') {
      const counts = reference.counts ?? {};
      lines.push(
        `reference ${name}${rolling}: ${Math.round((reference.matchRate ?? 0) * 100)}% of the audio matched the file — ` +
          `${counts.rewritten ?? 0} rewritten, ${counts.inserted ?? 0} inserted, ${counts.deleted ?? 0} deleted`,
      );
    } else {
      lines.push(`reference ${name}${rolling}: REFUSED — ${reference.reason ?? 'the file does not match this audio'}`);
    }
  }

  const alignment = audit.alignment;
  if (alignment) {
    const aligner = [alignment.aligner, alignment.model].filter(Boolean).join('/');
    lines.push(
      `alignment ${aligner}: ${alignment.segmentsAligned}/${alignment.segments} segments, ` +
        `mean confidence ${alignment.meanConfidence}, mean shift ${alignment.meanShift}s`,
    );
    if (alignment.wordsClamped) lines.push(`alignment clamped ${alignment.wordsClamped} word(s) to its own segment`);
    if (alignment.synthetic) lines.push('alignment is SYNTHETIC — those timings came from the transcript, not the audio');
  } else {
    lines.push('alignment off — these are the transcriber\'s own word timings');
  }

  for (const pass of audit.validation?.passes ?? []) {
    lines.push(`validation ${pass.validator}: ${pass.corrections} proposed, ${pass.applied} applied`);
  }
  if (audit.corrections?.length) lines.push(`corrections ${audit.corrections.length} ledger entries`);
  for (const warning of audit.warnings ?? []) lines.push(`warning: ${warning}`);
  return lines;
}

/**
 * What the options above should be for a given UI state.
 *
 * `align` and `validate` are sent as `undefined` rather than `'off'` when disabled: the server's
 * own default is "do not run it", and sending a value it does not know would be a 400.
 */
export function optionsFor({
  preset,
  language,
  align,
  validate,
  engine,
  model,
  llmModel,
  emit,
  emphasis,
  referenceText,
  referenceName,
  referenceMinMatch,
} = {}) {
  return {
    engine,
    preset,
    model,
    language: language || undefined,
    align: align && align !== 'off' ? align : undefined,
    validate: validate && validate !== 'off' ? validate : undefined,
    llmModel,
    emit,
    emphasis,
    // The original lyrics. Sent as the text rather than a path because a page cannot
    // read a path off the user's disk; the name rides along so the artifact can say
    // which file it was. Absent means the pass does not run at all.
    referenceText: referenceText || undefined,
    referenceName: referenceText ? referenceName || 'lyrics' : undefined,
    referenceMinMatch,
  };
}
