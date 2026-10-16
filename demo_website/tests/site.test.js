'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer, readCatalog } = require('../server.js');

const catalog = readCatalog();
const tomorrow = () => {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

/**
 * Each test file gets its own server and its own bookings file, so the booking
 * tests never touch a real data/bookings.json and never share the rate limit.
 */
async function withServer(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqualux-'));
  const bookingsFile = path.join(dir, 'bookings.json');
  const server = createServer({ bookingsFile, catalog });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({ base, bookingsFile, readBookings: () => JSON.parse(fs.readFileSync(bookingsFile, 'utf8')) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const validBooking = () => ({
  name: 'Ritika Sharma',
  phone: '9820000000',
  email: 'ritika@example.com',
  date: tomorrow(),
  slot: 'sunset',
  riders: 2,
  activityIds: ['jetcar-sunset-signature'],
  notes: 'First time on a jetcar.',
});

const post = (base, body, options = {}) =>
  fetch(`${base}/api/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  });

test('serves the page with the catalog injected as inline JSON', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);

    const html = await response.text();
    assert.ok(html.includes('AQUALUX WATERSPORTS'), 'brand name is in the markup');
    assert.ok(html.includes('Shreenika Coastal Retreat'), 'venue is in the markup');

    const block = html.match(/<script type="application\/json" id="aqualux-catalog">([\s\S]*?)<\/script>/);
    assert.ok(block, 'catalog block exists');
    const injected = JSON.parse(block[1]);
    assert.equal(injected.activities.length, catalog.activities.length);
    assert.ok(injected.jetcars.some((jetcar) => jetcar.id === 'jetcar-1800'));
  });
});

test('serves static assets and refuses path traversal', async () => {
  await withServer(async ({ base }) => {
    const css = await fetch(`${base}/styles/main.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.ok((await css.text()).includes('--finish-hull'));

    const script = await fetch(`${base}/scripts/main.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const missing = await fetch(`${base}/nope.html`);
    assert.equal(missing.status, 404);

    for (const attack of ['/../server.js', '/../../data/catalog.json', '/..%2fserver.js']) {
      const response = await fetch(`${base}${attack}`);
      assert.ok([400, 404].includes(response.status), `${attack} -> ${response.status}`);
      const body = await response.text();
      assert.ok(!body.includes('createWriteQueue'), 'server source is not exposed');
    }
  });
});

test('rejects non-GET methods on static and read endpoints', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/`, { method: 'PUT' })).status, 405);
    assert.equal((await fetch(`${base}/api/catalog`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/bookings`)).status, 405, 'bookings are write-only');
  });
});

test('exposes a health probe and the catalog', async () => {
  await withServer(async ({ base }) => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);

    const remote = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(remote.brand.name, catalog.brand.name);
    assert.equal(remote.slots.length, 3);
  });
});

test('accepts a valid booking and prices it from the catalog', async () => {
  await withServer(async ({ base, readBookings }) => {
    const response = await post(base, validBooking());
    assert.equal(response.status, 201);

    const result = await response.json();
    assert.equal(result.ok, true);
    assert.match(result.reference, /^AQ-[A-Z0-9]+$/);

    const signature = catalog.activities.find((activity) => activity.id === 'jetcar-sunset-signature');
    const expectedSubtotal = signature.price * 2;
    assert.equal(result.estimate.subtotal, expectedSubtotal);
    assert.equal(result.estimate.tax, Math.round(expectedSubtotal * 0.18));
    assert.equal(result.estimate.total, expectedSubtotal + result.estimate.tax);
    assert.equal(result.booking.phone, '9820000000', 'phone is normalised before storage');

    const stored = readBookings();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].reference, result.reference);
    assert.equal(stored[0].status, 'requested');
    assert.equal(stored[0].quote.total, result.estimate.total);
  });
});

test('treats boat and group rides as a single unit', async () => {
  await withServer(async ({ base }) => {
    const payload = validBooking();
    payload.activityIds = ['speedboat-cruise', 'sunset-deck'];
    payload.riders = 6;

    const result = await (await post(base, payload)).json();
    const boat = catalog.activities.find((activity) => activity.id === 'speedboat-cruise');
    const deck = catalog.activities.find((activity) => activity.id === 'sunset-deck');
    assert.equal(result.estimate.subtotal, boat.price + deck.price);
  });
});

test('rejects a malformed booking with per-field errors', async () => {
  await withServer(async ({ base, readBookings }) => {
    const response = await post(base, {
      name: 'A',
      phone: '12345',
      email: 'not-an-email',
      date: '2020-01-01',
      slot: 'midnight',
      riders: 99,
      activityIds: ['helicopter-ride'],
      notes: 'x'.repeat(600),
    });

    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.ok, false);
    const fields = new Set(result.errors.map((error) => error.field));
    for (const field of ['name', 'phone', 'email', 'date', 'slot', 'riders', 'activityIds', 'notes']) {
      assert.ok(fields.has(field), `expected an error for ${field}`);
    }
    assert.throws(() => readBookings(), 'nothing is written for a rejected booking');
  });
});

test('enforces the per-activity rider limits', async () => {
  await withServer(async ({ base }) => {
    const payload = validBooking();
    payload.activityIds = ['jetcar-discovery'];
    payload.riders = 5;
    const result = await (await post(base, payload)).json();
    assert.ok(result.errors.some((error) => /at most 2 riders/.test(error.message)));
  });
});

test('rejects an unparseable body', async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, '{not json');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  });
});

test('rate limits a burst of booking requests', async () => {
  await withServer(async ({ base }) => {
    const payload = validBooking();
    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push((await post(base, payload)).status);
    }
    assert.equal(statuses.filter((status) => status === 201).length, 8);
    assert.equal(statuses[statuses.length - 1], 429);
  });
});
