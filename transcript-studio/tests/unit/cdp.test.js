import test from 'node:test';
import assert from 'node:assert/strict';

import { CdpError, connect, evaluate } from '../../src/browser/cdp.js';

/**
 * The smallest WebSocket the client needs: a listener table, a queue of sent
 * frames, and `emit` for the replies a real browser would send.
 */
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ handler, once: Boolean(options.once) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.emit('close', {});
  }

  emit(type, event) {
    const entries = [...(this.listeners.get(type) ?? [])];
    for (const entry of entries) {
      if (entry.once) {
        const list = this.listeners.get(type);
        const index = list.indexOf(entry);
        if (index !== -1) list.splice(index, 1);
      }
      entry.handler(event);
    }
  }

  reply(message) {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

const originalWebSocket = globalThis.WebSocket;

test.beforeEach(() => {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket;
});

test.afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

test('a request is matched to its reply by id', async () => {
  const cdp = await connect('ws://test');
  const socket = FakeSocket.instances[0];
  const pending = cdp.send('Runtime.enable');
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].method, 'Runtime.enable');
  socket.reply({ id: socket.sent[0].id, result: { ok: true } });
  assert.deepEqual(await pending, { id: socket.sent[0].id, result: { ok: true } });
});

test('a protocol error rejects the request that caused it', async () => {
  const cdp = await connect('ws://test');
  const socket = FakeSocket.instances[0];
  const pending = cdp.send('DOM.getDocument');
  socket.reply({ id: socket.sent[0].id, error: { message: 'no such node' } });
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof CdpError);
    assert.match(error.message, /no such node/);
    return true;
  });
});

test('a call that never answers times out instead of hanging', async () => {
  const cdp = await connect('ws://test');
  await assert.rejects(cdp.send('Page.navigate', {}, { timeoutMs: 20 }), /did not answer/);
});

test('events reach listeners, and one throwing listener does not stop the next', async () => {
  const cdp = await connect('ws://test', { onListenerError: () => {} });
  const socket = FakeSocket.instances[0];
  const seen = [];
  cdp.on(() => {
    throw new Error('bad listener');
  });
  cdp.on((message) => seen.push(message.method));
  socket.reply({ method: 'Network.responseReceived', params: { response: { url: 'x' } } });
  assert.deepEqual(seen, ['Network.responseReceived']);
});

test('closing the socket rejects everything still waiting', async () => {
  const cdp = await connect('ws://test');
  const socket = FakeSocket.instances[0];
  const pending = cdp.send('Page.enable');
  socket.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(cdp.send('Page.enable'), /closed/);
});

test('evaluate returns a value, and a page exception as data', async () => {
  const cdp = await connect('ws://test');
  const socket = FakeSocket.instances[0];

  const ok = evaluate(cdp, '1 + 1');
  assert.equal(socket.sent[0].params.awaitPromise, false);
  socket.reply({ id: socket.sent[0].id, result: { result: { value: 2 } } });
  assert.deepEqual(await ok, { value: 2 });

  const failed = evaluate(cdp, 'throw new Error("nope")');
  socket.reply({
    id: socket.sent[1].id,
    result: { exceptionDetails: { exception: { description: 'Error: nope' } } },
  });
  assert.deepEqual(await failed, { error: 'Error: nope' });
});
