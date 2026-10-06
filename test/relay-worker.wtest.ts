// The Cloudflare Worker relay (relay-worker/) under `wrangler dev --local`: the behaviour checks of
// relay.test.ts, against a Worker and its SQLite Durable Object instead of the Node server.
// Run with `npm run test:worker`. One wrangler process serves all tests (a start takes seconds),
// so tests run in order and each clears what earlier ones left stored.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MAX_BODY_BYTES } from '../src/relay/core.js';
import { newToken, rawHook } from './helpers.js';
import { startWorkerRelay, type WorkerRelay } from './worker-relay.js';

const KEY = 'relay-key-for-worker-tests';
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

const dir = mkdtempSync(join(tmpdir(), 'evdock-test-'));
const persistDir = join(dir, 'wrangler-state');
let relay: WorkerRelay;
let earlierOutput = '';

before(async () => {
  relay = await startWorkerRelay({ key: KEY, persistDir });
});

after(async () => {
  await relay?.close();
  // Retried: Windows can hold on to the SQLite files of the just-killed workerd for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 10 });
});

const output = () => earlierOutput + relay.output();

async function restart() {
  await relay.close();
  earlierOutput += relay.output();
  relay = await startWorkerRelay({ key: KEY, persistDir });
}

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const control = (method: string, path: string, body?: unknown, key = KEY) =>
  fetch(`${relay.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function register(state: 'pending' | 'confirmed' = 'confirmed') {
  const token = newToken();
  assert.equal((await control('PUT', `/relay/paths/${token}`, { state })).status, 204);
  return token;
}

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

async function fetched() {
  return (await (await control('GET', '/relay/deliveries')).json()) as {
    deliveries: Array<{ seq: number; token: string; receivedAt: number; headers: Record<string, string>; body: string }>;
    more: boolean;
  };
}

/** Acknowledges whatever earlier tests left stored. */
async function drain() {
  for (;;) {
    const { deliveries } = await fetched();
    if (deliveries.length === 0) return;
    assert.equal((await control('POST', '/relay/ack', { upTo: deliveries.at(-1)!.seq })).status, 204);
  }
}

// wrangler dev only: when the Worker answers before reading the whole body (the 413s), wrangler's
// local proxy drops both connections that carried the request, and the next request over either
// one fails (ECONNRESET here, or a 500 from its ProxyWorker for a POST; it retries GETs). Two GETs
// use those connections up. The proxy is part of wrangler dev, not of a deployed Worker.
async function clearDroppedConnections() {
  for (let i = 0; i < 2; i++) await fetch(`${relay.url}/relay/deliveries`).catch(() => {});
}

test('control endpoints need the relay key', async () => {
  assert.equal((await control('GET', '/relay/deliveries', undefined, 'wrong')).status, 401);
  assert.equal((await fetch(`${relay.url}/relay/deliveries`)).status, 401, 'no key');
  assert.equal((await control('PUT', '/relay/paths/short', { state: 'pending' })).status, 400, 'token too short');
  assert.equal((await control('PUT', `/relay/paths/${newToken()}`, { state: 'odd' })).status, 400);
  assert.equal((await control('POST', '/relay/ack', { upTo: 'x' })).status, 400);
});

test('unregistered path: 404 for events and for verification', async () => {
  const token = newToken();
  assert.equal((await hook(token, '{"eventId":"e"}')).status, 404);
  assert.equal((await hook(token, '{"type":"verification","challenge":"c"}')).status, 404);
  assert.equal((await fetch(`${relay.url}/`)).status, 404);
});

test('pending path: verification is echoed, events get 503', async () => {
  await drain();
  const token = await register('pending');
  const res = await hook(token, '{"type":"verification","challenge":"nonce-1"}', { 'webhook-id': 'msg_verification_1' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge: 'nonce-1' });
  assert.equal((await hook(token, '{"eventId":"evt_1"}')).status, 503);
  assert.deepEqual((await fetched()).deliveries, [], 'nothing stored');
});

test('confirmed path: stored as received (raw bytes, headers, receive time), then fetched and acknowledged', async () => {
  await drain();
  const token = await register('confirmed');
  // Non-ASCII text, then bytes that are not UTF-8 at all: stored and returned untouched.
  const raw = Buffer.concat([Buffer.from('{ "eventId":"evt_1", "data": {"é": "日本"} }\n'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0d])]);
  const sentFrom = Date.now();
  assert.equal((await hook(token, raw)).status, 200);
  const sentUntil = Date.now();
  const res = await hook(token, '{"type":"verification","challenge":"again"}');
  assert.deepEqual(await res.json(), { challenge: 'again' }, 'still echoed once confirmed (re-verification)');

  const { deliveries, more } = await fetched();
  assert.equal(more, false);
  assert.equal(deliveries.length, 1);
  const d = deliveries[0]!;
  assert.equal(d.token, token);
  assert.ok(d.receivedAt >= sentFrom && d.receivedAt <= sentUntil, `receive time ${d.receivedAt}, not webhook-timestamp`);
  assert.deepEqual(d.headers, {
    'webhook-id': 'evt_1',
    'webhook-timestamp': String(NOW / 1000),
    'webhook-signature': 'v1,c2ln',
    'x-mcp-subscription-id': 'sub_1',
  });
  assert.deepEqual(Buffer.from(d.body, 'base64'), raw);

  assert.equal((await control('POST', '/relay/ack', { upTo: d.seq })).status, 204);
  assert.deepEqual((await fetched()).deliveries, []);
});

test('missing required header: 400; body over 256 KiB: 413 by Content-Length or while streaming; exactly 256 KiB: 200', async () => {
  await drain();
  const token = await register();
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']) {
    assert.equal((await hook(token, '{}', { [name]: '' })).status, 400, name);
  }
  assert.equal((await hook(token, new Uint8Array(MAX_BODY_BYTES + 1), { 'webhook-id': 'too-long' })).status, 413);
  await clearDroppedConnections();
  // No Content-Length: a chunked upload that keeps going past the limit.
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(64 * 1024 + 1));
      controller.close();
    },
  });
  assert.equal((await hook(token, chunked, { 'webhook-id': 'too-long-chunked' })).status, 413);
  await clearDroppedConnections();
  assert.equal((await hook(token, new Uint8Array(MAX_BODY_BYTES), { 'webhook-id': 'just-fits' })).status, 200);
  const { deliveries } = await fetched();
  assert.deepEqual(
    deliveries.map((d) => [d.headers['webhook-id'], Buffer.from(d.body, 'base64').length]),
    [['just-fits', MAX_BODY_BYTES]],
  );
  // The relay's own verdicts, not something in between: refused on the header, and mid-stream.
  await until('relay log lines', () => output().includes('webhook-id=too-long-chunked'));
  assert.match(output(), /^413 too-large hook=\S+ webhook-id=too-long$/m);
  assert.match(output(), /^413 too-large hook=\S+ webhook-id=too-long-chunked$/m);
});

test('header values as the sender meant them: UTF-8 webhook-id, repeated signature lines as one list', async () => {
  await drain();
  const token = await register();
  const status = await rawHook(relay.url, token, {
    'webhook-id': Buffer.from('évt_日本_1', 'utf8').toString('latin1'), // node:http writes header strings as latin1 bytes
    'webhook-timestamp': String(NOW / 1000),
    'webhook-signature': ['v1,AAAA', 'v1,BBBB'],
    'x-mcp-subscription-id': 'sub_1',
  });
  assert.equal(status, 200);
  const [d] = (await fetched()).deliveries;
  assert.equal(d!.headers['webhook-id'], 'évt_日本_1');
  assert.equal(d!.headers['webhook-signature'], 'v1,AAAA v1,BBBB');
  await drain();
});

test('fetching is batched by count and by bytes', async () => {
  await drain();
  const token = await register();
  for (let i = 0; i < 25; i++) assert.equal((await hook(token, `{"n":${i}}`, { 'webhook-id': `evt_${i}` })).status, 200);
  let batch = await fetched();
  assert.equal(batch.deliveries.length, 20);
  assert.equal(batch.more, true);
  await control('POST', '/relay/ack', { upTo: batch.deliveries.at(-1)!.seq });
  batch = await fetched();
  assert.deepEqual(
    batch.deliveries.map((d) => d.headers['webhook-id']),
    ['evt_20', 'evt_21', 'evt_22', 'evt_23', 'evt_24'],
  );
  assert.equal(batch.more, false);
  await control('POST', '/relay/ack', { upTo: batch.deliveries.at(-1)!.seq });

  for (let i = 0; i < 3; i++) await hook(token, new Uint8Array(200 * 1024), { 'webhook-id': `big_${i}` });
  batch = await fetched();
  assert.equal(batch.deliveries.length, 2, '400 KiB fits under the 512 KiB batch, 600 KiB does not');
  assert.equal(batch.more, true);
});

test('deleting a path drops what was stored for it; stored deliveries survive a restart of wrangler', async () => {
  await drain();
  const keep = await register();
  const drop = await register();
  await hook(keep, '{"k":1}', { 'webhook-id': 'keep' });
  await hook(drop, '{"d":1}', { 'webhook-id': 'drop' });
  assert.equal((await control('DELETE', `/relay/paths/${drop}`)).status, 204);
  assert.equal((await hook(drop, '{"d":2}')).status, 404);
  // close() kills wrangler and workerd outright, so this also shows the 200 came after the write.
  await restart();
  assert.deepEqual(
    (await fetched()).deliveries.map((d) => d.headers['webhook-id']),
    ['keep'],
  );
});

test('logs carry neither the key nor bodies; the relay lines carry no full path tokens', async () => {
  const token = await register();
  assert.equal((await hook(token, '{"secret-marker":"BODY-7f3a"}', { 'webhook-id': 'marked' })).status, 200);
  const fetchLines = () => output().split(' fetched-').length;
  const before = fetchLines();
  await control('GET', '/relay/deliveries');
  await until('relay log lines', () => output().includes('webhook-id=marked') && fetchLines() > before);
  // Everything wrangler and the Worker printed in this file, across the restart.
  assert.ok(!output().includes(KEY), 'key in the output');
  assert.ok(!output().includes('BODY-7f3a'), 'body in the output');
  // wrangler dev's own request lines show full paths; the relay's lines (as in `wrangler tail`) must not.
  const relayLines = output().split(/\r?\n/).filter((line) => /^\d{3} \S+ hook=/.test(line));
  assert.ok(relayLines.length >= 3);
  for (const line of relayLines) assert.ok(!line.includes(token), line);
});
