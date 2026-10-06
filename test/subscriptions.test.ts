import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { refreshDue } from '../src/daemon.js';
import { Inbox } from '../src/inbox.js';
import { McpClient } from '../src/mcp-client.js';
import { refresh, type Context } from '../src/subscriptions.js';
import { activeSubscription, close, listen, newSecret, tempDir } from './helpers.js';

/** An MCP endpoint whose events/subscribe answers with the given JSON-RPC error. */
async function failingServer(t: { after: (fn: () => Promise<void>) => void }, code: number, data?: unknown, message = 'nope') {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { id } = JSON.parse(raw) as { id: number };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }));
  });
  const base = await listen(server);
  t.after(() => close(server));
  return `${base}/mcp`;
}

function inboxWithSubscription(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const inbox = new Inbox(join(dir, 'x.db'));
  t.after(() => {
    inbox.close();
    cleanup();
  });
  inbox.addSubscription({
    token: 'tok',
    secret: newSecret(),
    server: 's',
    eventName: 'e',
    arguments: '{"a":1}',
    callbackUrl: 'https://h/hooks/tok',
  });
  inbox.confirmSubscription('tok', 'sub_1');
  const logs: string[] = [];
  const ctx: Context = { inbox, client: () => assert.fail('not used'), now: Date.now, log: (l) => logs.push(l) };
  return { inbox, ctx, logs };
}

for (const [code, data, expected, message] of [
  [-32024, undefined, 'stopped', undefined],
  [-32012, undefined, 'stopped', 'Forbidden'],
  [-32012, undefined, 'failed', 'database busy'], // legacy range, meaning not corroborated: retry
  [-32023, { kind: 'event' }, 'stopped', undefined],
  [-32026, { feature: 'inputSchema', reason: 'schema_changed' }, 'stopped', undefined],
  [-32602, undefined, 'stopped', undefined],
  [-32027, { reason: 'timeout' }, 'failed', undefined],
  [-32025, { limit: 'subscriptions' }, 'failed', undefined],
  [-32603, undefined, 'failed', undefined],
] as const) {
  test(`refresh: error ${code}${message ? ` "${message}"` : ''} -> ${expected}`, async (t) => {
    const url = await failingServer(t, code, data, message);
    const { inbox, ctx } = inboxWithSubscription(t);
    const outcome = await refresh(ctx, new McpClient({ url, token: 't' }), inbox.getSubscription('tok')!);
    assert.equal(outcome, expected);
    const sub = inbox.getSubscription('tok')!;
    assert.equal(sub.status, expected === 'stopped' ? 'stopped' : 'active');
    assert.match(sub.lastError ?? '', new RegExp(String(code)));
  });
}

test('refresh: an unreachable server is a retryable failure', async (t) => {
  const { inbox, ctx } = inboxWithSubscription(t);
  const outcome = await refresh(ctx, new McpClient({ url: 'http://127.0.0.1:1/mcp', token: 't' }), inbox.getSubscription('tok')!);
  assert.equal(outcome, 'failed');
  assert.equal(inbox.getSubscription('tok')?.status, 'active');
});

test('refresh: if the subscription ended during the call, the server-side one is unsubscribed again', async (t) => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { id, method } = JSON.parse(raw) as { id: number; method: string };
    methods.push(method);
    const result = method === 'events/subscribe' ? { id: 'sub_1', refreshBefore: '2099-01-01T00:00:00Z', cursor: null } : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  const url = `${await listen(server)}/mcp`;
  t.after(() => close(server));
  const { inbox, ctx } = inboxWithSubscription(t);
  const sub = inbox.getSubscription('tok')!;
  inbox.setStatus('tok', 'unsubscribed'); // `evdock unsubscribe` won the race
  assert.equal(await refresh(ctx, new McpClient({ url, token: 't' }), sub), 'ended');
  assert.deepEqual(methods, ['events/subscribe', 'events/unsubscribe']);
  assert.equal(inbox.getSubscription('tok')?.status, 'unsubscribed');
});

test('refreshDue: two thirds of the grant, at least one second, hourly without expiry', () => {
  const sub = { ...activeSubscription('t', 's'), grantedAt: 10_000 };
  assert.equal(refreshDue({ ...sub, refreshBefore: 10_000 + 30_000 }), 10_000 + 20_000);
  assert.equal(refreshDue({ ...sub, refreshBefore: 10_000 + 300 }), 10_000 + 1000);
  assert.equal(refreshDue({ ...sub, refreshBefore: null }), 10_000 + 3_600_000);
  assert.equal(refreshDue({ ...sub, grantedAt: null }), 0);
});
