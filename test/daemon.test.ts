// End-to-end: evdock's daemon and subscription manager against the mock server (SEP-3415 profile).
// Covers docs/M2-TASK.md acceptance 2 (full lifecycle) and 3 (restart without duplicates or losses).

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { startMockServer, type MockServer, type MockServerOptions } from '../src/conformance/mock-server.js';
import { startDaemon, type Daemon } from '../src/daemon.js';
import type { Server } from '../src/inbox.js';
import { listEvents } from '../src/events-api.js';
import { McpClient, TransportError } from '../src/mcp-client.js';
import { refresh, subscribe, unsubscribe, type Context } from '../src/subscriptions.js';
import { tempDir } from './helpers.js';

const TOKEN = 'mock-token';
const client = (server: Server) => new McpClient({ url: server.url, token: TOKEN });

const EVENT_TYPE = {
  name: 'incident.created',
  description: 'A new incident',
  inputSchema: { type: 'object', properties: { severity: { type: 'string' } } },
  payloadSchema: { type: 'object' },
  replay: true,
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Setup {
  mock: MockServer;
  dbPath: string;
  port: number;
  logs: string[];
  start(clientFactory?: (server: Server) => McpClient): Promise<Daemon>;
  ctx(daemon: Daemon): Context;
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, mockOptions: Partial<MockServerOptions> = {}): Promise<Setup> {
  const { dir, cleanup } = tempDir();
  const mock = await startMockServer({
    token: TOKEN,
    eventTypes: [EVENT_TYPE],
    defaultTtlMs: 3000,
    retry: { attempts: 3, baseDelayMs: 50 },
    allowInsecureCallbacks: true,
    ...mockOptions,
  });
  const port = await freePort();
  const logs: string[] = [];
  const daemons: Daemon[] = [];
  t.after(async () => {
    for (const d of daemons) await d.stop().catch(() => {});
    await mock.close();
    cleanup();
  });
  const dbPath = join(dir, 'evdock.db');
  return {
    mock,
    dbPath,
    port,
    logs,
    async start(clientFactory = client) {
      const daemon = await startDaemon({ dbPath, port, client: clientFactory, tickMs: 50, log: (line) => logs.push(line) });
      daemons.push(daemon);
      return daemon;
    },
    ctx: (daemon) => ({ inbox: daemon.inbox, client, now: Date.now, log: (line) => logs.push(line) }),
  };
}

function eventIds(daemon: Daemon, token: string): string[] {
  return daemon.inbox
    .messages(token)
    .filter((m) => m.kind === 'event')
    .map((m) => m.eventId!);
}

async function subscribed(s: Setup, daemon: Daemon) {
  daemon.inbox.addServer({ name: 'mock', url: s.mock.url, tokenEnv: 'UNUSED' });
  return subscribe(s.ctx(daemon), {
    server: 'mock',
    eventName: 'incident.created',
    arguments: { severity: 'P1' },
    callbackBase: daemon.url,
  });
}

test('lifecycle: discover, list, subscribe with handshake, deliveries, refreshes, quiet-period cursor, unsubscribe', async (t) => {
  const OTHER = { ...EVENT_TYPE, name: 'incident.resolved', description: 'An incident was resolved' };
  const s = await setup(t, { listPageSize: 1, sseResponses: true, eventTypes: [EVENT_TYPE, OTHER] });
  const daemon = await s.start();
  const listed = await listEvents(client({ name: 'mock', url: s.mock.url, tokenEnv: 'UNUSED' }));
  assert.deepEqual(
    listed.map((e) => [e.name, e.delivery]),
    [
      ['incident.created', ['webhook']],
      ['incident.resolved', ['webhook']],
    ],
    'two pages, one event type each',
  );
  const sub = await subscribed(s, daemon);
  assert.equal(sub.status, 'active');
  assert.match(sub.subscriptionId ?? '', /^sub_/);
  assert.equal(s.mock.subscriptions()[0]?.verified, true);

  const emitted = [s.mock.emit('incident.created', { severity: 'P1', n: 1 }), s.mock.emit('incident.created', { severity: 'P1', n: 2 })];
  const filtered = s.mock.emit('incident.created', { severity: 'P3', n: 3 }); // not delivered: arguments don't match
  await until('two deliveries', () => eventIds(daemon, sub.token).length === 2);
  assert.deepEqual(eventIds(daemon, sub.token), emitted.map((e) => e.eventId));

  // Two refreshes (TTL 3 s, refresh at 2 s) with no deliveries: the saved cursor still moves to the
  // server's watermark, past the filtered event too.
  const firstGrant = daemon.inbox.getSubscription(sub.token)!.grantedAt!;
  await until('two refreshes', () => s.logs.filter((l) => l.startsWith('refreshed')).length >= 2, 8000);
  assert.ok(daemon.inbox.getSubscription(sub.token)!.grantedAt! > firstGrant);
  assert.equal(daemon.inbox.cursor(sub.token)?.cursor, filtered.cursor);
  assert.equal(s.mock.subscriptions().length, 1, 'refresh kept one subscription');

  await unsubscribe(s.ctx(daemon), daemon.inbox.getSubscription(sub.token)!);
  assert.equal(daemon.inbox.getSubscription(sub.token)?.status, 'unsubscribed');
  assert.equal(s.mock.subscriptions().length, 0);
  s.mock.emit('incident.created', { severity: 'P1', n: 4 });
  await sleep(300);
  assert.equal(eventIds(daemon, sub.token).length, 2, 'nothing after unsubscribe');
});

// Acceptance 3: kill the daemon while events keep coming, restart, compare with what the server produced.
for (const [name, downMs] of [
  ['a. down shorter than the retry window', 60],
  ['b. down longer than the retry window, shorter than the TTL', 1200],
  ['c. down longer than the TTL', 4000],
] as const) {
  test(`restart without duplicates or losses: ${name}`, async (t) => {
    const s = await setup(t);
    let daemon = await s.start();
    const sub = await subscribed(s, daemon);
    const emitted: string[] = [];
    const emit = (n: number) => emitted.push(s.mock.emit('incident.created', { severity: 'P1', n }).eventId);

    for (let n = 1; n <= 3; n++) emit(n);
    await until('first three', () => eventIds(daemon, sub.token).length === 3);

    await daemon.stop();
    for (let n = 4; n <= 6; n++) emit(n);
    await sleep(downMs);
    daemon = await s.start();
    for (let n = 7; n <= 8; n++) emit(n);

    await until('all eight', () => eventIds(daemon, sub.token).length >= 8);
    await sleep(300); // let any late duplicates arrive
    const received = eventIds(daemon, sub.token);
    assert.deepEqual([...received].sort(), [...emitted].sort(), 'same set as produced');
    assert.equal(new Set(received).size, received.length, 'each once');
  });
}

test('restart while the MCP server is briefly unreachable: the resubscribe is retried, nothing lost', async (t) => {
  const s = await setup(t);
  let daemon = await s.start();
  const sub = await subscribed(s, daemon);
  const emitted = [s.mock.emit('incident.created', { severity: 'P1', n: 1 }).eventId];
  await until('first event', () => eventIds(daemon, sub.token).length === 1);

  await daemon.stop();
  emitted.push(s.mock.emit('incident.created', { severity: 'P1', n: 2 }).eventId);
  await sleep(1200); // retries exhausted, subscription still live: the gap case

  // The first two MCP calls after the restart fail as if the server were unreachable.
  let failures = 2;
  const flaky = (server: Server) => {
    const real = client(server);
    return Object.assign(Object.create(real) as McpClient, {
      request: (method: string, params?: Record<string, unknown>) =>
        failures-- > 0 ? Promise.reject(new TransportError(`${method}: ECONNREFUSED`)) : real.request(method, params),
      discover: () => (failures-- > 0 ? Promise.reject(new TransportError('server/discover: ECONNREFUSED')) : real.discover()),
    });
  };
  daemon = await s.start(flaky);
  assert.ok(s.logs.some((l) => l.includes('failed, will retry')), 'the first attempt failed');

  await until('the abandoned event', () => eventIds(daemon, sub.token).length === 2, 8000);
  assert.deepEqual([...eventIds(daemon, sub.token)].sort(), [...emitted].sort());
  assert.ok(s.logs.some((l) => l.startsWith('resubscribed')), 'the retry was a resubscribe, not a plain refresh');
});

test('the spec gap: without the resubscribe, events abandoned while down are lost', async (t) => {
  const s = await setup(t);
  let daemon = await s.start();
  const sub = await subscribed(s, daemon);
  s.mock.emit('incident.created', { severity: 'P1', n: 1 });
  await until('first event', () => eventIds(daemon, sub.token).length === 1);

  await daemon.stop();
  const lost = s.mock.emit('incident.created', { severity: 'P1', n: 2 }).eventId;
  await sleep(1200); // retries exhausted, subscription still live

  // Restart by hand with a plain refresh only, as a client following the spec literally would.
  const { Inbox } = await import('../src/inbox.js');
  const inbox = new Inbox(s.dbPath);
  try {
    const ctx: Context = { inbox, client, now: Date.now, log: () => {} };
    const outcome = await refresh(ctx, client({ name: 'mock', url: s.mock.url, tokenEnv: 'UNUSED' }), inbox.getSubscription(sub.token)!);
    assert.equal(outcome, 'refreshed');
    assert.equal(inbox.cursor(sub.token)?.possibleGap, false, 'no truncated signal');
    const ids = inbox.messages(sub.token).map((m) => m.eventId);
    assert.ok(!ids.includes(lost), 'the abandoned event never arrives');
  } finally {
    inbox.close();
  }
});

test('terminated envelope stops refreshing', async (t) => {
  const s = await setup(t);
  const daemon = await s.start();
  const sub = await subscribed(s, daemon);
  await s.mock.terminate(sub.subscriptionId!);
  await until('terminated', () => daemon.inbox.getSubscription(sub.token)?.status === 'terminated');
  const refreshes = s.logs.filter((l) => l.startsWith('refreshed')).length;
  await sleep(2500);
  assert.equal(s.logs.filter((l) => l.startsWith('refreshed')).length, refreshes, 'no refresh after terminated');
  assert.equal(s.mock.subscriptions().length, 0);
});
