/**
 * browser/cdp.js — a DevTools-protocol client in about a hundred lines.
 *
 * There is no puppeteer here for the same reason caption-studio's browser tests
 * have none: the protocol is a WebSocket carrying JSON, Node 22 speaks
 * WebSocket, and a dependency that ships its own Chromium would be a 200 MB
 * answer to a problem this studio does not have. It also drives the user's
 * *real* Chrome, which matters here - see the note in `chrome.js` about the
 * site's bot check.
 *
 * Every request has a timeout. A CDP call that never answers is the failure mode
 * that turns a one-minute job into a hung terminal, and the protocol itself does
 * not report it.
 */

export class CdpError extends Error {
  constructor(message, { method = '', cause = null } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.cause = cause;
  }
}

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Connect to a target's websocket.
 *
 * `events` is an array of listener functions called with every protocol event
 * (not with replies to our own requests). They may return promises; unhandled
 * rejections there would crash the process, so they are caught and reported
 * through `onListenerError`.
 */
export async function connect(wsUrl, { timeoutMs = 10000, onListenerError = null } = {}) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      reject(new CdpError(`timed out connecting to ${wsUrl}`));
    }, timeoutMs);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new CdpError(`could not connect to ${wsUrl}`));
      },
      { once: true },
    );
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  let closed = false;

  const failAll = (reason) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpError(reason));
    }
    pending.clear();
  };

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(message.error.message || 'CDP error', { method: entry.method }));
      else entry.resolve(message);
      return;
    }
    for (const listener of listeners) {
      try {
        const result = listener(message);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => onListenerError?.(error));
        }
      } catch (error) {
        onListenerError?.(error);
      }
    }
  });

  socket.addEventListener(
    'close',
    () => {
      closed = true;
      failAll('the browser connection closed');
    },
    { once: true },
  );

  return {
    get closed() {
      return closed;
    },
    on(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    send(method, params = {}, { timeoutMs: callTimeout = DEFAULT_TIMEOUT_MS } = {}) {
      if (closed) return Promise.reject(new CdpError('the browser connection is closed', { method }));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError(`${method} did not answer in ${callTimeout} ms`, { method }));
        }, callTimeout);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      closed = true;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      failAll('the browser connection was closed');
    },
  };
}

/**
 * `Runtime.evaluate` with the two options every caller in this project needs.
 *
 * `awaitPromise` is what lets the page itself probe a file's duration: the
 * expression is an async IIFE, and without it the reply is the promise object
 * rather than its value. A page exception is returned as `{error}` instead of
 * thrown, because "this page no longer has the button" is information about the
 * page, not a protocol failure.
 */
export async function evaluate(cdp, expression, { awaitPromise = false, timeoutMs = 10000 } = {}) {
  const reply = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise, timeout: timeoutMs },
    { timeoutMs: timeoutMs + 2000 },
  );
  const details = reply?.result?.exceptionDetails;
  if (details) {
    return { error: details.exception?.description || details.text || 'the page threw' };
  }
  return { value: reply?.result?.result?.value };
}
