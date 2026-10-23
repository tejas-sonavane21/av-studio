/**
 * browser/chrome.js — find, launch and stop a real Chrome.
 *
 * **It is headed on purpose, and that is not a preference.** The service sits
 * behind a Cloudflare managed challenge. A headless Chrome is held on the
 * "Just a moment..." page indefinitely; the same build, same profile, with a
 * window, clears it in about ten seconds, because the page's own Turnstile
 * widget then verifies itself the way it does for any visitor. The first probe
 * for this project spent sixty seconds proving the headless case and thirteen
 * proving the headed one.
 *
 * The profile is the other half of that: the clearance cookie lives in it, so a
 * second run skips the challenge entirely. It is this studio's own profile
 * (`.browser-profile/` by default), never the user's everyday one - this tool has
 * no business reading their history or their logins.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

export class BrowserError extends Error {
  constructor(message, { hint = '', code = 'browser' } = {}) {
    super(message);
    this.name = 'BrowserError';
    this.hint = hint;
    this.code = code;
  }

  toString() {
    return this.hint ? `${this.message} - ${this.hint}` : this.message;
  }
}

/** Every place Chrome is known to live, per platform. `CHROME_PATH` wins. */
export function findChrome(env = process.env) {
  const candidates = [
    env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** A port nothing is listening on, starting at `start`. */
export async function freePort(start = 9338, attempts = 40) {
  for (let port = start; port < start + attempts; port++) {
    const free = await new Promise((resolvePort) => {
      const server = createServer();
      server.once('error', () => resolvePort(false));
      server.once('listening', () => server.close(() => resolvePort(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new BrowserError(`no free port between ${start} and ${start + attempts}`);
}

export async function waitForJson(url, { attempts = 80, intervalMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  return null;
}

/**
 * Launch Chrome with the debugging port open and return its page target.
 *
 * `close()` stops the process and everything it spawned. It is deliberately
 * tolerant: a browser that already died is the state we wanted, not an error.
 */
export async function launchChrome({ chromePath = null, profileDir, port = null, windowSize = '1440,1000' } = {}) {
  const executable = chromePath || findChrome();
  if (!executable) {
    throw new BrowserError(
      'Google Chrome was not found',
      { hint: 'install Chrome, or point CHROME_PATH at chrome.exe', code: 'no-chrome' },
    );
  }

  const resolvedProfile = resolve(profileDir || '.browser-profile');
  mkdirSync(resolvedProfile, { recursive: true });
  const cdpPort = port || (await freePort());

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,BackForwardCache',
    '--mute-audio',
    `--window-size=${windowSize}`,
    `--user-data-dir=${resolvedProfile}`,
    `--remote-debugging-port=${cdpPort}`,
    'about:blank',
  ];

  const child = spawn(executable, args, { stdio: 'ignore', detached: false });
  const stop = () => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };
  process.once('exit', stop);

  const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`);
  if (!version) {
    stop();
    throw new BrowserError(
      'Chrome started but never opened its debugging port',
      { hint: 'another Chrome may be running with the same profile directory - close it and retry', code: 'no-port' },
    );
  }

  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    const list = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, { attempts: 1 });
    target = (list ?? []).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl) ?? null;
    if (!target) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  if (!target) {
    stop();
    throw new BrowserError('Chrome opened no page to drive', { code: 'no-target' });
  }

  return {
    child,
    port: cdpPort,
    wsUrl: target.webSocketDebuggerUrl,
    close() {
      process.removeListener('exit', stop);
      stop();
    },
  };
}
