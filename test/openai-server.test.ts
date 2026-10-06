// The OpenAI-guide example server (test/fixtures/openai-server.ts), driven by raw JSON-RPC over fetch
// and a throwaway webhook receiver that verifies with the official standardwebhooks library.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { Webhook } from 'standardwebhooks';
import { startOpenAiServer, type OpenAiServerOptions } from './fixtures/openai-server.js';
import { close, listen, newSecret, newToken, tempDir } from './helpers.js';

type Ctx = { after: (fn: () => Promise<void> | void) => void };
type Json = Record<string, any>;

const TOKEN = 'test-token';
const VERSION = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } },
  'io.modelcontextprotocol/clientInfo': { name: 'openai-server-test', version: '0.0.0' },
};

let nextId = 1;

/** POSTs a raw body; `headers` entries set to undefined are left out. */
async function post(url: string, body: unknown, headers: Record<string, string | undefined> = {}) {
  const all: Record<string, string | undefined> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    ...headers,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined)),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Json | undefined };
}

async function rpc(url: string, method: string, params: Json = {}, headers: Record<string, string | undefined> = {}) {
  const res = await post(
    url,
    { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } },
    { 'mcp-protocol-version': VERSION, 'mcp-method': method, ...headers },
  );
  return { status: res.status, body: res.body!, result: res.body?.result as Json | undefined, error: res.body?.error as Json | undefined };
}

interface Hook {
  path: string;
  url: string;
  secret: string;
}

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
  json: Json;
  at: number;
}

/** A webhook receiver: verifies every request with standardwebhooks and echoes verification challenges. */
async function startReceiver(t: Ctx) {
  const secrets = new Map<string, string>();
  const received: Received[] = [];
  const rejected: string[] = [];
  let connections = 0;
  const behavior = {
    verification: 'echo' as 'echo' | 'wrong' | 'error',
    /** Status codes for the next event deliveries, in order; 200 once empty. */
    statuses: [] as number[],
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const path = req.url ?? '';
    const secret = secrets.get(path);
    if (secret === undefined) return void res.writeHead(404).end();
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    let json: Json;
    try {
      json = new Webhook(secret).verify(body, headers) as Json;
    } catch {
      rejected.push(path);
      return void res.writeHead(401).end();
    }
    received.push({ path, headers, body, json, at: performance.now() });
    if (json.type === 'verification') {
      if (behavior.verification === 'error') return void res.writeHead(500).end();
      const challenge = behavior.verification === 'echo' ? json.challenge : 'not-the-challenge';
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge }));
    }
    res.writeHead(behavior.statuses.shift() ?? 200).end();
  });
  server.on('connection', () => connections++);
  const base = await listen(server);
  t.after(() => close(server));
  return {
    base,
    behavior,
    rejected,
    connections: () => connections,
    hook(): Hook {
      const path = `/hooks/${newToken()}`;
      const secret = newSecret();
      secrets.set(path, secret);
      return { path, url: `${base}${path}`, secret };
    },
    /** Changes the secret the receiver verifies with, as a client rotating its key would. */
    rotate(hook: Hook): Hook {
      const secret = newSecret();
      secrets.set(hook.path, secret);
      return { ...hook, secret };
    },
    verifications: (hook?: Hook) => received.filter((r) => r.json.type === 'verification' && (!hook || r.path === hook.path)),
    events: (hook?: Hook) => received.filter((r) => r.json.type === undefined && (!hook || r.path === hook.path)),
  };
}

async function startServer(t: Ctx, overrides: Partial<OpenAiServerOptions> = {}) {
  const { dir, cleanup } = tempDir();
  const clock = { now: Date.UTC(2026, 9, 6, 12, 0, 0) };
  const options: OpenAiServerOptions = {
    token: TOKEN,
    storePath: join(dir, 'subscriptions.json'),
    defaultTtlMs: 60_000,
    maxAttempts: 3,
    baseDelayMs: 10,
    allowInsecureCallbacks: true,
    now: () => clock.now,
    ...overrides,
  };
  const server = await startOpenAiServer(options);
  t.after(async () => {
    await server.close();
    cleanup();
  });
  return { server, options, clock };
}

function subscribe(url: string, hook: Hook, documentId = 'doc_123', extra: Json = {}) {
  return rpc(url, 'events/subscribe', {
    name: 'comment.created',
    arguments: { document_id: documentId },
    delivery: { mode: 'webhook', url: hook.url, secret: hook.secret },
    cursor: null,
    ...extra,
  });
}

function unsubscribe(url: string, hook: Hook, documentId = 'doc_123') {
  return rpc(url, 'events/unsubscribe', {
    name: 'comment.created',
    arguments: { document_id: documentId },
    delivery: { mode: 'webhook', url: hook.url },
  });
}

const comment = (documentId: string, n = 1) => ({
  document_id: documentId,
  comment_id: `comment_${n}`,
  text: 'Can we add the rollout dates to this section?',
  url: `https://docs.example.com/${documentId}#comment_${n}`,
});

test('server/discover: the guide example, events as a top-level capability', async (t) => {
  const { server } = await startServer(t);
  const res = await rpc(server.url, 'server/discover');
  assert.equal(res.status, 200);
  assert.deepEqual(res.result, {
    resultType: 'complete',
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {}, events: {} },
  });
  assert.deepEqual((await rpc(server.url, 'tools/list')).result, { resultType: 'complete', tools: [] });
});

test('base protocol: POST /mcp only, bearer auth, metadata headers, _meta, unknown method', async (t) => {
  const { server } = await startServer(t);
  const discover = (id: number, meta: Json = META) => ({ jsonrpc: '2.0', id, method: 'server/discover', params: { _meta: meta } });
  const headers = { 'mcp-protocol-version': VERSION, 'mcp-method': 'server/discover' };

  assert.equal((await fetch(server.url)).status, 405);
  assert.equal((await post(server.url.replace('/mcp', '/other'), discover(1), headers)).status, 404);
  assert.equal((await post(server.url, discover(1), { ...headers, authorization: undefined })).status, 401);
  assert.equal((await post(server.url, discover(1), { ...headers, authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(server.url, discover(1), { ...headers, origin: 'https://evil.example' })).status, 403);

  const missingVersion = await post(server.url, discover(2), { 'mcp-method': 'server/discover' });
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.body!.error.code, -32020);
  assert.equal(missingVersion.body!.id, 2);

  const oldVersion = await post(server.url, discover(3), { ...headers, 'mcp-protocol-version': '2025-11-25' });
  assert.equal(oldVersion.status, 400);
  assert.equal(oldVersion.body!.error.code, -32022);
  assert.deepEqual(oldVersion.body!.error.data, { supported: ['2026-07-28'], requested: '2025-11-25' });

  const wrongMethod = await post(server.url, discover(4), { ...headers, 'mcp-method': 'events/list' });
  assert.equal(wrongMethod.status, 400);
  assert.equal(wrongMethod.body!.error.code, -32020);

  const noMeta = await post(server.url, { jsonrpc: '2.0', id: 5, method: 'server/discover', params: {} }, headers);
  assert.equal(noMeta.status, 400);
  assert.equal(noMeta.body!.error.code, -32602);

  const metaMismatch = await post(server.url, discover(6, { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' }), headers);
  assert.equal(metaMismatch.status, 400);
  assert.equal(metaMismatch.body!.error.code, -32020);

  const unknown = await rpc(server.url, 'events/poll', { name: 'comment.created' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.error!.code, -32601);

  const garbage = await post(server.url, '{not json', headers);
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body!.error.code, -32700);
});

test('events/list: the guide comment.created definition, shaped like the guide (no resultType)', async (t) => {
  const { server } = await startServer(t);
  const { result } = await rpc(server.url, 'events/list');
  assert.deepEqual(Object.keys(result!), ['events']);
  assert.equal(result!.events.length, 1);
  const [event] = result!.events;
  assert.equal(event.name, 'comment.created');
  assert.deepEqual(event.delivery, ['webhook']);
  assert.deepEqual(event.inputSchema.required, ['document_id']);
  assert.equal(event.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(event.payloadSchema.properties), ['document_id', 'comment_id', 'text', 'url']);
  assert.deepEqual(event.payloadSchema.required, ['document_id', 'comment_id', 'text', 'url']);
});

test('subscribe: signed verification first, cached per (principal, url), guide result shape', async (t) => {
  const { server, clock } = await startServer(t);
  const receiver = await startReceiver(t);
  const hook = receiver.hook();

  const first = await subscribe(server.url, hook);
  assert.equal(first.status, 200);
  assert.deepEqual(first.result, {
    id: first.result!.id,
    refreshBefore: new Date(clock.now + 60_000).toISOString(),
    cursor: null,
    truncated: false,
  });
  assert.match(first.result!.id, /^sub_[0-9a-f]{32}$/);

  const [verification] = receiver.verifications(hook);
  assert.ok(verification);
  assert.match(verification.headers['webhook-id']!, /^msg_verification_/);
  assert.equal(verification.headers['x-mcp-subscription-id'], first.result!.id);
  assert.equal(verification.headers['content-type'], 'application/json');
  assert.equal(typeof verification.json.challenge, 'string');
  assert.deepEqual(Object.keys(verification.json), ['type', 'challenge']);

  // Same identity: same id, no second challenge. Other arguments, same URL: new id, still no challenge.
  const again = await subscribe(server.url, hook);
  assert.equal(again.result!.id, first.result!.id);
  const other = await subscribe(server.url, hook, 'doc_456');
  assert.notEqual(other.result!.id, first.result!.id);
  assert.equal(receiver.verifications().length, 1);

  // Another URL is verified on its own.
  const second = receiver.hook();
  assert.equal((await subscribe(server.url, second)).status, 200);
  assert.equal(receiver.verifications(second).length, 1);
  assert.deepEqual(receiver.rejected, []);
});

test('subscribe rejects bad params: unknown event, arguments, secret, delivery mode', async (t) => {
  const { server } = await startServer(t);
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  const params = (over: Json) => ({
    name: 'comment.created',
    arguments: { document_id: 'doc_123' },
    delivery: { mode: 'webhook', url: hook.url, secret: hook.secret },
    cursor: null,
    ...over,
  });

  const unknown = await rpc(server.url, 'events/subscribe', params({ name: 'comment.deleted' }));
  assert.deepEqual(unknown.error, { code: -32011, message: 'NotFound', data: { kind: 'event' } });
  for (const over of [
    { arguments: {} },
    { arguments: { document_id: 7 } },
    { arguments: { document_id: 'doc_123', extra: true } },
    { delivery: { mode: 'webhook', url: hook.url, secret: 'not-whsec' } },
    { delivery: { mode: 'webhook', url: hook.url, secret: newSecret(16) } },
    { delivery: { mode: 'webhook', url: hook.url, secret: newSecret(65) } },
    { delivery: { mode: 'webhook', url: 'not a url', secret: hook.secret } },
    { ttlMs: -1 },
    { ttlMs: 1.5 },
  ]) {
    assert.equal((await rpc(server.url, 'events/subscribe', params(over))).error?.code, -32602, JSON.stringify(over));
  }
  const push = await rpc(server.url, 'events/subscribe', params({ delivery: { mode: 'push', url: hook.url, secret: hook.secret } }));
  assert.equal(push.error!.code, -32014);
  assert.equal(receiver.connections(), 0, 'nothing invalid reaches the callback');
});

test('delivery: one signed event object, webhook-id is the eventId, X-MCP-Subscription-Id set', async (t) => {
  const { server } = await startServer(t);
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  const sub = await subscribe(server.url, hook);

  const data = comment('doc_123');
  const { eventId } = server.emit('comment.created', data);
  await server.idle();

  const events = receiver.events(hook);
  assert.equal(events.length, 1);
  const [delivery] = events;
  assert.equal(delivery!.headers['webhook-id'], eventId);
  assert.equal(delivery!.json.eventId, eventId);
  assert.equal(delivery!.headers['x-mcp-subscription-id'], sub.result!.id);
  assert.equal(delivery!.headers['content-type'], 'application/json');
  assert.match(delivery!.headers['webhook-timestamp']!, /^\d+$/);
  assert.ok(Math.abs(Number(delivery!.headers['webhook-timestamp']) - Date.now() / 1000) < 60);
  assert.deepEqual(delivery!.json, { eventId, name: 'comment.created', timestamp: delivery!.json.timestamp, data, cursor: null });
  assert.equal(new Date(delivery!.json.timestamp).toISOString(), delivery!.json.timestamp);
  assert.deepEqual(receiver.rejected, [], 'signature verified over the raw body by standardwebhooks');

  assert.throws(() => server.emit('comment.created', { ...data, text: 'x'.repeat(256 * 1024) }), /256 KiB/);
});

test('delivery is filtered by document_id and event name', async (t) => {
  const { server } = await startServer(t);
  const receiver = await startReceiver(t);
  const a = receiver.hook();
  const b = receiver.hook();
  await subscribe(server.url, a, 'doc_a');
  await subscribe(server.url, b, 'doc_b');

  server.emit('comment.created', comment('doc_a'));
  server.emit('comment.created', comment('doc_c'));
  server.emit('comment.deleted', comment('doc_b'));
  await server.idle();

  assert.equal(receiver.events(a).length, 1);
  assert.equal(receiver.events(a)[0]!.json.data.document_id, 'doc_a');
  assert.equal(receiver.events(b).length, 0);
});

test('refresh: same identity updates in place, new refreshBefore and secret; ttlMs is capped and floored', async (t) => {
  const { server, clock } = await startServer(t);
  const receiver = await startReceiver(t);
  let hook = receiver.hook();
  const first = await subscribe(server.url, hook);

  clock.now += 30_000;
  hook = receiver.rotate(hook);
  const refreshed = await subscribe(server.url, hook);
  assert.equal(refreshed.result!.id, first.result!.id);
  assert.equal(refreshed.result!.refreshBefore, new Date(clock.now + 60_000).toISOString());
  assert.ok(refreshed.result!.refreshBefore > first.result!.refreshBefore);

  server.emit('comment.created', comment('doc_123'));
  await server.idle();
  assert.equal(receiver.events(hook).length, 1, 'one subscription, not two');
  assert.deepEqual(receiver.rejected, [], 'signed with the replacement secret');

  const grant = async (ttlMs: unknown) => (await subscribe(server.url, hook, 'doc_123', { ttlMs })).result!.refreshBefore;
  assert.equal(await grant(5_000), new Date(clock.now + 5_000).toISOString(), 'no more than requested');
  assert.equal(await grant(10), new Date(clock.now + 1_000).toISOString(), 'minimum lifetime');
  assert.equal(await grant(10 ** 9), new Date(clock.now + 60_000).toISOString(), 'capped at the default');
  assert.equal(await grant(null), new Date(clock.now + 60_000).toISOString(), 'no expiry is not granted');
  assert.equal(receiver.verifications().length, 1);
});

test('unsubscribe is idempotent ({} every time) and stops delivery', async (t) => {
  const { server } = await startServer(t);
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  await subscribe(server.url, hook);

  for (let i = 0; i < 2; i++) {
    const res = await unsubscribe(server.url, hook);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { jsonrpc: '2.0', id: res.body.id, result: {} });
  }
  assert.deepEqual((await unsubscribe(server.url, receiver.hook(), 'doc_never')).result, {});

  server.emit('comment.created', comment('doc_123'));
  await server.idle();
  assert.equal(receiver.events().length, 0);
});

test('failed verification: -32015 CallbackEndpointError with data.reason, nothing stored', async (t) => {
  const { server } = await startServer(t);
  const receiver = await startReceiver(t);
  const hook = receiver.hook();

  receiver.behavior.verification = 'wrong';
  assert.deepEqual((await subscribe(server.url, hook)).error, {
    code: -32015,
    message: 'CallbackEndpointError',
    data: { reason: 'challenge_failed' },
  });
  receiver.behavior.verification = 'error';
  assert.deepEqual((await subscribe(server.url, hook)).error!.data, { reason: 'challenge_failed' });

  const gone = createServer();
  const goneBase = await listen(gone);
  await close(gone);
  const unreachable = { ...receiver.hook(), url: `${goneBase}/hooks/x` };
  assert.deepEqual((await subscribe(server.url, unreachable)).error!.data, { reason: 'connection_refused' });

  receiver.behavior.verification = 'echo';
  server.emit('comment.created', comment('doc_123'));
  await server.idle();
  assert.equal(receiver.events().length, 0, 'failed subscriptions were not stored');

  // A failure is not cached: the next attempt challenges again and succeeds.
  assert.equal((await subscribe(server.url, hook)).status, 200);
  assert.equal(receiver.verifications(hook).length, 3);
});

test('subscriptions persist across a restart and keep delivering without a resubscribe', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  const options: OpenAiServerOptions = {
    token: TOKEN,
    storePath: join(dir, 'subscriptions.json'),
    defaultTtlMs: 60_000,
    maxAttempts: 3,
    baseDelayMs: 10,
    allowInsecureCallbacks: true,
  };

  const before = await startOpenAiServer(options);
  t.after(() => before.close());
  const sub = await subscribe(before.url, hook);
  await before.close();
  assert.ok(existsSync(options.storePath));

  const after = await startOpenAiServer(options);
  t.after(() => after.close());
  assert.notEqual(after.url, before.url);
  const { eventId } = after.emit('comment.created', comment('doc_123'));
  await after.idle();

  const events = receiver.events(hook);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.headers['webhook-id'], eventId);
  assert.equal(events[0]!.headers['x-mcp-subscription-id'], sub.result!.id);
  assert.equal(receiver.verifications().length, 1, 'no new challenge before delivering');

  assert.equal((await subscribe(after.url, hook)).result!.id, sub.result!.id, 'refresh after restart: same subscription');
  assert.deepEqual(receiver.rejected, []);
});

test('an expired subscription stops delivery until it is refreshed', async (t) => {
  const { server, clock } = await startServer(t, { defaultTtlMs: 1_000 });
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  await subscribe(server.url, hook);

  server.emit('comment.created', comment('doc_123', 1));
  await server.idle();
  assert.equal(receiver.events(hook).length, 1);

  clock.now += 1_000;
  server.emit('comment.created', comment('doc_123', 2));
  await server.idle();
  assert.equal(receiver.events(hook).length, 1, 'expired at refreshBefore');

  await subscribe(server.url, hook);
  server.emit('comment.created', comment('doc_123', 3));
  await server.idle();
  assert.equal(receiver.events(hook).length, 2);
});

test('retries: bounded attempts, exponential backoff, same eventId, fresh signature; 410 and 413 not retried', async (t) => {
  const { server } = await startServer(t, { maxAttempts: 3, baseDelayMs: 20 });
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  await subscribe(server.url, hook);
  const attemptsFor = async (statuses: number[]) => {
    receiver.behavior.statuses = [...statuses];
    const { eventId } = server.emit('comment.created', comment('doc_123'));
    await server.idle();
    receiver.behavior.statuses = [];
    return receiver.events(hook).filter((e) => e.json.eventId === eventId);
  };

  const failing = await attemptsFor([500, 500, 500, 500, 500]);
  assert.equal(failing.length, 3);
  assert.ok(failing.every((e) => e.headers['webhook-id'] === failing[0]!.json.eventId));
  assert.ok(failing[1]!.at - failing[0]!.at >= 18, 'first retry waits baseDelayMs');
  assert.ok(failing[2]!.at - failing[1]!.at >= 38, 'second retry waits 2 x baseDelayMs');

  assert.equal((await attemptsFor([503])).length, 2, 'stops after a 2xx');
  assert.equal((await attemptsFor([410, 500])).length, 1);
  assert.equal((await attemptsFor([413, 500])).length, 1);
  assert.equal((await attemptsFor([401, 200])).length, 2, 'other 4xx are retried');
  assert.deepEqual(receiver.rejected, [], 'every attempt carries a valid signature');
});

test('unsubscribe stops pending retries', async (t) => {
  const { server } = await startServer(t, { maxAttempts: 5, baseDelayMs: 200 });
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  await subscribe(server.url, hook);
  receiver.behavior.statuses = [500, 500, 500, 500, 500];

  server.emit('comment.created', comment('doc_123'));
  await unsubscribe(server.url, hook);
  await server.idle();
  assert.equal(receiver.events(hook).length, 1);
});

test('without allowInsecureCallbacks: http is invalid, loopback is never contacted', async (t) => {
  const { server } = await startServer(t, { allowInsecureCallbacks: false });
  const receiver = await startReceiver(t);
  const hook = receiver.hook();
  const port = new URL(receiver.base).port;

  const http = await subscribe(server.url, hook);
  assert.equal(http.error!.code, -32602);

  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const https = await subscribe(server.url, { ...hook, url: `https://${host}:${port}${hook.path}` });
    assert.deepEqual(https.error, { code: -32015, message: 'CallbackEndpointError', data: { reason: 'connection_refused' } }, host);
  }
  assert.equal(receiver.connections(), 0);
});
