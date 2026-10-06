// End to end through the relay: the mock MCP server delivers to the Node relay, the daemon
// fetches from it (docs/M3-TASK.md acceptance 2, automated). The relay stays up throughout,
// which is the point: the daemon can be away for longer than the timestamp window, the
// server's retry window and the subscription's TTL, and still get every event exactly once.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { startMockServer, type MockServer } from '../src/conformance/mock-server.js';
import { startDaemon, type Daemon } from '../src/daemon.js';
import type { Server } from '../src/inbox.js';
import { McpClient } from '../src/mcp-client.js';
import { RelayClient } from '../src/relay-client.js';
import { startRelayServer, type RelayServer } from '../src/relay/node.js';
import { subscribe, unsubscribe, type Context } from '../src/subscriptions.js';
import { tempDir } from './helpers.js';

const TOKEN = 'mock-token';
const RELAY_KEY = 'relay-key-e2e';
const client = (server: Server) => new McpClient({ url: server.url, token: TOKEN });

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
  relayServer: RelayServer;
  relay: RelayClient;
  logs: string[];
  start(options?: { now?: () => number; relay?: RelayClient }): Promise<Daemon>;
  ctx(daemon: Daemon): Context;
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Setup> {
  const { dir, cleanup } = tempDir();
  const mock = await startMockServer({
    token: TOKEN,
    eventTypes: [
      { name: 'incident.created', description: 'x', inputSchema: { type: 'object' }, payloadSchema: { type: 'object' }, replay: true },
    ],
    defaultTtlMs: 3000,
    retry: { attempts: 3, baseDelayMs: 50 },
    allowInsecureCallbacks: true,
  });
  const relayServer = await startRelayServer({ dbPath: join(dir, 'relay.db'), key: RELAY_KEY, port: 0 });
  const relay = new RelayClient(relayServer.url, RELAY_KEY);
  const logs: string[] = [];
  const daemons: Daemon[] = [];
  t.after(async () => {
    for (const d of daemons) await d.stop().catch(() => {});
    await relayServer.close();
    await mock.close();
    cleanup();
  });
  return {
    mock,
    relayServer,
    relay,
    logs,
    // port 0: in relay mode nothing has to reach the daemon, so its own port does not matter.
    async start(options = {}) {
      const daemon = await startDaemon({
        dbPath: join(dir, 'evdock.db'),
        port: 0,
        client,
        relay: options.relay ?? relay,
        tickMs: 50,
        pollMs: 50,
        now: options.now,
        log: (line) => logs.push(line),
      });
      daemons.push(daemon);
      return daemon;
    },
    ctx: (daemon) => ({ inbox: daemon.inbox, client, now: Date.now, log: (l) => logs.push(l), relay }),
  };
}

const eventIds = (daemon: Daemon, token: string) =>
  daemon.inbox
    .messages(token)
    .filter((m) => m.kind === 'event')
    .map((m) => m.eventId!);

async function subscribed(s: Setup, daemon: Daemon) {
  daemon.inbox.addServer({ name: 'mock', url: s.mock.url, tokenEnv: 'UNUSED' });
  return subscribe(s.ctx(daemon), { server: 'mock', eventName: 'incident.created', arguments: {} });
}

test('through the relay: handshake answered by the relay, events fetched and verified', async (t) => {
  const s = await setup(t);
  const daemon = await s.start();
  const sub = await subscribed(s, daemon);
  assert.ok(sub.callbackUrl?.startsWith(`${s.relayServer.url}/hooks/`), 'callback goes to the relay');
  assert.equal(sub.status, 'active');

  const sent = [s.mock.emit('incident.created', { n: 1 }).eventId, s.mock.emit('incident.created', { n: 2 }).eventId];
  await until('both events', () => eventIds(daemon, sub.token).length === 2);
  assert.deepEqual(eventIds(daemon, sub.token), sent);
  assert.ok(s.logs.some((l) => l.startsWith('200 stored-event') && l.includes('(relay #')), 'verified and stored by the daemon');
  assert.deepEqual((await s.relay.fetchDeliveries()).deliveries, [], 'acknowledged, so the relay forgot them');
});

test('away longer than the 5-minute window, the retry window and the TTL: every event, once', async (t) => {
  const s = await setup(t);
  let daemon = await s.start();
  const sub = await subscribed(s, daemon);
  const emitted: string[] = [];
  const emit = (n: number) => emitted.push(s.mock.emit('incident.created', { n }).eventId);
  emit(1);
  await until('first event', () => eventIds(daemon, sub.token).length === 1);

  await daemon.stop();
  emit(2); // stored by the relay right away: no failed deliveries, nothing abandoned
  emit(3);
  await sleep(4000); // past the 3 s TTL: the subscription lapses without refreshes
  emit(4); // after the lapse the server sends nothing; the resubscribe on start replays it
  assert.ok(s.mock.attempts().every((a) => a.status === 200), 'the relay accepted every delivery');

  // Back with a clock ten minutes ahead: the relay's receive time is what the window is checked
  // against, so nothing is rejected as stale however long the daemon was away.
  daemon = await s.start({ now: () => Date.now() + 10 * 60 * 1000 });
  emit(5);
  await until('all five', () => eventIds(daemon, sub.token).length >= 5);
  await sleep(300);
  const received = eventIds(daemon, sub.token);
  assert.deepEqual([...received].sort(), [...emitted].sort());
  assert.equal(new Set(received).size, received.length);
  assert.ok(!s.logs.some((l) => l.includes('stale-timestamp')), 'nothing rejected as stale');
});

test('unsubscribe removes the path from the relay', async (t) => {
  const s = await setup(t);
  const daemon = await s.start();
  const sub = await subscribed(s, daemon);
  await unsubscribe(s.ctx(daemon), daemon.inbox.getSubscription(sub.token)!);
  const res = await fetch(sub.callbackUrl!, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
});

test('terminated through the relay: stored, subscription marked, path removed from the relay', async (t) => {
  const s = await setup(t);
  const daemon = await s.start();
  const sub = await subscribed(s, daemon);
  await s.mock.terminate(sub.subscriptionId!);
  await until('terminated', () => daemon.inbox.getSubscription(sub.token)?.status === 'terminated');
  await until('path removed', () => s.logs.some((l) => l.includes('stored-terminated')));
  await sleep(200);
  assert.equal((await fetch(sub.callbackUrl!, { method: 'POST', body: '{}' })).status, 404);
});

test('a wrong relay key is reported and retried, not fatal', async (t) => {
  const s = await setup(t);
  await s.start({ relay: new RelayClient(s.relayServer.url, 'wrong-key') });
  await until('a fetch failure', () => s.logs.some((l) => l.includes('relay fetch failed') && l.includes('401')));
});
