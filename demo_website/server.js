'use strict';

/**
 * AQUALUX WATERSPORTS - demo site server.
 *
 * Zero runtime dependencies: node:http serves `public/` and owns the two live
 * endpoints the page talks to.
 *
 *   GET  /api/health    - liveness probe
 *   GET  /api/catalog   - the single source of truth for rides, prices and slots
 *   POST /api/bookings  - validated booking request, price re-computed server side
 *
 * `data/catalog.json` is injected into index.html as an inline JSON block on the
 * way out, so the page renders real content on first paint and works even if the
 * fetch to /api/catalog is blocked. Customer bookings are appended to
 * `data/bookings.json`, which is gitignored.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const TAX_RATE = 0.18;
const BOOKING_LIMIT = 8;
const BOOKING_WINDOW_MS = 10 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function readCatalog(file = CATALOG_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Serialises writes so two overlapping bookings can never clobber each other. */
function createWriteQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Local calendar day, matching what the browser's date input sends. */
function todayIso(now = new Date()) {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function normalisePhone(raw) {
  return String(raw || '').replace(/[^\d]/g, '');
}

function validateBooking(input, catalog) {
  const errors = [];
  const activities = new Map(catalog.activities.map((a) => [a.id, a]));
  const slots = new Set(catalog.slots.map((s) => s.id));

  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 80) {
    errors.push({ field: 'name', message: 'Enter the name the ride should be held under.' });
  }

  const phone = normalisePhone(input.phone);
  if (phone.length < 10 || phone.length > 15) {
    errors.push({ field: 'phone', message: 'Enter a phone number we can reach you on.' });
  } else if (phone.length === 10 && !/^[6-9]/.test(phone)) {
    errors.push({ field: 'phone', message: 'A 10 digit Indian mobile number starts with 6, 7, 8 or 9.' });
  }

  const email = String(input.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.push({ field: 'email', message: 'That email address does not look right.' });
  }

  const date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push({ field: 'date', message: 'Pick the date you want to ride.' });
  } else if (date < todayIso()) {
    errors.push({ field: 'date', message: 'That date has already passed.' });
  }

  const slot = String(input.slot || '').trim();
  if (!slots.has(slot)) {
    errors.push({ field: 'slot', message: 'Pick one of the three ride windows.' });
  }

  const riders = Number(input.riders);
  if (!Number.isInteger(riders) || riders < 1 || riders > 12) {
    errors.push({ field: 'riders', message: 'Riders must be a whole number between 1 and 12.' });
  }

  const requested = Array.isArray(input.activityIds) ? input.activityIds : [];
  const activityIds = [...new Set(requested.map((id) => String(id).trim()))].filter(Boolean);
  if (activityIds.length === 0) {
    errors.push({ field: 'activityIds', message: 'Choose at least one ride.' });
  } else if (activityIds.length > 4) {
    errors.push({ field: 'activityIds', message: 'Four rides is the most we can take in one slot.' });
  }

  const notes = String(input.notes || '').trim();
  if (notes.length > 500) {
    errors.push({ field: 'notes', message: 'Keep the note under 500 characters.' });
  }

  const lines = [];
  for (const id of activityIds) {
    const activity = activities.get(id);
    if (!activity) {
      errors.push({ field: 'activityIds', message: `We do not run "${id}".` });
      continue;
    }
    if (Number.isInteger(riders)) {
      if (riders > activity.maxRiders) {
        errors.push({
          field: 'riders',
          message: `${activity.name} takes at most ${activity.maxRiders} riders per booking.`,
        });
      } else if (riders < activity.minRiders) {
        errors.push({
          field: 'riders',
          message: `${activity.name} needs at least ${activity.minRiders} riders.`,
        });
      }
    }
    const perUnit = activity.unit === 'rider';
    const quantity = perUnit ? Math.max(1, riders || 1) : 1;
    lines.push({
      activityId: activity.id,
      name: activity.name,
      unit: activity.unit,
      quantity,
      unitPrice: activity.price,
      amount: activity.price * quantity,
    });
  }

  return { errors, value: { name, phone, email, date, slot, riders, activityIds, notes, lines } };
}

function estimate(lines) {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return {
    lines,
    subtotal,
    taxLabel: 'GST 18%',
    tax,
    total: subtotal + tax,
    currency: 'INR',
  };
}

function makeReference(now = Date.now()) {
  const stamp = now.toString(36).toUpperCase().slice(-5);
  const salt = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `AQ-${stamp}${salt}`;
}

function sendFile(req, res, filePath, { status = 200, download = false } = {}) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=600',
    'x-content-type-options': 'nosniff',
  };
  if (download) headers['content-disposition'] = `inline; filename="${path.basename(filePath)}"`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).on('error', () => res.end()).pipe(res);
}

/**
 * Puts the catalog straight into the HTML so the page is content-complete on
 * first paint, and so `file://` previews are not the only thing that degrades.
 */
function injectCatalog(html, catalog) {
  const safe = JSON.stringify(catalog).replace(/</g, '\\u003c');
  return html.replace(
    /(<script type="application\/json" id="aqualux-catalog">)[\s\S]*?(<\/script>)/,
    `$1${safe}$2`,
  );
}

function createServer(options = {}) {
  const publicDir = options.publicDir || PUBLIC_DIR;
  const bookingsFile = options.bookingsFile || BOOKINGS_FILE;
  const catalog = options.catalog || readCatalog(options.catalogFile || CATALOG_FILE);
  const enqueueWrite = createWriteQueue();
  const hits = new Map();

  function throttled(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((ts) => now - ts < BOOKING_WINDOW_MS);
    if (recent.length >= BOOKING_LIMIT) {
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    return false;
  }

  async function handleBooking(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      json(res, error.status || 400, {
        ok: false,
        errors: [{ field: 'form', message: 'We could not read that request.' }],
      });
      return;
    }

    const { errors, value } = validateBooking(payload, catalog);
    if (errors.length) {
      json(res, 400, { ok: false, errors });
      return;
    }

    const quote = estimate(value.lines);
    const booking = {
      reference: makeReference(),
      receivedAt: new Date().toISOString(),
      name: value.name,
      phone: value.phone,
      email: value.email,
      date: value.date,
      slot: value.slot,
      riders: value.riders,
      activities: value.activityIds,
      notes: value.notes,
      quote: { subtotal: quote.subtotal, tax: quote.tax, total: quote.total, currency: quote.currency },
      status: 'requested',
    };

    try {
      await enqueueWrite(async () => {
        await fsp.mkdir(path.dirname(bookingsFile), { recursive: true });
        let existing = [];
        try {
          existing = JSON.parse(await fsp.readFile(bookingsFile, 'utf8'));
          if (!Array.isArray(existing)) existing = [];
        } catch {
          existing = [];
        }
        existing.push(booking);
        const tmp = `${bookingsFile}.tmp`;
        await fsp.writeFile(tmp, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
        await fsp.rename(tmp, bookingsFile);
      });
    } catch {
      json(res, 500, {
        ok: false,
        errors: [{ field: 'form', message: 'We could not save that booking. Please call or WhatsApp us.' }],
      });
      return;
    }

    json(res, 201, { ok: true, reference: booking.reference, booking, estimate: quote });
  }

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      json(res, 400, { ok: false, errors: [{ field: 'form', message: 'Bad request URL.' }] });
      return;
    }

    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      json(res, 200, { ok: true, service: 'aqualux-watersports', uptime: process.uptime() });
      return;
    }

    if (pathname === '/api/catalog') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      json(res, 200, catalog);
      return;
    }

    if (pathname === '/api/bookings') {
      if (req.method !== 'POST') {
        // Confirmed bookings hold guest phone numbers, so the collection is write-only.
        json(res, 405, { ok: false, error: 'bookings are write-only; POST to request a ride' });
        return;
      }
      const ip = req.socket.remoteAddress || 'unknown';
      if (throttled(ip)) {
        json(res, 429, {
          ok: false,
          errors: [{ field: 'form', message: 'Too many booking requests. Try again in a few minutes.' }],
        });
        return;
      }
      await handleBooking(req, res);
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(res, 404, { ok: false, error: 'unknown endpoint' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, relative);
    const insidePublic = filePath === publicDir || filePath.startsWith(publicDir + path.sep);

    if (!insidePublic || relative.includes('\0')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request');
      return;
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      stat = null;
    }

    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    if (path.basename(filePath) === 'index.html') {
      const html = injectCatalog(await fsp.readFile(filePath, 'utf8'), catalog);
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    sendFile(req, res, filePath);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`AQUALUX WATERSPORTS running at http://localhost:${PORT}`);
    console.log(`  venue: ${readCatalog().brand.venue}, ${readCatalog().brand.beach}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

module.exports = { createServer, readCatalog, validateBooking, estimate, PUBLIC_DIR, DATA_DIR };
