import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StoredMessage } from '../src/inbox.js';
import { Inbox } from '../src/inbox.js';
import { newSecret, tempDir } from './helpers.js';

function setup() {
  const { dir, cleanup } = tempDir();
  const path = join(dir, 'inbox.db');
  const inbox = new Inbox(path);
  return {
    path,
    inbox,
    done: () => {
      inbox.close();
      cleanup();
    },
  };
}

const event = (eventId: string, cursor: string | null = null): StoredMessage => ({
  kind: 'event',
  eventId,
  name: 'n',
  timestamp: 't',
  cursor,
});

function put(inbox: Inbox, token: string, webhookId: string, message: StoredMessage) {
  return inbox.store({ token, subscriptionId: `sub_${token}`, webhookId, message, body: Buffer.from('{}'), receivedAtMs: 1 });
}

test('subscriptions: pending until the server id is recorded', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  const secret = newSecret();
  inbox.addSubscription({ token: 'tok', secret });
  const pending = inbox.getSubscription('tok');
  assert.equal(pending?.secret, secret);
  assert.equal(pending?.subscriptionId, null);
  assert.equal(pending?.status, 'pending');
  inbox.confirmSubscription('tok', 'sub_1');
  assert.equal(inbox.getSubscription('tok')?.subscriptionId, 'sub_1');
  assert.equal(inbox.getSubscription('tok')?.status, 'active');
  assert.equal(inbox.getSubscription('other'), undefined);
  assert.throws(() => inbox.confirmSubscription('other', 'sub_2'));
});

test('applyGrant activates, saves a non-null cursor, marks truncated, and ignores ended subscriptions', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  inbox.addSubscription({ token: 'a', secret: newSecret(), server: 's', eventName: 'e', arguments: '{}', callbackUrl: 'u' });
  assert.equal(inbox.applyGrant('a', { id: 'sub_a', refreshBefore: 5000, cursor: 'c1', truncated: false }, 1000), true);
  let sub = inbox.getSubscription('a');
  assert.equal(sub?.status, 'active');
  assert.equal(sub?.subscriptionId, 'sub_a');
  assert.equal(sub?.refreshBefore, 5000);
  assert.equal(sub?.grantedAt, 1000);
  assert.deepEqual(inbox.cursor('a'), { cursor: 'c1', possibleGap: false });

  inbox.applyGrant('a', { id: 'sub_a', refreshBefore: 9000, cursor: null, truncated: true }, 2000);
  assert.deepEqual(inbox.cursor('a'), { cursor: 'c1', possibleGap: false }, 'null cursor: saved one kept, truncated ignored');
  inbox.applyGrant('a', { id: 'sub_a', refreshBefore: 9000, cursor: 'c5', truncated: true }, 2000);
  assert.deepEqual(inbox.cursor('a'), { cursor: 'c5', possibleGap: true });

  inbox.setStatus('a', 'terminated', 'gone');
  assert.equal(inbox.applyGrant('a', { id: 'sub_a', refreshBefore: 9999, cursor: 'c2', truncated: false }, 3000), false);
  sub = inbox.getSubscription('a');
  assert.equal(sub?.status, 'terminated');
  assert.equal(inbox.cursor('a')?.cursor, 'c5');
});

test('a permanent refresh error or a terminated envelope does not overwrite an already-ended status', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  inbox.addSubscription({ token: 'a', secret: newSecret() });
  inbox.confirmSubscription('a', 'sub_a');
  inbox.setStatus('a', 'unsubscribed');
  inbox.stopSubscription('a', 'Forbidden');
  put(inbox, 'a', 'msg_terminated_1', { kind: 'terminated', code: -32024, message: 'Forbidden' });
  assert.equal(inbox.getSubscription('a')?.status, 'unsubscribed');
  assert.equal(inbox.getSubscription('a')?.lastError, null);

  inbox.addSubscription({ token: 'b', secret: newSecret() });
  inbox.confirmSubscription('b', 'sub_b');
  inbox.stopSubscription('b', 'Forbidden -32024');
  assert.equal(inbox.getSubscription('b')?.status, 'stopped');
  assert.equal(inbox.getSubscription('b')?.lastError, 'Forbidden -32024');
});

test('servers: stored by name with the token variable name only', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  inbox.addServer({ name: 'mock', url: 'http://x/mcp', tokenEnv: 'MOCK_TOKEN' });
  assert.deepEqual(inbox.getServer('mock'), { name: 'mock', url: 'http://x/mcp', tokenEnv: 'MOCK_TOKEN' });
  inbox.addServer({ name: 'mock', url: 'http://y/mcp', tokenEnv: 'MOCK_TOKEN' });
  assert.equal(inbox.getServer('mock')?.url, 'http://y/mcp');
  assert.equal(inbox.getServer('other'), undefined);
});

test('a repeated webhook-id on the same path is stored once', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  assert.equal(put(inbox, 'a', 'evt_1', event('evt_1')), 'stored');
  assert.equal(put(inbox, 'a', 'evt_1', event('evt_1')), 'duplicate');
  assert.equal(inbox.messages('a').length, 1);
});

test('the same webhook-id on two subscriptions is stored for each', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  assert.equal(put(inbox, 'a', 'evt_1', event('evt_1')), 'stored');
  assert.equal(put(inbox, 'b', 'evt_1', event('evt_1')), 'stored');
  assert.equal(inbox.messages('a').length, 1);
  assert.equal(inbox.messages('b').length, 1);
});

test('cursor: the latest non-null cursor is kept; null cursors are not persisted', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  put(inbox, 'a', 'e1', event('e1', 'c1'));
  assert.deepEqual(inbox.cursor('a'), { cursor: 'c1', possibleGap: false });
  put(inbox, 'a', 'e2', event('e2', null));
  assert.deepEqual(inbox.cursor('a'), { cursor: 'c1', possibleGap: false });
  put(inbox, 'a', 'e3', event('e3', 'c3'));
  assert.equal(inbox.cursor('a')?.cursor, 'c3');
  put(inbox, 'a', 'e1', event('e1', 'c1'));
  assert.equal(inbox.cursor('a')?.cursor, 'c3', 'a duplicate does not move the cursor');
});

test('gap stores the fresh cursor and marks a possible gap', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  put(inbox, 'a', 'e1', event('e1', 'c1'));
  assert.equal(put(inbox, 'a', 'msg_gap_1', { kind: 'gap', cursor: 'fresh' }), 'stored');
  assert.deepEqual(inbox.cursor('a'), { cursor: 'fresh', possibleGap: true });
  put(inbox, 'a', 'msg_gap_2', { kind: 'gap', cursor: null });
  assert.deepEqual(inbox.cursor('a'), { cursor: 'fresh', possibleGap: true });
  assert.deepEqual(
    inbox.messages('a').map((m) => m.kind),
    ['event', 'gap', 'gap'],
  );
});

test('terminated marks the subscription, keeps the cursor, and is kept as a message', (t) => {
  const { inbox, done } = setup();
  t.after(done);
  inbox.addSubscription({ token: 'a', secret: newSecret() });
  inbox.confirmSubscription('a', 'sub_a');
  put(inbox, 'a', 'e1', event('e1', 'c1'));
  assert.equal(put(inbox, 'a', 'msg_terminated_1', { kind: 'terminated', code: -32012, message: 'Forbidden' }), 'stored');
  assert.equal(inbox.getSubscription('a')?.status, 'terminated');
  assert.match(inbox.getSubscription('a')?.lastError ?? '', /-32012 Forbidden/);
  assert.equal(inbox.cursor('a')?.cursor, 'c1');
  assert.deepEqual(
    inbox.messages('a').map((m) => m.kind),
    ['event', 'terminated'],
  );
});

test('stored messages survive closing and reopening the database', () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, 'inbox.db');
    const first = new Inbox(path);
    first.addSubscription({ token: 'a', secret: newSecret() });
    put(first, 'a', 'e1', event('e1', 'c1'));
    first.close();
    const second = new Inbox(path);
    assert.equal(second.messages('a').length, 1);
    assert.equal(second.cursor('a')?.cursor, 'c1');
    assert.equal(put(second, 'a', 'e1', event('e1', 'c1')), 'duplicate');
    second.close();
  } finally {
    cleanup();
  }
});
