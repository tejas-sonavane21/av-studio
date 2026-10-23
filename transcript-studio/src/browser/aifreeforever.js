/**
 * browser/aifreeforever.js — the real page, driven the way a person drives it.
 *
 * The endpoint cannot be called directly, and that is the whole design constraint:
 * the page sends an `x-turnstile-token` header that only a browser holding the
 * Cloudflare challenge can produce, and its own form enforces the site's queue and
 * cooldown before it sends anything. So this module does not reimplement the
 * request. It:
 *
 *   1. opens the page in a real Chrome and waits for the challenge to clear;
 *   2. puts the file in the page's own file input;
 *   3. reads the language select, the Turnstile token and the submit button's
 *      state, and waits until the *page* says it is ready;
 *   4. clicks the page's own submit button and lets the page run its queue;
 *   5. reads the reply out of the network response.
 *
 * Nothing is forged and nothing is skipped: the token is the one the widget
 * issued, the cooldown is the one the site imposes, and a second job waits for it
 * rather than clearing the site's localStorage. What this buys over a human is
 * only that the file, the waiting and the download are automatic.
 */

import { evaluate } from './cdp.js';
import { connect } from './cdp.js';
import { BrowserError, launchChrome } from './chrome.js';
import { SERVICE, ContractError, checkDuration, checkLanguage, cleanText } from '../core/contract.js';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/** The page's own selectors, copied from `AudioTranscribeInterface`. */
const SELECTORS = Object.freeze({
  form: 'form',
  file: 'input[type=file]',
  language: '#language',
  submit: 'button[type=submit]',
  token: 'input[name="cf-turnstile-response"]',
});

/** The inline errors the page can show before it ever posts, in its own words. */
const PAGE_ERRORS = [
  /File size must be less than[^\n]*/,
  /Please upload a valid audio file[^\n]*/,
  /Unable to read audio file[^\n]*/,
  /Audio file must be at least[^\n]*/,
  /Audio file must be no longer than[^\n]*/,
  /Please wait for the cooldown[^\n]*/,
];

export class SiteError extends Error {
  constructor(message, { hint = '', code = 'site', detail = null } = {}) {
    super(message);
    this.name = 'SiteError';
    this.hint = hint;
    this.code = code;
    this.detail = detail;
  }

  toString() {
    return this.hint ? `${this.message} - ${this.hint}` : this.message;
  }
}

const readStateExpression = `(() => {
  const button = document.querySelector(${JSON.stringify(SELECTORS.submit)});
  const token = document.querySelector(${JSON.stringify(SELECTORS.token)});
  const input = document.querySelector(${JSON.stringify(SELECTORS.file)});
  const form = document.querySelector(${JSON.stringify(SELECTORS.form)});
  const text = (button && button.innerText ? button.innerText : '').replace(/\\s+/g, ' ').trim();
  const formText = (form && form.innerText) || '';
  const error = ${JSON.stringify(PAGE_ERRORS.map((pattern) => pattern.source))}
    .map((source) => formText.match(new RegExp(source)))
    .find(Boolean);
  return {
    title: document.title,
    readyState: document.readyState,
    button: text,
    disabled: button ? Boolean(button.disabled) : null,
    token: token && token.value ? token.value.length : 0,
    file: input && input.files && input.files[0] ? input.files[0].name : null,
    error: error ? error[0] : null,
  };
})()`;

const durationExpression = `(async () => {
  const input = document.querySelector(${JSON.stringify(SELECTORS.file)});
  const file = input && input.files ? input.files[0] : null;
  if (!file) return null;
  const read = new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.addEventListener('loadedmetadata', () => done(Number.isFinite(audio.duration) ? audio.duration : null), { once: true });
    audio.addEventListener('error', () => done(null), { once: true });
    audio.src = url;
  });
  // The page is full of ad iframes and reloads its own React tree; a metadata
  // event that never fires must not wedge the whole job. The site still enforces
  // the duration itself, so returning null is a safe answer.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
  return await Promise.race([read, timeout]);
})()`;

/** Read the page's current form state. Never throws for a missing element. */
export async function readState(cdp) {
  const reply = await evaluate(cdp, readStateExpression);
  if (reply.error) {
    throw new SiteError('could not read the page state', { hint: reply.error, code: 'page' });
  }
  return reply.value;
}

export class FreeTranscriberPage {
  constructor({ chromePath = null, profileDir = null, onLog = null, navTimeoutMs = 240000 } = {}) {
    this.chromePath = chromePath;
    this.profileDir = profileDir;
    this.onLog = onLog;
    this.navTimeoutMs = navTimeoutMs;
    this.chrome = null;
    this.cdp = null;
    this.awaiting = false;
    this.apiResponse = null;
    this.apiRequest = null;
    this.used = false;
  }

  log(message) {
    this.onLog?.(message);
  }

  /** Launch Chrome (once) and land on the tool with its form rendered. */
  async open({ timeoutMs = this.navTimeoutMs } = {}) {
    if (this.cdp && !this.cdp.closed) return;
    this.log('opening the page in Chrome');
    this.chrome = await launchChrome({ chromePath: this.chromePath, profileDir: this.profileDir });
    this.cdp = await connect(this.chrome.wsUrl, { onListenerError: (error) => this.log(`page event error: ${error.message}`) });
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('DOM.enable');
    await this.cdp.send('Network.enable');

    this.cdp.on((message) => this.onProtocolEvent(message));
    await this.navigate({ timeoutMs });
  }

  /** Load the tool again. Also the clean way to reset the form between jobs. */
  async navigate({ timeoutMs = this.navTimeoutMs } = {}) {
    await this.cdp.send('Page.navigate', { url: SERVICE.pageUrl });
    await this.waitForApp({ timeoutMs });
  }

  onProtocolEvent(message) {
    if (!this.awaiting) return;
    if (message.method === 'Network.requestWillBeSent') {
      const { request, requestId } = message.params;
      if (this.isApi(request.url)) {
        this.apiRequest = { requestId, url: request.url, method: request.method, headers: request.headers, postData: request.postData };
      }
      return;
    }
    if (message.method === 'Network.responseReceived' && this.isApi(message.params.response.url)) {
      this.apiResponse = {
        requestId: message.params.requestId,
        status: message.params.response.status,
        url: message.params.response.url,
      };
    }
  }

  isApi(url) {
    try {
      return new URL(url).pathname === SERVICE.apiPath;
    } catch {
      return false;
    }
  }

  /** Wait until the challenge is behind us and the tool's form is on the page. */
  async waitForApp({ timeoutMs = this.navTimeoutMs } = {}) {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let sawChallenge = false;
    let lastLog = 0;
    let askedForHelp = false;
    while (Date.now() < deadline) {
      let state = null;
      try {
        state = await readState(this.cdp);
      } catch {
        /* navigation is in flight */
      }
      if (state && state.title && /just a moment|attention required/i.test(state.title)) {
        sawChallenge = true;
      } else if (state && state.file !== undefined && state.title) {
        const hasInput = await evaluate(this.cdp, `Boolean(document.querySelector(${JSON.stringify(SELECTORS.file)}))`);
        if (hasInput.value) return;
      }
      if (sawChallenge && !askedForHelp && Date.now() - started > 20000) {
        askedForHelp = true;
        this.log('the site is asking for a human check in the Chrome window - complete it there; still waiting');
      }
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        this.log(sawChallenge ? 'waiting for the site security check' : 'waiting for the page');
      }
      await delay(500);
    }
    throw new SiteError(
      sawChallenge
        ? 'the site security check did not clear'
        : 'the transcription page never showed its upload form',
      {
        hint: sawChallenge
          ? 'it needs a real, visible Chrome; if the window is open, clear the challenge there and retry'
          : 'the site may have changed - open it in Chrome and check the page still has an upload box',
        code: 'challenge',
      },
    );
  }

  /**
   * The DOM node for a selector, retried.
   *
   * `DOM.querySelector` answers "Could not find node with given id" when the
   * document was replaced between `getDocument` and the query, which happens
   * routinely here: the React app hydrates after the page's own HTML arrives, and
   * a challenge page hands over to the real one. A fresh `getDocument` on every
   * attempt is the fix; a cached node id is the bug.
   */
  async findNode(selector, { attempts = 20, intervalMs = 250 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const page = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
        const node = await this.cdp.send('DOM.querySelector', {
          nodeId: page.result.root.nodeId,
          selector,
        });
        if (node.result?.nodeId) return node.result.nodeId;
      } catch {
        /* the document changed under us; try again */
      }
      await delay(intervalMs);
    }
    return null;
  }

  /** Put the file into the page's own input, the way the file picker would. */
  async upload(filePath, { fileName = null } = {}) {
    const nodeId = await this.findNode(SELECTORS.file);
    if (!nodeId) {
      throw new SiteError('the page has no file input to fill', {
        hint: 'the tool may have changed; open the page in Chrome and check it still has an upload box',
        code: 'page',
      });
    }
    await this.cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    await delay(250);

    const state = await readState(this.cdp);
    if (!state.file) {
      throw new SiteError('the page did not accept the file', { code: 'upload' });
    }
    if (fileName && state.file !== fileName) {
      this.log(`the page received ${state.file}`);
    }
  }

  /** The duration the *browser* reads, which is the number the page checks. */
  async probeDuration() {
    try {
      const reply = await evaluate(this.cdp, durationExpression, { awaitPromise: true, timeoutMs: 12000 });
      if (reply.error) return null;
      const value = Number(reply.value);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch (error) {
      this.log(`could not read the file's duration in the page (${error.message}); the site will check it`);
      return null;
    }
  }

  async selectLanguage(code) {
    const language = checkLanguage(code);
    const reply = await evaluate(
      this.cdp,
      `(() => {
        const select = document.querySelector(${JSON.stringify(SELECTORS.language)});
        if (!select) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, ${JSON.stringify(language)});
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return select.value;
      })()`,
    );
    if (reply.error) throw new SiteError('could not choose the language', { hint: reply.error, code: 'page' });
    return language;
  }

  /**
   * Wait until the page's own button is enabled: file chosen, challenge solved,
   * cooldown over. Reports the page's queue/cooldown text while it waits.
   */
  async waitUntilReady({ timeoutMs = 300000, onProgress = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const state = await readState(this.cdp);
      if (state.error) {
        throw new ContractError(state.error, { hint: 'the site refused this file', code: 'file' });
      }
      if (state.disabled === false && state.token > 0 && state.file) return state;

      let phase = 'verifying';
      if (/wait/i.test(state.button)) phase = 'cooling down';
      else if (!state.file) phase = 'uploading';
      else if (state.token === 0) phase = 'verifying';
      const detail = state.button || '';
      if (detail !== last) {
        last = detail;
        onProgress?.({ phase, detail });
      }
      await delay(750);
    }
    throw new SiteError('the page never became ready to submit', {
      hint: 'the security check or the site cooldown did not finish in time; run it again, or submit once by hand in the open window',
      code: 'timeout',
    });
  }

  /**
   * Click submit and read the reply.
   *
   * The page waits 30 s before it posts (its own "queue"), so this is not a slow
   * network read: the click returns immediately and the response arrives a minute
   * later. Progress is the button's own text.
   */
  async submit({ timeoutMs = 420000, onProgress = null } = {}) {
    this.awaiting = true;
    this.apiResponse = null;
    this.apiRequest = null;

    const clicked = await evaluate(
      this.cdp,
      `(() => { const button = document.querySelector(${JSON.stringify(SELECTORS.submit)}); if (!button) return false; button.click(); return true; })()`,
    );
    if (!clicked.value) throw new SiteError('the submit button disappeared', { code: 'page' });

    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      if (this.apiResponse) break;
      let detail = '';
      try {
        const state = await readState(this.cdp);
        detail = state.button || '';
        if (state.error) {
          this.awaiting = false;
          throw new SiteError(state.error, { hint: 'the site reported this after submitting', code: 'service' });
        }
      } catch (error) {
        if (error instanceof SiteError) throw error;
      }
      if (detail && detail !== last) {
        last = detail;
        onProgress?.({ phase: /queue|processing/i.test(detail) ? 'queued' : 'transcribing', detail });
      }
      await delay(1000);
    }

    if (!this.apiResponse) {
      this.awaiting = false;
      throw new SiteError('the site did not answer in time', {
        hint: 'it may be busy; the job was not charged against a cooldown it did not start',
        code: 'timeout',
      });
    }

    const { requestId, status } = this.apiResponse;
    const body = await this.readResponseBody(requestId);
    this.awaiting = false;

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new SiteError('the site answered with something that is not JSON', {
        hint: body.slice(0, 200),
        code: 'response',
        detail: { status },
      });
    }

    if (status !== 200 || payload.success === false) {
      throw new SiteError(cleanText(payload.error) || `the site answered HTTP ${status}`, {
        hint: status === 403 ? 'the security check was rejected; retry from the open window' : '',
        code: 'service',
        detail: { status },
      });
    }

    return {
      payload,
      request: this.apiRequest
        ? {
            method: this.apiRequest.method,
            url: this.apiRequest.url,
            hasToken: Boolean(this.apiRequest.headers?.[SERVICE.tokenHeader] || this.apiRequest.headers?.['X-Turnstile-Token']),
          }
        : null,
      status,
    };
  }

  async readResponseBody(requestId) {
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const reply = await this.cdp.send('Network.getResponseBody', { requestId }, { timeoutMs: 5000 });
        if (reply?.result?.body !== undefined) {
          return reply.result.base64Encoded
            ? Buffer.from(reply.result.body, 'base64').toString('utf8')
            : reply.result.body;
        }
      } catch {
        /* the body is not ready yet */
      }
      await delay(300);
    }
    throw new SiteError('the site answered, but the reply body could not be read', { code: 'response' });
  }

  /**
   * One file, end to end. The page is left on the result view for a human to see;
   * the next call navigates again, which is also what makes a retry clean.
   */
  async transcribe({ filePath, fileName = null, language = 'auto', onProgress = null, durationHint = null, timeoutMs = 600000 } = {}) {
    await this.open();
    // A second job gets a fresh page. The first one was already navigated by
    // `open()`, and reloading between jobs is what guarantees a Turnstile token
    // this run can use instead of one that expired five minutes ago.
    if (this.used) await this.navigate();
    this.used = true;
    onProgress?.({ phase: 'uploading', detail: 'putting the file into the page' });
    await this.upload(filePath, { fileName });
    await this.selectLanguage(language);

    const duration = (await this.probeDuration()) ?? durationHint;
    // The page applies the same limit, but it applies it by silently never
    // enabling the button - so checking here is what turns a minute of waiting
    // into the sentence that says why.
    if (duration !== null) checkDuration(duration, { name: fileName || filePath });
    onProgress?.({ phase: 'verifying', detail: 'waiting for the security check' });
    // The cooldown can hold the button for two minutes on its own, so the ready
    // wait gets a floor rather than the whole job budget.
    await this.waitUntilReady({ timeoutMs: Math.max(180000, timeoutMs), onProgress });

    onProgress?.({ phase: 'queued', detail: 'the site is running its queue' });
    const answer = await this.submit({ timeoutMs, onProgress });
    return { ...answer, duration };
  }

  async close() {
    this.awaiting = false;
    try {
      this.cdp?.close();
    } catch {
      /* already closed */
    }
    this.cdp = null;
    this.chrome?.close();
    this.chrome = null;
  }
}

export { BrowserError };
