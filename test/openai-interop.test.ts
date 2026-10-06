// evdock's client and daemon against the server written from OpenAI's MCP Events guide
// (docs/M2-TASK.md acceptance 2, second server). That server differs from SEP-3415 on purpose:
// top-level `events` capability, no resultType on events/* results, -32015, idempotent
// unsubscribe, cursor always null.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDaemon } from '../src/daemon.js';
import type { Server } from '../src/inbox.js';
import { McpClient } from '../src/mcp-client.js';
import { subscribe, unsubscribe, type Context } from '../src/subscriptions.js';
import { startOpenAiServer } from './fixtures/openai-server.js';
import { tempDir } from './helpers.js';

const TOKEN = 'openai-token';
const client = (server: Server) => new McpClient({ url: server.url, token: TOKEN });

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('lifecycle against the OpenAI-guide server: subscribe, deliveries, refreshes, unsubscribe', async (t) => {
  const { dir, cleanup } = tempDir();
  const server = await startOpenAiServer({
    token: TOKEN,
    storePath: join(dir, 'openai-store.json'),
    defaultTtlMs: 3000,
    maxAttempts: 3,
    baseDelayMs: 50,
    allowInsecureCallbacks: true,
  });
  const logs: string[] = [];
  const daemon = await startDaemon({ dbPath: join(dir, 'evdock.db'), port: 0, client, tickMs: 50, log: (l) => logs.push(l) });
  t.after(async () => {
    await daemon.stop();
    await server.close();
    cleanup();
  });
  const ctx: Context = { inbox: daemon.inbox, client, now: Date.now, log: (l) => logs.push(l) };
  daemon.inbox.addServer({ name: 'openai', url: server.url, tokenEnv: 'UNUSED' });

  const sub = await subscribe(ctx, {
    server: 'openai',
    eventName: 'comment.created',
    arguments: { document_id: 'doc_123' },
    callbackBase: daemon.url,
  });
  assert.equal(sub.status, 'active');
  assert.match(sub.subscriptionId ?? '', /^sub_/);

  const comment = (id: string, doc = 'doc_123') => ({ document_id: doc, comment_id: id, text: 'hi', url: `https://docs.example.com/${doc}#${id}` });
  const sent = [server.emit('comment.created', comment('c1')).eventId, server.emit('comment.created', comment('c2')).eventId];
  server.emit('comment.created', comment('c3', 'doc_other'));
  const received = () => daemon.inbox.messages(sub.token).filter((m) => m.kind === 'event').map((m) => m.eventId);
  await until('two deliveries', () => received().length === 2);
  assert.deepEqual(received(), sent);
  assert.equal(daemon.inbox.cursor(sub.token), undefined, 'cursor is always null on this server: nothing saved');

  await until('two refreshes', () => logs.filter((l) => l.startsWith('refreshed')).length >= 2, 8000);
  assert.equal(daemon.inbox.getSubscription(sub.token)?.status, 'active');

  await unsubscribe(ctx, daemon.inbox.getSubscription(sub.token)!);
  // Idempotent on this server: a second unsubscribe is fine too.
  await unsubscribe(ctx, { ...daemon.inbox.getSubscription(sub.token)!, status: 'active' });
  server.emit('comment.created', comment('c4'));
  await server.idle();
  assert.equal(received().length, 2, 'nothing after unsubscribe');
});
