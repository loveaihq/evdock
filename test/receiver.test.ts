import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReceiver } from '../src/http.js';
import { Inbox } from '../src/inbox.js';
import { handleDelivery, MAX_BODY_BYTES } from '../src/receiver.js';
import { close, listen, newSecret, newToken, officialSign, tempDir } from './helpers.js';

const NOW_MS = Date.UTC(2026, 9, 6, 12, 0, 0);
const NOW = NOW_MS / 1000;

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const { dir, cleanup } = tempDir();
  const inbox = new Inbox(join(dir, 'inbox.db'));
  const logs: string[] = [];
  const server = createReceiver({ inbox, now: () => NOW_MS, log: (line) => logs.push(line) });
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    inbox.close();
    cleanup();
  });

  function register(confirmedAs: string | null = 'sub_test') {
    const token = newToken();
    const secret = newSecret();
    inbox.addSubscription(token, secret);
    if (confirmedAs !== null) inbox.confirmSubscription(token, confirmedAs);
    return { token, secret, url: `${base}/hooks/${token}`, subscriptionId: confirmedAs ?? 'sub_pending' };
  }

  type Sub = ReturnType<typeof register>;
  async function post(
    sub: Sub,
    body: string,
    opts: { id?: string; ts?: number; signature?: string; omit?: string; subscriptionId?: string } = {},
  ) {
    const id = opts.id ?? `evt_${newToken().slice(0, 8)}`;
    const ts = opts.ts ?? NOW;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': opts.signature ?? officialSign(sub.secret, id, ts, body),
      'x-mcp-subscription-id': opts.subscriptionId ?? sub.subscriptionId,
    };
    if (opts.omit) delete headers[opts.omit];
    const res = await fetch(sub.url, { method: 'POST', headers, body });
    return { status: res.status, text: await res.text() };
  }

  return { inbox, base, logs, register, post };
}

const eventJson = (eventId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ eventId, name: 'incident.created', timestamp: '2026-10-06T12:00:00Z', data: { title: 'hello' }, ...extra });

test('valid event: 200 and stored, cursor saved', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  const res = await post(sub, eventJson('evt_1', { cursor: 'c1' }), { id: 'evt_1' });
  assert.equal(res.status, 200);
  const rows = inbox.messages(sub.token);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.eventId, 'evt_1');
  assert.equal(Buffer.from(rows[0]!.body).toString(), eventJson('evt_1', { cursor: 'c1' }), 'raw body stored as received');
  assert.equal(inbox.cursor(sub.token)?.cursor, 'c1');
});

test('duplicate webhook-id: 200, stored once (same request, and a retry with new timestamp and signature)', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  const body = eventJson('evt_dup');
  assert.equal((await post(sub, body, { id: 'evt_dup', ts: NOW - 60 })).status, 200);
  assert.equal((await post(sub, body, { id: 'evt_dup', ts: NOW - 60 })).status, 200);
  assert.equal((await post(sub, body, { id: 'evt_dup', ts: NOW })).status, 200);
  assert.equal(inbox.messages(sub.token).length, 1);
});

test('verification: echoes the challenge, even before the subscription is confirmed, and every time', async (t) => {
  const { inbox, register, post } = await setup(t);
  const pending = register(null);
  const body = JSON.stringify({ type: 'verification', challenge: 'nonce-123' });
  for (let i = 0; i < 2; i++) {
    const res = await post(pending, body, { id: 'msg_verification_1' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { challenge: 'nonce-123' });
  }
  const confirmed = register();
  const res = await post(confirmed, body, { id: 'msg_verification_2' });
  assert.deepEqual(JSON.parse(res.text), { challenge: 'nonce-123' });
  assert.equal(inbox.messages(pending.token).length + inbox.messages(confirmed.token).length, 0, 'not stored');
});

test('verification still needs a valid signature', async (t) => {
  const { register, post } = await setup(t);
  const sub = register(null);
  const body = JSON.stringify({ type: 'verification', challenge: 'nonce' });
  const res = await post(sub, body, { signature: officialSign(newSecret(), 'x', NOW, body) });
  assert.equal(res.status, 401);
});

test('registered but unconfirmed path: event gets 503 and is not stored', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register(null);
  assert.equal((await post(sub, eventJson('evt_early'))).status, 503);
  assert.equal(inbox.messages(sub.token).length, 0);
});

test('body over 256 KiB: 413; exactly 256 KiB is accepted', async (t) => {
  const { register, post } = await setup(t);
  const sub = register();
  const base = eventJson('evt_big', { data: { pad: '' } }).length;
  const exact = eventJson('evt_big', { data: { pad: 'x'.repeat(MAX_BODY_BYTES - base) } });
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);
  assert.equal((await post(sub, exact, { id: 'evt_big' })).status, 200);
  const over = eventJson('evt_bigger', { data: { pad: 'x'.repeat(MAX_BODY_BYTES - base + 1) } });
  assert.equal((await post(sub, over, { id: 'evt_bigger' })).status, 413);
});

test('missing any of the four required headers: 400', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  for (const header of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']) {
    assert.equal((await post(sub, eventJson('evt_h'), { id: 'evt_h', omit: header })).status, 400, header);
  }
  assert.equal(inbox.messages(sub.token).length, 0);
});

test('bad signature: 401', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  const body = eventJson('evt_bad');
  assert.equal((await post(sub, body, { signature: officialSign(newSecret(), 'evt_bad', NOW, body) })).status, 401);
  assert.equal((await post(sub, body, { signature: 'garbage' })).status, 401);
  assert.equal(inbox.messages(sub.token).length, 0);
});

test('timestamp more than 5 minutes off, either direction: 401; exactly 5 minutes: 200', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  assert.equal((await post(sub, eventJson('a'), { id: 'a', ts: NOW - 301 })).status, 401);
  assert.equal((await post(sub, eventJson('b'), { id: 'b', ts: NOW + 301 })).status, 401);
  assert.equal((await post(sub, eventJson('c'), { id: 'c', ts: NOW - 300 })).status, 200);
  assert.equal((await post(sub, eventJson('d'), { id: 'd', ts: NOW + 300 })).status, 200);
  assert.deepEqual(
    inbox.messages(sub.token).map((m) => m.webhookId),
    ['c', 'd'],
  );
});

test('malformed timestamp header or body: 400', async (t) => {
  const { register, post } = await setup(t);
  const sub = register();
  const body = eventJson('evt_x');
  const sig = officialSign(sub.secret, 'evt_x', NOW, body);
  const res = await fetch(sub.url, {
    method: 'POST',
    headers: {
      'webhook-id': 'evt_x',
      'webhook-timestamp': `${NOW}.0`,
      'webhook-signature': sig,
      'x-mcp-subscription-id': sub.subscriptionId,
    },
    body,
  });
  assert.equal(res.status, 400);
  assert.equal((await post(sub, '{"eventId": "e"}')).status, 400);
  assert.equal((await post(sub, 'not json')).status, 400);
});

test('unknown path: 404; wrong method: 405; X-MCP-Subscription-Id mismatch: 400', async (t) => {
  const { base, register, post } = await setup(t);
  const sub = register();
  const ghost = { ...sub, url: `${base}/hooks/${newToken()}` };
  assert.equal((await post(ghost, eventJson('e'))).status, 404);
  assert.equal((await fetch(`${base}/elsewhere`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(sub.url)).status, 405);
  assert.equal((await post(sub, eventJson('e'), { subscriptionId: 'sub_other' })).status, 400);
});

test('gap: 200, fresh cursor saved, possible gap marked', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  const res = await post(sub, JSON.stringify({ type: 'gap', cursor: 'fresh' }), { id: 'msg_gap_1' });
  assert.equal(res.status, 200);
  assert.deepEqual(inbox.cursor(sub.token), { cursor: 'fresh', possibleGap: true });
});

test('terminated: 200, subscription removed, later deliveries get 404', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  const body = JSON.stringify({ type: 'terminated', error: { code: -32012, message: 'Forbidden', data: { reason: 'Access revoked' } } });
  assert.equal((await post(sub, body, { id: 'msg_terminated_1' })).status, 200);
  assert.equal(inbox.getSubscription(sub.token), undefined);
  assert.equal(inbox.messages(sub.token).at(-1)?.kind, 'terminated');
  assert.equal((await post(sub, eventJson('late'))).status, 404);
});

test('unknown control type: 200 and stored for the client', async (t) => {
  const { inbox, register, post } = await setup(t);
  const sub = register();
  assert.equal((await post(sub, JSON.stringify({ type: 'future.thing' }), { id: 'msg_future_1' })).status, 200);
  assert.equal(inbox.messages(sub.token)[0]?.kind, 'unknown_control');
});

test('write failure: 503 so the server retries', () => {
  const secret = newSecret();
  const body = eventJson('evt_w');
  const result = handleDelivery(
    {
      getSubscription: (token) => ({ token, secret, subscriptionId: 'sub_w' }),
      store: () => {
        throw new Error('disk full');
      },
    },
    {
      token: 'tok',
      headers: {
        'webhook-id': 'evt_w',
        'webhook-timestamp': String(NOW),
        'webhook-signature': officialSign(secret, 'evt_w', NOW, body),
        'x-mcp-subscription-id': 'sub_w',
      },
      body: Buffer.from(body),
      receivedAtMs: NOW_MS,
    },
  );
  assert.equal(result.status, 503);
});

test('logs never contain the secret or the body', async (t) => {
  const { logs, register, post } = await setup(t);
  const sub = register();
  const marker = 'BODY-MARKER-7f3a';
  await post(sub, eventJson('evt_log', { data: { text: marker } }), { id: 'evt_log' });
  await post(sub, eventJson('evt_log2', { data: { text: marker } }), { id: 'evt_log2', signature: 'v1,bad' });
  await post(sub, JSON.stringify({ type: 'verification', challenge: marker }));
  assert.ok(logs.length >= 3);
  for (const line of logs) {
    assert.ok(!line.includes(marker), line);
    assert.ok(!line.includes(sub.secret.slice(6)), line);
    assert.ok(!line.includes(sub.token), 'full path token is not logged');
  }
});
