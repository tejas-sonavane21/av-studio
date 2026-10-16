/**
 * Browser check for the Aqualux site.
 *
 * Unit tests cover the server; this covers the part only a browser can: the
 * inline SVG preview, the selection store wiring the configurator to the form,
 * the reveal observers, the theme switch and the real booking POST.
 *
 * It drives Chrome over the DevTools protocol with Node's built-in WebSocket,
 * so it needs no npm packages. Console errors from our own scripts fail the
 * run; a blocked Google Fonts request is only reported as a warning.
 *
 *   node tools/browser-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer } = require('../server.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const failures = [];
const warnings = [];
const consoleErrors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
};

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitForDevtools(userDataDir, timeoutMs = 20000) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
      if (port) return Number(port);
    }
    await sleep(120);
  }
  throw new Error('Chrome never reported a DevTools port');
}

/** Minimal CDP client: send(method, params) plus event subscription. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      (this.handlers.get(message.method) || []).forEach((handler) => handler(message.params));
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
    });
    return new Session(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(event, handler) {
    this.handlers.set(event, [...(this.handlers.get(event) || []), handler]);
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return result.result.value;
  }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('Chrome not found. Set CHROME_PATH to run the browser check.');
    process.exit(0);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqualux-chrome-'));
  const bookingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqualux-bookings-'));
  const bookingsFile = path.join(bookingsDir, 'bookings.json');

  const server = createServer({ bookingsFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let session;
  try {
    const port = await waitForDevtools(userDataDir);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    session = await Session.connect(page.webSocketDebuggerUrl);

    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return;
      const text = params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (params.type === 'error') consoleErrors.push(text);
      else warnings.push(text);
    });
    session.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description || 'uncaught exception');
    });
    session.on('Log.entryAdded', (params) => {
      const { level, text, url = '' } = params.entry;
      if (level !== 'error') return;
      if (/fonts\.(googleapis|gstatic)\.com/.test(url)) {
        warnings.push(`external font blocked (${text})`);
        return;
      }
      consoleErrors.push(`${text} ${url}`.trim());
    });

    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    await session.send('Page.navigate', { url: `${base}/` });
    for (let i = 0; i < 60; i += 1) {
      await sleep(120);
      const ready = await session.eval('document.readyState');
      if (ready === 'complete') break;
    }
    await sleep(1600); // let the modules boot and the preloader clear

    console.log('\nRendering');
    const render = await session.eval(`(() => {
      const count = (selector) => document.querySelectorAll(selector).length;
      const preloader = document.querySelector('[data-preloader]');
      return {
        title: document.title,
        h1: document.querySelector('h1')?.innerText.replace(/\\s+/g, ' ').trim(),
        rides: count('[data-activity]'),
        models: count('[data-model-index]'),
        finishes: count('[data-finish-index]'),
        slots: count('.slot-card'),
        packages: count('.package-card'),
        faqs: count('[data-acc-item]'),
        slides: count('.review__slide'),
        picks: count('[data-pick]'),
        slotOptions: document.querySelectorAll('[data-slot-select] option').length,
        boundPhone: document.querySelector('[data-bind="brand.phoneDisplay"]')?.textContent.trim(),
        preloaderHidden: preloader?.hidden === true || getComputedStyle(preloader).opacity === '0',
        marqueeGroups: count('[data-marquee] > *'),
        contact: document.querySelector('[data-href-check]') ? true : true,
      };
    })()`);

    check('page title names the brand', /AQUALUX WATERSPORTS/.test(render.title), render.title);
    check('hero headline is present', /AQUALUX\s+WATERSPORTS/i.test(render.h1 || ''), render.h1);
    check('every ride from the catalog is rendered', render.rides === 10, `${render.rides} cards`);
    check('three jetcar models', render.models === 3, String(render.models));
    check('five finishes', render.finishes === 5, String(render.finishes));
    check('three ride windows', render.slots === 3, String(render.slots));
    check('three packages', render.packages === 3, String(render.packages));
    check('FAQ list is built', render.faqs === 7, String(render.faqs));
    check('review slides are built', render.slides === 3, String(render.slides));
    check('booking pick list mirrors the catalog', render.picks === 10, String(render.picks));
    check('ride windows are in the form', render.slotOptions === 4, String(render.slotOptions));
    check('brand details are bound from the catalog', /\+91/.test(render.boundPhone || ''), render.boundPhone);
    check('preloader clears itself', render.preloaderHidden === true);
    check('marquee is cloned for a seamless loop', render.marqueeGroups === 2, String(render.marqueeGroups));

    console.log('\nLayout');
    const layout = await session.eval(`(() => {
      const overflow = () => document.documentElement.scrollWidth - window.innerWidth;
      const heroGrid = getComputedStyle(document.querySelector('.hero__grid')).gridTemplateColumns;
      const nav = getComputedStyle(document.querySelector('.site-nav')).display;
      const burger = getComputedStyle(document.querySelector('.burger')).display;
      return { overflow: overflow(), heroColumns: heroGrid.split(' ').length, nav, burger, width: window.innerWidth };
    })()`);
    check('desktop has no horizontal overflow', layout.overflow <= 1, `${layout.overflow}px`);
    check('hero is a two column grid on desktop', layout.heroColumns === 2, layout.heroColumns + ' columns');
    check('desktop shows the section nav', layout.nav !== 'none');

    console.log('\nInteractions');
    const afterAdd = await session.eval(`(() => {
      const card = document.querySelector('[data-activity="jetcar-turbo-tandem"]');
      card.querySelector('[data-add-ride]').click();
      const pick = document.querySelector('[data-pick][value="jetcar-turbo-tandem"]');
      return {
        selected: card.classList.contains('is-selected'),
        pickChecked: pick.checked,
        buttonLabel: card.querySelector('[data-add-ride]').textContent.trim(),
        total: document.querySelector('[data-quote-total]').textContent.trim(),
        lines: document.querySelectorAll('.quote-line').length,
      };
    })()`);
    check('adding a ride selects the card', afterAdd.selected === true);
    check('the matching booking checkbox ticks itself', afterAdd.pickChecked === true);
    check('the button switches to Added', afterAdd.buttonLabel === 'Added', afterAdd.buttonLabel);
    check('the live estimate updates', /[1-9]/.test(afterAdd.total), afterAdd.total);
    check('the estimate lists the ride', afterAdd.lines === 1, String(afterAdd.lines));

    const afterModel = await session.eval(`(() => {
      const before = document.querySelector('[data-config-price]').textContent.trim();
      document.querySelector('[data-model-index="2"]').click();
      const stage = document.querySelector('[data-finish-target]');
      const after = document.querySelector('[data-config-price]').textContent.trim();
      document.querySelector('[data-finish-index="3"]').click();
      return {
        before,
        after,
        name: document.querySelector('[data-config-name]').textContent.trim(),
        finish: document.querySelector('[data-config-finish-name]').textContent.trim(),
        hull: getComputedStyle(stage).getPropertyValue('--finish-hull').trim(),
        specs: document.querySelectorAll('[data-spec-list] dd').length,
        highlights: document.querySelectorAll('[data-highlight-list] li').length,
        checkedModels: document.querySelectorAll('[data-model-index][aria-checked="true"]').length,
      };
    })()`);
    check('choosing a model changes the price', afterModel.before !== afterModel.after, `${afterModel.before} -> ${afterModel.after}`);
    check('the preview names the selected model', /GT SIGNATURE/.test(afterModel.name), afterModel.name);
    check('choosing a finish repaints the SVG', afterModel.hull === '#0b2233', afterModel.hull);
    check('the finish name follows the swatch', afterModel.finish === 'Midnight Abyss', afterModel.finish);
    check('specs are rendered', afterModel.specs === 4, String(afterModel.specs));
    check('highlights are rendered', afterModel.highlights >= 3, String(afterModel.highlights));
    check('exactly one model is checked', afterModel.checkedModels === 1, String(afterModel.checkedModels));

    const afterReserve = await session.eval(`(async () => {
      document.querySelector('[data-config-reserve]').click();
      await new Promise((resolve) => setTimeout(resolve, 1500)); // the scroll is animated
      const pick = document.querySelector('[data-pick][value="jetcar-sunset-signature"]');
      return {
        picked: pick.checked,
        lines: document.querySelectorAll('.quote-line').length,
        scrolled: window.scrollY > 600,
      };
    })()`);
    check('reserving a jetcar preselects its ride', afterReserve.picked === true);
    check('the estimate is replaced, not appended', afterReserve.lines === 1, String(afterReserve.lines));
    check('reserving scrolls to the booking form', afterReserve.scrolled === true);

    const afterFaq = await session.eval(`(async () => {
      const button = document.querySelector('.acc-item__button');
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 700)); // the panel animates open
      const panel = document.querySelector('.acc-item__panel');
      const closed = document.querySelectorAll('.acc-item__button[aria-expanded="false"]').length;
      return {
        expanded: button.getAttribute('aria-expanded'),
        height: panel.getBoundingClientRect().height,
        othersClosed: closed === document.querySelectorAll('.acc-item').length - 1,
      };
    })()`);
    check('the accordion opens', afterFaq.expanded === 'true');
    check('the open panel has height', afterFaq.height > 20, `${afterFaq.height}px`);
    check('only one FAQ stays open', afterFaq.othersClosed === true);

    const afterLightbox = await session.eval(`(() => {
      document.querySelector('[data-gallery]').click();
      const lightbox = document.querySelector('[data-lightbox]');
      const opened = { hidden: lightbox.hidden, caption: document.querySelector('[data-lightbox-caption]').textContent };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return { opened, closed: lightbox.hidden, locked: document.body.classList.contains('is-locked') };
    })()`);
    check('the lightbox opens from a gallery tile', afterLightbox.opened.hidden === false);
    check('the lightbox has a caption', (afterLightbox.opened.caption || '').length > 10, afterLightbox.opened.caption);
    check('Escape closes the lightbox', afterLightbox.closed === true);
    check('the body unlocks after closing', afterLightbox.locked === false);

    const afterTheme = await session.eval(`(() => {
      const root = document.documentElement;
      const before = root.dataset.theme;
      document.querySelector('[data-theme-toggle]').click();
      const after = root.dataset.theme;
      const stored = window.localStorage.getItem('aqualux:theme');
      document.querySelector('[data-theme-toggle]').click();
      return { before, after, stored, restored: root.dataset.theme };
    })()`);
    check('the theme toggle switches palettes', afterTheme.before !== afterTheme.after, `${afterTheme.before} -> ${afterTheme.after}`);
    check('the theme choice is remembered', afterTheme.stored === afterTheme.after, String(afterTheme.stored));
    check('the toggle returns to day water', afterTheme.restored === afterTheme.before);

    console.log('\nIllustration');
    const art = await session.eval(`(() => {
      const svg = document.querySelector('.hero__stage .jetcar__svg');
      const box = (selector) => {
        const node = svg.querySelector(selector);
        if (!node) return null;
        const b = node.getBBox();
        return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) };
      };
      return {
        viewBox: svg.getAttribute('viewBox'),
        hull: box('.jetcar__hull'),
        stripe: box('.jetcar__stripe'),
        seat: box('.jetcar__seat'),
        wordmark: box('.jetcar__wordmark'),
        waves: svg.querySelectorAll('.jetcar__water .wave').length,
        sprays: svg.querySelectorAll('.spray').length,
      };
    })()`);
    check('the jetcar hull spans the frame', (art.hull?.w || 0) > 400 && (art.hull?.h || 0) > 60, JSON.stringify(art.hull));
    check('the hull colour band sits on the hull', (art.stripe?.w || 0) > 200 && art.stripe.y > art.hull.y && art.stripe.y < art.hull.y + art.hull.h);
    check('the seat is drawn above the hull', art.seat.y < art.stripe.y, JSON.stringify(art.seat));
    check('the wordmark stays inside the frame', (art.wordmark?.w || 0) > 40 && art.wordmark.x > 0 && art.wordmark.x + art.wordmark.w < 680);
    check('the water and spray are drawn', art.waves === 3 && art.sprays === 3, `${art.waves} waves, ${art.sprays} sprays`);

    console.log('\nScroll behaviour');
    // Park at each section the way a reader would and confirm nothing that is on
    // screen is still stuck at opacity 0.
    const afterScroll = await session.eval(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const stranded = () => [...document.querySelectorAll('[data-reveal]')]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          const onScreen = rect.bottom > 60 && rect.top < window.innerHeight - 60;
          return onScreen && !node.classList.contains('is-visible');
        })
        .map((node) => node.className || node.tagName);

      const problems = [];
      let progressMid = null;
      for (const stop of ['#jetcars', '#rides', '#gallery', '#pricing', '#reviews', '#location', '#book', '#faq']) {
        document.querySelector(stop)?.scrollIntoView({ block: 'center' });
        await wait(650);
        problems.push(...stranded());
        if (stop === '#pricing') progressMid = document.querySelector('[data-scroll-bar]').style.transform;
      }
      window.scrollTo(0, document.body.scrollHeight);
      await wait(900);

      const stats = [...document.querySelectorAll('.stat__value')].map((node) => node.textContent.trim());
      return {
        stats,
        stranded: [...new Set(problems)],
        reveals: document.querySelectorAll('[data-reveal]').length,
        visible: document.querySelectorAll('[data-reveal].is-visible').length,
        stuck: document.querySelector('[data-header]').classList.contains('is-stuck'),
        progressMid,
        progress: document.querySelector('[data-scroll-bar]').style.transform,
        toTop: document.querySelector('[data-to-top]').hidden,
        activeLinks: document.querySelectorAll('.site-nav a.is-active').length,
      };
    })()`);
    check('counters animate to their catalog values', afterScroll.stats[0].includes('2,400'), afterScroll.stats.join(' | '));
    check('the rating counter keeps its decimal', afterScroll.stats[3].includes('4.9'), afterScroll.stats[3]);
    check('no reveal is left stuck at zero opacity while on screen', afterScroll.stranded.length === 0, afterScroll.stranded.join(' | '));
    check('reveals fire as the reader moves down the page', afterScroll.visible > afterScroll.reveals / 2, `${afterScroll.visible}/${afterScroll.reveals}`);
    check('the header gains its stuck state', afterScroll.stuck === true);
    check('the scroll progress bar tracks the middle of the page', /scaleX\(0\.[1-9]/.test(afterScroll.progressMid || ''), String(afterScroll.progressMid));
    check('the scroll progress bar completes at the bottom', /scaleX\(1\)/.test(afterScroll.progress), afterScroll.progress);
    check('the back to top button appears', afterScroll.toTop === false);
    check('the active section link is tracked', afterScroll.activeLinks === 1, String(afterScroll.activeLinks));

    console.log('\nBooking flow');
    const afterSubmit = await session.eval(`(async () => {
      const form = document.querySelector('[data-booking-form]');
      const set = (name, value) => {
        const field = form.querySelector('[name="' + name + '"]');
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('name', 'Browser Check');
      set('phone', '9820000000');
      set('email', 'check@example.com');
      set('riders', '2');
      set('slot', 'sunset');
      set('notes', 'Automated check.');
      const date = form.querySelector('[name="date"]').value;
      form.requestSubmit();
      const started = Date.now();
      while (Date.now() - started < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!document.querySelector('[data-booking-success]').hidden) break;
      }
      const success = document.querySelector('[data-booking-success]');
      return {
        date,
        hidden: success.hidden,
        reference: document.querySelector('[data-success-ref]').textContent.trim(),
        summary: document.querySelector('[data-success-summary]').textContent.trim(),
        whatsapp: document.querySelector('[data-success-whatsapp]').getAttribute('href'),
        formHidden: form.hidden,
      };
    })()`);
    check('a valid booking submits and shows the success panel', afterSubmit.hidden === false);
    check('the success panel shows a reference', /^AQ-[A-Z0-9]+$/.test(afterSubmit.reference), afterSubmit.reference);
    check('the summary restates the slot', /sunset/i.test(afterSubmit.summary), afterSubmit.summary.slice(0, 90));
    check('a WhatsApp handoff link is built', /^https:\/\/wa\.me\/\d+\?text=/.test(afterSubmit.whatsapp || ''), afterSubmit.whatsapp);
    check('the form is replaced by the confirmation', afterSubmit.formHidden === true);

    const stored = fs.existsSync(bookingsFile) ? JSON.parse(fs.readFileSync(bookingsFile, 'utf8')) : [];
    check('the booking reached the server store', stored.length === 1, `${stored.length} stored`);
    check('the stored booking keeps the reference', stored[0]?.reference === afterSubmit.reference);
    check('the server priced the booking itself', stored[0]?.quote?.total === stored[0]?.quote?.subtotal + stored[0]?.quote?.tax);

    const afterInvalid = await session.eval(`(async () => {
      document.querySelector('[data-booking-again]').click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const form = document.querySelector('[data-booking-form]');
      form.querySelector('[name="name"]').value = 'A';
      form.querySelector('[name="phone"]').value = '12345';
      form.querySelector('[name="riders"]').value = '99';
      form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        name: document.querySelector('[data-error-for="name"]').textContent.trim(),
        phone: document.querySelector('[data-error-for="phone"]').textContent.trim(),
        summaryVisible: document.querySelector('[data-form-error]').hidden === false,
        marked: document.querySelectorAll('.field.has-error, .fieldset.has-error').length,
        formVisible: form.hidden === false,
      };
    })()`);
    check('client validation flags the name', /name/i.test(afterInvalid.name), afterInvalid.name);
    check('client validation flags the phone', /phone|mobile/i.test(afterInvalid.phone), afterInvalid.phone);
    check('an error summary is shown', afterInvalid.summaryVisible === true);
    check('invalid fields are marked', afterInvalid.marked >= 2, String(afterInvalid.marked));
    check('the form comes back for another booking', afterInvalid.formVisible === true);

    console.log('\nResponsive');
    for (const [width, height, mobile] of [[900, 800, false], [390, 844, true], [1440, 900, false]]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await sleep(500);
      const view = await session.eval(`(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        nav: getComputedStyle(document.querySelector('.site-nav')).display,
        burger: getComputedStyle(document.querySelector('.burger')).display,
        columns: getComputedStyle(document.querySelector('.hero__grid')).gridTemplateColumns.split(' ').length,
      }))()`);
      check(`${width}px has no horizontal overflow`, view.overflow <= 1, `${view.overflow}px`);
      if (width <= 900) {
        check(`${width}px collapses to the burger menu`, view.nav === 'none' && view.burger !== 'none');
        check(`${width}px stacks the hero`, view.columns === 1, `${view.columns} columns`);
      } else {
        check(`${width}px keeps the desktop nav`, view.nav !== 'none');
      }
    }

    console.log('\nConsole');
    const relevantErrors = consoleErrors.filter((text) => !/favicon|ERR_ABORTED/.test(text));
    check('no console errors from the page', relevantErrors.length === 0, relevantErrors.slice(0, 4).join(' | '));

    if (warnings.length) {
      console.log(`\nWarnings (not failures): ${warnings.length}`);
      warnings.slice(0, 5).forEach((warning) => console.log(`  - ${warning}`));
    }
  } finally {
    session?.socket?.close?.();
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, sleep(4000)]);
    await new Promise((resolve) => server.close(resolve));
    // Windows keeps the profile locked for a moment after the process dies.
    for (const dir of [userDataDir, bookingsDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch (error) {
        warnings.push(`could not remove temp dir ${path.basename(dir)} (${error.code})`);
      }
    }
  }

  console.log('\n---------------------------------------');
  if (failures.length) {
    console.log(`${failures.length} check(s) failed:`);
    failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(1);
  }
  console.log('All browser checks passed.');
}

main().catch((error) => {
  console.error('Browser check crashed:', error);
  process.exit(1);
});
