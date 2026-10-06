import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_BODY_BYTES, MAX_STORED_DELIVERIES, RelayStore } from '../src/relay/core.js';
import { nodeSql, startRelayServer } from '../src/relay/node.js';
import { newToken, tempDir } from './helpers.js';

const KEY = 'relay-key-for-tests';
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const { dir, cleanup } = tempDir();
  const logs: string[] = [];
  const dbPath = join(dir, 'relay.db');
  let relay = await startRelayServer({ dbPath, key: KEY, port: 0, now: () => NOW, log: (l) => logs.push(l) });
  t.after(async () => {
    await relay.close();
    cleanup();
  });
  const control = (method: string, path: string, body?: unknown, key = KEY) =>
    fetch(`${relay.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const register = async (state: 'pending' | 'confirmed' = 'confirmed') => {
    const token = newToken();
    assert.equal((await control('PUT', `/relay/paths/${token}`, { state })).status, 204);
    return token;
  };
  const hook = (token: string, body: string | Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    fetch(`${relay.url}/hooks/${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_1',
        'webhook-timestamp': String(NOW / 1000),
        'webhook-signature': 'v1,c2ln',
        'x-mcp-subscription-id': 'sub_1',
        ...headers,
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
  const fetched = async () => (await (await control('GET', '/relay/deliveries')).json()) as {
    deliveries: Array<{ seq: number; token: string; receivedAt: number; headers: Record<string, string>; body: string }>;
    more: boolean;
  };
  return {
    logs,
    control,
    register,
    hook,
    fetched,
    async restart() {
      await relay.close();
      relay = await startRelayServer({ dbPath, key: KEY, port: 0, now: () => NOW, log: (l) => logs.push(l) });
    },
  };
}

test('control endpoints need the relay key', async (t) => {
  const r = await setup(t);
  assert.equal((await r.control('GET', '/relay/deliveries', undefined, 'wrong')).status, 401);
  const res = await fetch(`${(await r.control('GET', '/relay/deliveries')).url}`);
  assert.equal(res.status, 401, 'no key');
  assert.equal((await r.control('PUT', '/relay/paths/short', { state: 'pending' })).status, 400, 'token too short');
  assert.equal((await r.control('PUT', `/relay/paths/${newToken()}`, { state: 'odd' })).status, 400);
  assert.equal((await r.control('POST', '/relay/ack', { upTo: 'x' })).status, 400);
});

test('unregistered path: 404 for events and for verification', async (t) => {
  const r = await setup(t);
  const token = newToken();
  assert.equal((await r.hook(token, '{"eventId":"e"}')).status, 404);
  assert.equal((await r.hook(token, '{"type":"verification","challenge":"c"}')).status, 404);
  assert.equal((await fetch(`${(await r.hook(token, '{}')).url.replace(/\/hooks\/.*/, '/')}`)).status, 404);
});

test('pending path: verification is echoed, events get 503', async (t) => {
  const r = await setup(t);
  const token = await r.register('pending');
  const res = await r.hook(token, '{"type":"verification","challenge":"nonce-1"}', { 'webhook-id': 'msg_verification_1' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge: 'nonce-1' });
  assert.equal((await r.hook(token, '{"eventId":"evt_1"}')).status, 503);
  assert.deepEqual((await r.fetched()).deliveries, [], 'nothing stored');
});

test('confirmed path: stored as received (raw bytes, headers, receive time), then fetched and acknowledged', async (t) => {
  const r = await setup(t);
  const token = await r.register('confirmed');
  const raw = Buffer.from('{ "eventId":"evt_1", "data": {"é": 1} }\n');
  assert.equal((await r.hook(token, raw)).status, 200);
  const res = await r.hook(token, '{"type":"verification","challenge":"again"}');
  assert.deepEqual(await res.json(), { challenge: 'again' }, 'still echoed once confirmed (re-verification)');

  const { deliveries, more } = await r.fetched();
  assert.equal(more, false);
  assert.equal(deliveries.length, 1);
  const d = deliveries[0]!;
  assert.equal(d.token, token);
  assert.equal(d.receivedAt, NOW);
  assert.deepEqual(d.headers, {
    'webhook-id': 'evt_1',
    'webhook-timestamp': String(NOW / 1000),
    'webhook-signature': 'v1,c2ln',
    'x-mcp-subscription-id': 'sub_1',
  });
  assert.deepEqual(Buffer.from(d.body, 'base64'), raw);

  assert.equal((await r.control('POST', '/relay/ack', { upTo: d.seq })).status, 204);
  assert.deepEqual((await r.fetched()).deliveries, []);
});

test('missing required header: 400; body over 256 KiB: 413 by Content-Length or while streaming; exactly 256 KiB: 200', async (t) => {
  const r = await setup(t);
  const token = await r.register();
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']) {
    assert.equal((await r.hook(token, '{}', { [name]: '' })).status, 400, name);
  }
  assert.equal((await r.hook(token, new Uint8Array(MAX_BODY_BYTES + 1))).status, 413);
  // No Content-Length: a chunked upload that keeps going past the limit.
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(64 * 1024 + 1));
      controller.close();
    },
  });
  assert.equal((await r.hook(token, chunked)).status, 413);
  assert.equal((await r.hook(token, new Uint8Array(MAX_BODY_BYTES))).status, 200);
  assert.equal((await r.fetched()).deliveries.length, 1);
});

test('fetching is batched by count and by bytes', async (t) => {
  const r = await setup(t);
  const token = await r.register();
  for (let i = 0; i < 25; i++) assert.equal((await r.hook(token, `{"n":${i}}`, { 'webhook-id': `evt_${i}` })).status, 200);
  let batch = await r.fetched();
  assert.equal(batch.deliveries.length, 20);
  assert.equal(batch.more, true);
  await r.control('POST', '/relay/ack', { upTo: batch.deliveries.at(-1)!.seq });
  batch = await r.fetched();
  assert.deepEqual(
    batch.deliveries.map((d) => d.headers['webhook-id']),
    ['evt_20', 'evt_21', 'evt_22', 'evt_23', 'evt_24'],
  );
  assert.equal(batch.more, false);
  await r.control('POST', '/relay/ack', { upTo: batch.deliveries.at(-1)!.seq });

  for (let i = 0; i < 3; i++) await r.hook(token, new Uint8Array(200 * 1024), { 'webhook-id': `big_${i}` });
  batch = await r.fetched();
  assert.equal(batch.deliveries.length, 2, '400 KiB fits under the 512 KiB batch, 600 KiB does not');
  assert.equal(batch.more, true);
});

test('deleting a path drops what was stored for it; stored deliveries survive a relay restart', async (t) => {
  const r = await setup(t);
  const keep = await r.register();
  const drop = await r.register();
  await r.hook(keep, '{"k":1}', { 'webhook-id': 'keep' });
  await r.hook(drop, '{"d":1}', { 'webhook-id': 'drop' });
  assert.equal((await r.control('DELETE', `/relay/paths/${drop}`)).status, 204);
  assert.equal((await r.hook(drop, '{"d":2}')).status, 404);
  await r.restart();
  assert.deepEqual(
    (await r.fetched()).deliveries.map((d) => d.headers['webhook-id']),
    ['keep'],
  );
});

test('storage cap: 503 once the stored count is reached, room again after an ack', () => {
  const sql = nodeSql(':memory:');
  try {
    const store = new RelayStore(sql);
    store.setPath('tok', 'confirmed');
    const body = new Uint8Array(1);
    let last = 0;
    for (let i = 0; i < MAX_STORED_DELIVERIES; i++) last = store.insert('tok', 0, {}, body) as number;
    assert.equal(store.insert('tok', 0, {}, body), 'full');
    store.ackUpTo(last);
    assert.equal(typeof store.insert('tok', 0, {}, body), 'number');
  } finally {
    sql.close();
  }
});

test('logs carry neither the key nor bodies nor full path tokens', async (t) => {
  const r = await setup(t);
  const token = await r.register();
  await r.hook(token, '{"secret-marker":"BODY-7f3a"}');
  await r.control('GET', '/relay/deliveries');
  assert.ok(r.logs.length >= 3);
  for (const line of r.logs) {
    assert.ok(!line.includes(KEY), line);
    assert.ok(!line.includes('BODY-7f3a'), line);
    assert.ok(!line.includes(token), line);
  }
});
