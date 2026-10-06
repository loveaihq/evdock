// The mock MCP Events server, driven with raw JSON-RPC over fetch. Deliveries land on a
// throwaway receiver that checks signatures with the official standardwebhooks library.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Webhook } from 'standardwebhooks';
import {
  startMockServer,
  type MockEventType,
  type MockServer,
  type MockServerOptions,
} from '../src/conformance/mock-server.js';
import { close, listen, newSecret } from './helpers.js';

const TOKEN = 'test-token';
const VERSION = '2026-07-28';
const EVENTS = 'io.modelcontextprotocol/events';

const TYPES: MockEventType[] = [
  {
    name: 'incident.created',
    description: 'A new incident',
    inputSchema: { type: 'object', properties: { severity: { type: 'string' } } },
    payloadSchema: { type: 'object', properties: { severity: { type: 'string' }, n: { type: 'string' } } },
    replay: true,
  },
  {
    name: 'build.finished',
    description: 'A CI build finished',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
    payloadSchema: { type: 'object' },
    replay: true,
  },
  {
    name: 'chat.message',
    description: 'Emit-only: no history upstream',
    inputSchema: { type: 'object', properties: {} },
    payloadSchema: { type: 'object' },
    replay: false,
  },
];

// --- MCP side ---

async function start(t: TestContext, overrides: Partial<MockServerOptions> = {}): Promise<MockServer> {
  const mock = await startMockServer({
    token: TOKEN,
    eventTypes: TYPES,
    defaultTtlMs: 10_000,
    retry: { attempts: 3, baseDelayMs: 20 },
    allowInsecureCallbacks: true,
    ...overrides,
  });
  t.after(() => mock.close());
  return mock;
}

const META = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientCapabilities': { extensions: { [EVENTS]: {} } },
  'io.modelcontextprotocol/clientInfo': { name: 'mock-server-test', version: '0' },
};

interface RpcOptions {
  /** Header overrides; undefined removes the header. */
  headers?: Record<string, string | undefined>;
  /** Replaces params._meta. */
  meta?: Record<string, unknown>;
}

let nextId = 1;

async function rpc(mock: MockServer, method: string, params: Record<string, unknown> = {}, opts: RpcOptions = {}) {
  const id = nextId++;
  const headers: Record<string, string> = {};
  const all: Record<string, string | undefined> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    authorization: `Bearer ${TOKEN}`,
    ...opts.headers,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) headers[k] = v;
  const res = await fetch(mock.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: opts.meta ?? META } }),
  });
  const text = await res.text();
  return { id, status: res.status, contentType: res.headers.get('content-type') ?? '', text };
}

// Parsed JSON from the wire, inspected field by field in assertions.
type Json = any;

async function call(mock: MockServer, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const res = await rpc(mock, method, params);
  assert.equal(res.status, 200, res.text);
  const message = JSON.parse(res.text);
  assert.equal(message.id, res.id);
  assert.equal(message.error, undefined, res.text);
  assert.equal(message.result.resultType, 'complete');
  return message.result;
}

async function callError(mock: MockServer, method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const res = await rpc(mock, method, params);
  assert.equal(res.status, 200, res.text);
  const message = JSON.parse(res.text);
  assert.equal(message.id, res.id);
  assert.ok(message.error, res.text);
  return message.error;
}

// --- Webhook side ---

interface Received {
  path: string;
  headers: Record<string, string>;
  body: Json;
  valid: boolean;
}

type Reply = number | { status: number; json?: unknown } | 'hang';

interface Receiver {
  url: string;
  base: string;
  secret: string;
  received: Received[];
  events(): Received[];
  /** Decides the response to a correctly signed POST; the default echoes challenges and acks events. */
  reply: (r: Received) => Reply;
}

const defaultReply = (r: Received): Reply =>
  r.body.type === 'verification' ? { status: 200, json: { challenge: r.body.challenge } } : 200;

async function receiver(t: TestContext, path = '/hooks/a'): Promise<Receiver> {
  const state: Receiver = {
    url: '',
    base: '',
    secret: newSecret(),
    received: [],
    events: () => state.received.filter((r) => r.body.eventId !== undefined),
    reply: defaultReply,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      let valid = true;
      try {
        new Webhook(state.secret).verify(raw, headers);
      } catch {
        valid = false;
      }
      let body: Json;
      try {
        body = JSON.parse(raw);
      } catch {
        return void res.writeHead(400).end(); // a POST cut short when the mock aborted it
      }
      const r: Received = { path: req.url ?? '', headers, body, valid };
      state.received.push(r);
      if (!valid) return void res.writeHead(401).end();
      const reply = state.reply(r);
      if (reply === 'hang') return;
      if (typeof reply === 'number') return void res.writeHead(reply).end();
      if (reply.json === undefined) return void res.writeHead(reply.status).end();
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
    });
  });
  state.base = await listen(server);
  state.url = `${state.base}${path}`;
  t.after(() => close(server));
  return state;
}

function subscribeParams(r: Receiver, extra: Record<string, unknown> = {}) {
  return {
    name: 'incident.created',
    arguments: {},
    delivery: { mode: 'webhook', url: r.url, secret: r.secret },
    cursor: null,
    ...extra,
  };
}

const unsubscribeParams = (r: Receiver, extra: Record<string, unknown> = {}) => ({
  name: 'incident.created',
  arguments: {},
  delivery: { mode: 'webhook', url: r.url },
  ...extra,
});

async function waitFor(what: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const attemptsFor = (mock: MockServer, webhookId: string) => mock.attempts().filter((a) => a.webhookId === webhookId);

// --- Tests ---

test('server/discover advertises the events extension under capabilities.extensions', async (t) => {
  const mock = await start(t);
  const result = await call(mock, 'server/discover');
  assert.deepEqual(result.supportedVersions, [VERSION]);
  assert.deepEqual(result.capabilities, { extensions: { [EVENTS]: {} } });
  assert.equal(result.capabilities.events, undefined);
});

test('rejects bad auth and bad request metadata with the transport status codes', async (t) => {
  const mock = await start(t);
  const json = (text: string) => JSON.parse(text);

  assert.equal((await rpc(mock, 'server/discover', {}, { headers: { authorization: undefined } })).status, 401);
  assert.equal((await rpc(mock, 'server/discover', {}, { headers: { authorization: 'Bearer nope' } })).status, 401);

  const old = await rpc(mock, 'server/discover', {}, { headers: { 'mcp-protocol-version': '2025-11-25' } });
  assert.equal(old.status, 400);
  assert.deepEqual(json(old.text).error.data, { supported: [VERSION], requested: '2025-11-25' });
  assert.equal(json(old.text).error.code, -32022);
  assert.equal(json(old.text).id, old.id);

  const noVersion = await rpc(mock, 'server/discover', {}, { headers: { 'mcp-protocol-version': undefined } });
  assert.equal(noVersion.status, 400);
  assert.equal(json(noVersion.text).error.code, -32020);

  const wrongMethod = await rpc(mock, 'server/discover', {}, { headers: { 'mcp-method': 'events/list' } });
  assert.equal(wrongMethod.status, 400);
  assert.equal(json(wrongMethod.text).error.code, -32020);

  const noMeta = await rpc(mock, 'server/discover', {}, { meta: {} });
  assert.equal(noMeta.status, 400);
  assert.equal(json(noMeta.text).error.code, -32602);

  const versionOnly = { 'io.modelcontextprotocol/protocolVersion': VERSION };
  const noCapabilities = await rpc(mock, 'server/discover', {}, { meta: versionOnly });
  assert.equal(noCapabilities.status, 400);
  assert.equal(json(noCapabilities.text).error.code, -32602);

  const olderMeta = { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' };
  const metaMismatch = await rpc(mock, 'server/discover', {}, { meta: olderMeta });
  assert.equal(metaMismatch.status, 400);
  assert.equal(json(metaMismatch.text).error.code, -32020);

  const unknown = await rpc(mock, 'tools/list');
  assert.equal(unknown.status, 404);
  assert.equal(json(unknown.text).error.code, -32601);

  assert.equal((await fetch(mock.url)).status, 405);
  assert.equal((await fetch(mock.url.replace('/mcp', '/other'), { method: 'POST' })).status, 404);
});

test('events/list pages through nextCursor and lists webhook delivery', async (t) => {
  const mock = await start(t, { listPageSize: 2 });
  const first = await call(mock, 'events/list');
  assert.deepEqual(
    first.events.map((e: Json) => e.name),
    ['incident.created', 'build.finished'],
  );
  assert.equal(typeof first.nextCursor, 'string');
  const second = await call(mock, 'events/list', { cursor: first.nextCursor });
  assert.deepEqual(
    second.events.map((e: Json) => e.name),
    ['chat.message'],
  );
  assert.equal('nextCursor' in second, false);
  for (const e of [...first.events, ...second.events]) {
    assert.deepEqual(e.delivery, ['webhook']);
    assert.deepEqual(e.inputSchema, TYPES.find((x) => x.name === e.name)!.inputSchema);
    assert.equal(typeof e.description, 'string');
    assert.ok(e.payloadSchema);
  }
  assert.equal((await callError(mock, 'events/list', { cursor: 'bogus' })).code, -32602);
});

test('events/subscribe validates name, mode, arguments, callback URL and secret', async (t) => {
  const mock = await start(t, { allowInsecureCallbacks: false });
  const good = { mode: 'webhook', url: 'https://hooks.example.com/a', secret: newSecret() };
  const sub = (extra: Record<string, unknown>) =>
    callError(mock, 'events/subscribe', { name: 'incident.created', arguments: {}, delivery: good, ...extra });

  assert.deepEqual(await sub({ name: 'no.such.event' }), {
    code: -32023,
    message: 'NotFound',
    data: { kind: 'event' },
  });
  assert.deepEqual(await sub({ delivery: { ...good, mode: 'push' } }), {
    code: -32026,
    message: 'Unsupported',
    data: { feature: 'deliveryMode', value: 'push' },
  });
  for (const delivery of [
    undefined,
    { ...good, mode: undefined },
    { ...good, url: 'http://hooks.example.com/a' },
    { ...good, url: 'not a url' },
    { ...good, url: 'https://127.0.0.1/a' },
    { ...good, url: 'https://localhost/a' },
    { ...good, url: 'https://api.localhost./a' },
    { ...good, url: 'https://10.1.2.3/a' },
    { ...good, url: 'https://172.20.0.1/a' },
    { ...good, url: 'https://192.168.1.1/a' },
    { ...good, url: 'https://169.254.169.254/a' },
    { ...good, url: 'https://[::1]/a' },
    { ...good, url: 'https://[fd00::1]/a' },
    { ...good, url: 'https://[::ffff:127.0.0.1]/a' },
    { ...good, secret: 'not-a-secret' },
    { ...good, secret: `whsec_${randomBytes(16).toString('base64')}` },
    { ...good, secret: `whsec_${randomBytes(65).toString('base64')}` },
    { ...good, secret: 'whsec_!!!!' },
  ]) {
    assert.equal((await sub({ delivery })).code, -32602, JSON.stringify(delivery));
  }
  assert.equal((await sub({ arguments: { severity: 1 } })).code, -32602);
  assert.equal((await sub({ arguments: [] })).code, -32602);
  assert.equal((await sub({ name: 'build.finished', arguments: {} })).code, -32602); // repo is required
  assert.equal((await sub({ ttlMs: 'soon' })).code, -32602);
  assert.equal((await sub({ cursor: 42 })).code, -32602);

  assert.deepEqual(mock.subscriptions(), []);
  assert.deepEqual(mock.attempts(), []); // nothing was POSTed anywhere
});

test('verification handshake: signed challenge before activation, cached per (principal, url)', async (t) => {
  const mock = await start(t);
  const hook = await receiver(t);

  const result = await call(mock, 'events/subscribe', subscribeParams(hook));
  assert.match(result.id, /^sub_[0-9a-f]{16}$/);
  assert.ok(Date.parse(result.refreshBefore) > Date.now());
  assert.equal(typeof result.cursor, 'string');
  assert.equal(result.truncated, false);
  assert.equal('deliveryStatus' in result, false);

  assert.equal(hook.received.length, 1);
  const [v] = hook.received;
  assert.equal(v!.valid, true);
  assert.equal(v!.body.type, 'verification');
  assert.equal(typeof v!.body.challenge, 'string');
  assert.match(v!.headers['webhook-id']!, /^msg_verification_/);
  assert.equal(v!.headers['x-mcp-subscription-id'], result.id);
  assert.equal(v!.headers['content-type'], 'application/json');
  assert.deepEqual(
    mock.attempts().map((a) => [a.subscriptionId, a.webhookId, a.status]),
    [[result.id, v!.headers['webhook-id'], 200]],
  );

  // Same key: same id, no new handshake. Other arguments, same URL: new id, still no handshake.
  const again = await call(mock, 'events/subscribe', subscribeParams(hook));
  assert.equal(again.id, result.id);
  const other = await call(mock, 'events/subscribe', subscribeParams(hook, { arguments: { severity: 'P1' } }));
  assert.notEqual(other.id, result.id);
  assert.equal(hook.received.length, 1);

  const subs = mock.subscriptions();
  assert.equal(subs.length, 2);
  for (const s of subs) {
    assert.equal(s.url, hook.url);
    assert.equal(s.name, 'incident.created');
    assert.equal(s.verified, true);
  }
});

test('failed verification returns CallbackEndpointError with a reason and creates nothing', async (t) => {
  const mock = await start(t, { deliveryTimeoutMs: 100 });
  const reasonFor = async (hook: Receiver | string) => {
    const url = typeof hook === 'string' ? hook : hook.url;
    const secret = typeof hook === 'string' ? newSecret() : hook.secret;
    const error = await callError(mock, 'events/subscribe', {
      name: 'incident.created',
      delivery: { mode: 'webhook', url, secret },
    });
    assert.equal(error.code, -32027);
    assert.equal(error.message, 'CallbackEndpointError');
    return error.data.reason;
  };

  const wrongEcho = await receiver(t, '/wrong-echo');
  wrongEcho.reply = () => ({ status: 200, json: { challenge: 'something else' } });
  assert.equal(await reasonFor(wrongEcho), 'challenge_failed');

  const noEcho = await receiver(t, '/no-echo');
  noEcho.reply = () => 200;
  assert.equal(await reasonFor(noEcho), 'challenge_failed');

  const failing = await receiver(t, '/500');
  failing.reply = () => 500;
  assert.equal(await reasonFor(failing), 'http_5xx');

  const missing = await receiver(t, '/404');
  missing.reply = () => 404;
  assert.equal(await reasonFor(missing), 'http_4xx');

  const redirect = await receiver(t, '/302');
  redirect.reply = () => 302;
  assert.equal(await reasonFor(redirect), 'http_4xx');

  const silent = await receiver(t, '/hang');
  silent.reply = () => 'hang';
  assert.equal(await reasonFor(silent), 'timeout');

  const gone = createServer();
  const goneUrl = await listen(gone);
  await close(gone);
  assert.equal(await reasonFor(`${goneUrl}/hooks/a`), 'connection_refused');

  assert.deepEqual(mock.subscriptions(), []);
  // A failed handshake is not cached: the endpoint is challenged again next time.
  wrongEcho.reply = defaultReply;
  await call(mock, 'events/subscribe', subscribeParams(wrongEcho));
  assert.equal(wrongEcho.received.length, 2);
});

test('delivers matching events, signed per Standard Webhooks', async (t) => {
  const mock = await start(t);
  const hook = await receiver(t);
  const { id } = await call(mock, 'events/subscribe', subscribeParams(hook, { arguments: { severity: 'P1' } }));

  mock.emit('incident.created', { severity: 'P2', n: 'other severity' });
  mock.emit('build.finished', { repo: 'x', severity: 'P1' });
  const emitted = mock.emit('incident.created', { severity: 'P1', n: 'match' });
  await waitFor('delivery', () => hook.events().length === 1);
  await sleep(30);
  assert.equal(hook.events().length, 1);

  const [d] = hook.events();
  assert.equal(d!.valid, true);
  assert.equal(d!.headers['content-type'], 'application/json');
  assert.equal(d!.headers['webhook-id'], emitted.eventId);
  assert.equal(d!.headers['x-mcp-subscription-id'], id);
  assert.match(d!.headers['webhook-timestamp']!, /^\d+$/);
  assert.match(d!.headers['webhook-signature']!, /^v1,[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(Object.keys(d!.body).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']);
  assert.equal(d!.body.eventId, emitted.eventId);
  assert.equal(d!.body.name, 'incident.created');
  assert.deepEqual(d!.body.data, { severity: 'P1', n: 'match' });
  assert.equal(new Date(d!.body.timestamp).toISOString(), d!.body.timestamp);
  // Nothing else is outstanding, so the event's own payload covers it (SEP 535).
  assert.equal(d!.body.cursor, emitted.cursor);
});

test('emit-only event types never carry a cursor', async (t) => {
  const mock = await start(t);
  const hook = await receiver(t);
  const result = await call(mock, 'events/subscribe', subscribeParams(hook, { name: 'chat.message' }));
  assert.equal(result.cursor, null);
  assert.equal(result.truncated, false);

  const emitted = mock.emit('chat.message', { text: 'hi' });
  assert.equal(emitted.cursor, null);
  await waitFor('delivery', () => hook.events().length === 1);
  assert.equal(hook.events()[0]!.body.cursor, null);

  // A supplied cursor means nothing here: no replay, no truncation.
  await call(mock, 'events/unsubscribe', unsubscribeParams(hook, { name: 'chat.message' }));
  const again = await call(
    mock,
    'events/subscribe',
    subscribeParams(hook, { name: 'chat.message', cursor: 'whatever' }),
  );
  assert.equal(again.cursor, null);
  assert.equal(again.truncated, false);
  await sleep(30);
  assert.equal(hook.events().length, 1);
});

test('a subscription that is not refreshed expires and deliveries stop', async (t) => {
  const mock = await start(t, { defaultTtlMs: 60 });
  const hook = await receiver(t);
  const before = Date.now();
  const result = await call(mock, 'events/subscribe', subscribeParams(hook));
  const granted = Date.parse(result.refreshBefore) - before;
  assert.ok(granted >= 60 && granted < 60 + 100, `granted ${granted} ms`);

  await sleep(100);
  assert.deepEqual(mock.subscriptions(), []);
  mock.emit('incident.created', { n: 'after expiry' });
  await sleep(30);
  assert.equal(hook.events().length, 0);
  const gone = await callError(mock, 'events/unsubscribe', unsubscribeParams(hook));
  assert.deepEqual(gone.data, { kind: 'subscription' });
});

test('refresh keeps the id, grants the TTL again, replaces the secret and reports deliveryStatus', async (t) => {
  const ttl = 300;
  const mock = await start(t, { defaultTtlMs: ttl });
  const hook = await receiver(t);
  const first = await call(mock, 'events/subscribe', subscribeParams(hook));
  const e1 = mock.emit('incident.created', { n: '1' });
  await waitFor('delivery', () => hook.events().length === 1);

  await sleep(ttl * 0.6);
  hook.secret = newSecret(); // rotated on refresh
  const refreshed = await call(mock, 'events/subscribe', subscribeParams(hook));
  assert.equal(refreshed.id, first.id);
  assert.ok(Date.parse(refreshed.refreshBefore) > Date.parse(first.refreshBefore));
  assert.equal(refreshed.cursor, e1.cursor);
  assert.equal(refreshed.truncated, false);
  assert.equal(refreshed.deliveryStatus.active, true);
  assert.equal(refreshed.deliveryStatus.lastError, null);
  assert.ok(Date.parse(refreshed.deliveryStatus.lastDeliveryAt) <= Date.now());

  // Past the first grant, inside the second: still alive, signed with the new secret.
  await sleep(ttl * 0.6);
  assert.ok(Date.now() > Date.parse(first.refreshBefore));
  assert.equal(mock.subscriptions().length, 1);
  mock.emit('incident.created', { n: '2' });
  await waitFor('delivery', () => hook.events().length === 2);
  assert.equal(hook.events()[1]!.valid, true);
  assert.equal(hook.received.filter((r) => r.body.type === 'verification').length, 1);

  // Grants: at most the suggestion, at most the default; null (no expiry) is declined.
  const grantFor = async (ttlMs: unknown) => {
    const before = Date.now();
    const r = await call(mock, 'events/subscribe', subscribeParams(hook, { ttlMs }));
    return Date.parse(r.refreshBefore) - before;
  };
  const short = await grantFor(50);
  assert.ok(short >= 50 && short < 50 + 100, `short ${short}`);
  const long = await grantFor(1_000_000);
  assert.ok(long >= ttl && long < ttl + 100, `long ${long}`);
  const unlimited = await grantFor(null);
  assert.ok(unlimited >= ttl && unlimited < ttl + 100, `unlimited ${unlimited}`);
});

test('unsubscribe then subscribe with a cursor replays from it, with the same eventIds', async (t) => {
  const mock = await start(t);
  const hook = await receiver(t);
  const args = { severity: 'P1' };
  const start0 = await call(mock, 'events/subscribe', subscribeParams(hook, { arguments: args }));

  const e1 = mock.emit('incident.created', { severity: 'P1', n: '1' });
  await waitFor('e1', () => hook.events().length === 1);
  const c1 = hook.events()[0]!.body.cursor;
  assert.equal(c1, e1.cursor);

  assert.deepEqual(await call(mock, 'events/unsubscribe', unsubscribeParams(hook, { arguments: args })), {
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'evdock-mock-server', version: '0.0.0' } },
  });
  assert.deepEqual((await callError(mock, 'events/unsubscribe', unsubscribeParams(hook, { arguments: args }))).data, {
    kind: 'subscription',
  });

  const e2 = mock.emit('incident.created', { severity: 'P1', n: '2' });
  mock.emit('incident.created', { severity: 'P3', n: 'not matching' });
  const e4 = mock.emit('incident.created', { severity: 'P1', n: '4' });
  await sleep(30);
  assert.equal(hook.events().length, 1); // nothing while unsubscribed

  const resumed = await call(mock, 'events/subscribe', subscribeParams(hook, { arguments: args, cursor: c1 }));
  assert.equal(resumed.truncated, false);
  await waitFor('replay', () => hook.events().length === 3);
  assert.deepEqual(
    hook.events().slice(1).map((r) => r.body.eventId).sort(),
    [e2.eventId, e4.eventId].sort(),
  );

  // Replaying from the very start brings e1 back under its original eventId.
  await call(mock, 'events/unsubscribe', unsubscribeParams(hook, { arguments: args }));
  await call(mock, 'events/subscribe', subscribeParams(hook, { arguments: args, cursor: start0.cursor }));
  await waitFor('second replay', () => hook.events().length === 6);
  assert.deepEqual(
    hook.events().slice(3).map((r) => r.body.eventId).sort(),
    [e1.eventId, e2.eventId, e4.eventId].sort(),
  );
  assert.equal(hook.received.filter((r) => r.body.type === 'verification').length, 1);
});

test('cursors never pass an unacknowledged event; exhausted retries are abandoned', async (t) => {
  const base = 100;
  const mock = await start(t, { retry: { attempts: 3, baseDelayMs: base } });
  const hook = await receiver(t);
  hook.reply = (r) => (r.body.data?.n === 'B' ? 500 : defaultReply(r));
  await call(mock, 'events/subscribe', subscribeParams(hook));

  const a = mock.emit('incident.created', { n: 'A' });
  await waitFor('A acked', () => attemptsFor(mock, a.eventId).some((x) => x.status === 200));
  const b = mock.emit('incident.created', { n: 'B' });
  await waitFor('B first attempt', () => attemptsFor(mock, b.eventId).length === 1);
  const c = mock.emit('incident.created', { n: 'C' });
  await waitFor('C acked', () => attemptsFor(mock, c.eventId).some((x) => x.status === 200));

  // B is still being retried: neither C's payload nor a refresh may move past it.
  const cPayload = hook.events().find((r) => r.body.eventId === c.eventId)!.body;
  assert.equal(cPayload.cursor, a.cursor);
  const during = await call(mock, 'events/subscribe', subscribeParams(hook));
  assert.equal(during.cursor, a.cursor);
  assert.equal(attemptsFor(mock, b.eventId).length < 3, true, 'B must still be pending for this check');

  // After the last attempt B is abandoned and the watermark moves past it.
  await waitFor('B exhausted', () => attemptsFor(mock, b.eventId).length === 3);
  await sleep(base * 2);
  const tries = attemptsFor(mock, b.eventId);
  assert.equal(tries.length, 3);
  assert.ok(tries.every((x) => x.status === 500));
  assert.ok(tries[1]!.at - tries[0]!.at >= base - 2, 'first backoff');
  assert.ok(tries[2]!.at - tries[1]!.at >= base * 2 - 2, 'second backoff');
  const bDeliveries = hook.received.filter((r) => r.body.eventId === b.eventId);
  assert.equal(bDeliveries.length, 3);
  assert.ok(bDeliveries.every((r) => r.valid && r.headers['webhook-id'] === b.eventId));

  const after = await call(mock, 'events/subscribe', subscribeParams(hook));
  assert.equal(after.cursor, c.cursor);
  assert.equal(after.deliveryStatus.lastError, 'http_5xx');

  const d = mock.emit('incident.created', { n: 'D' });
  await waitFor('D', () => hook.events().some((r) => r.body.eventId === d.eventId));
  assert.equal(hook.events().find((r) => r.body.eventId === d.eventId)!.body.cursor, d.cursor);
});

test('410 and 413 abandon an event without retrying', async (t) => {
  const mock = await start(t, { retry: { attempts: 5, baseDelayMs: 10 } });
  const hook = await receiver(t);
  hook.reply = (r) => (r.body.data?.status !== undefined ? r.body.data.status : defaultReply(r));
  await call(mock, 'events/subscribe', subscribeParams(hook));

  const gone = mock.emit('incident.created', { status: 410 });
  const tooLarge = mock.emit('incident.created', { status: 413 });
  const retried = mock.emit('incident.created', { status: 503 });
  await waitFor('503 retries', () => attemptsFor(mock, retried.eventId).length === 5);
  await sleep(30);
  assert.equal(attemptsFor(mock, gone.eventId).length, 1);
  assert.equal(attemptsFor(mock, tooLarge.eventId).length, 1);
  assert.equal((await call(mock, 'events/subscribe', subscribeParams(hook))).cursor, retried.cursor);
});

test('a cursor older than the retained window, or from another instance, gives truncated: true', async (t) => {
  const mock = await start(t, { retentionEvents: 2 });
  const hook = await receiver(t);
  const first = await call(mock, 'events/subscribe', subscribeParams(hook));
  await call(mock, 'events/unsubscribe', unsubscribeParams(hook));

  const emitted = [1, 2, 3, 4].map((n) => mock.emit('incident.created', { n: String(n) }));
  const resumed = await call(mock, 'events/subscribe', subscribeParams(hook, { cursor: first.cursor }));
  assert.equal(resumed.truncated, true);
  // Delivery restarts at the oldest retained entry; the cursor sits just before it.
  assert.equal(resumed.cursor, emitted[1]!.cursor);
  await waitFor('retained events', () => hook.events().length === 2);
  assert.deepEqual(
    hook.events().map((r) => r.body.eventId).sort(),
    [emitted[2]!.eventId, emitted[3]!.eventId].sort(),
  );

  // Exactly at the edge of the window nothing was skipped.
  await call(mock, 'events/unsubscribe', unsubscribeParams(hook));
  const edge = await call(mock, 'events/subscribe', subscribeParams(hook, { cursor: emitted[1]!.cursor }));
  assert.equal(edge.truncated, false);

  // Cursors and eventIds are per instance.
  const other = await start(t);
  const elsewhere = other.emit('incident.created', { n: '1' });
  assert.notEqual(elsewhere.eventId, emitted[0]!.eventId);
  await call(mock, 'events/unsubscribe', unsubscribeParams(hook));
  const foreign = await call(mock, 'events/subscribe', subscribeParams(hook, { cursor: elsewhere.cursor }));
  assert.equal(foreign.truncated, true);
  assert.equal(foreign.cursor, emitted[3]!.cursor);
});

test('sseResponses answers requests as text/event-stream', async (t) => {
  const mock = await start(t, { sseResponses: true });
  const parse = (text: string) => {
    const lines = text.split('\n').filter((l) => l !== '');
    assert.match(lines[0]!, /^:/); // a comment comes first
    const data = lines.filter((l) => l.startsWith('data: '));
    assert.equal(data.length, 1);
    return JSON.parse(data[0]!.slice(6));
  };

  const ok = await rpc(mock, 'server/discover');
  assert.equal(ok.status, 200);
  assert.match(ok.contentType, /^text\/event-stream/);
  const message = parse(ok.text);
  assert.equal(message.id, ok.id);
  assert.equal(message.result.resultType, 'complete');
  assert.deepEqual(message.result.supportedVersions, [VERSION]);

  const failed = await rpc(mock, 'events/subscribe', { name: 'no.such.event' });
  assert.match(failed.contentType, /^text\/event-stream/);
  assert.equal(parse(failed.text).error.code, -32023);

  // Transport-level rejections stay plain JSON.
  const rejected = await rpc(mock, 'server/discover', {}, { headers: { 'mcp-method': 'x' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.contentType, /^application\/json/);
});

test('terminate() posts a signed terminated envelope and removes the subscription', async (t) => {
  const mock = await start(t);
  const hook = await receiver(t);
  const { id } = await call(mock, 'events/subscribe', subscribeParams(hook));

  await mock.terminate(id);
  const envelope = hook.received.at(-1)!;
  assert.equal(envelope.valid, true);
  assert.deepEqual(envelope.body, { type: 'terminated', error: { code: -32024, message: 'Forbidden' } });
  assert.match(envelope.headers['webhook-id']!, /^msg_terminated_/);
  assert.equal(envelope.headers['x-mcp-subscription-id'], id);
  assert.deepEqual(mock.subscriptions(), []);

  mock.emit('incident.created', { n: 'after termination' });
  await sleep(30);
  assert.equal(hook.events().length, 0);
  assert.equal((await callError(mock, 'events/unsubscribe', unsubscribeParams(hook))).code, -32023);

  const again = await call(mock, 'events/subscribe', subscribeParams(hook));
  const removed = { code: -32023, message: 'NotFound', data: { kind: 'event' } };
  await mock.terminate(again.id, removed);
  assert.deepEqual(hook.received.at(-1)!.body, { type: 'terminated', error: removed });
  await assert.rejects(mock.terminate(again.id));
});
