import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { describeError, errorName, listEvents, subscribe, unsubscribe } from '../src/events-api.js';
import { McpClient, McpError, supportsEvents, TransportError } from '../src/mcp-client.js';
import { close, listen } from './helpers.js';

interface Seen {
  headers: IncomingMessage['headers'];
  body: { id: number; method: string; params: Record<string, unknown> };
}

type Reply = (seen: Seen, res: ServerResponse) => void;

/** A stub MCP endpoint: records each request and answers with the next scripted reply. */
async function stub(t: { after: (fn: () => Promise<void>) => void }, replies: Reply[]) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { headers: req.headers, body: JSON.parse(raw) as Seen['body'] };
    seen.push(entry);
    const reply = replies.shift();
    if (!reply) return res.writeHead(500).end();
    reply(entry, res);
  });
  const base = await listen(server);
  t.after(() => close(server));
  return { url: `${base}/mcp`, seen };
}

const json = (result: unknown): Reply => (seen, res) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: seen.body.id, result }));

const error = (status: number, code: number, message: string, data?: unknown): Reply => (seen, res) =>
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: seen.body.id, error: { code, message, data } }));

test('every request carries the 2026-07-28 headers, bearer token and _meta envelope', async (t) => {
  const { url, seen } = await stub(t, [json({ resultType: 'complete', ok: true })]);
  const result = await new McpClient({ url, token: 'secret-token' }).request('events/list', { cursor: 'p2' });
  assert.equal(result.ok, true);
  const { headers, body } = seen[0]!;
  assert.equal(headers['mcp-protocol-version'], '2026-07-28');
  assert.equal(headers['mcp-method'], 'events/list');
  assert.equal(headers.authorization, 'Bearer secret-token');
  assert.equal(headers['content-type'], 'application/json');
  assert.match(headers.accept ?? '', /application\/json/);
  assert.match(headers.accept ?? '', /text\/event-stream/);
  assert.equal(body.method, 'events/list');
  assert.equal(body.params.cursor, 'p2');
  assert.deepEqual(body.params._meta, {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } },
    'io.modelcontextprotocol/clientInfo': { name: 'evdock', version: '0.0.0' },
  });
});

test('reads the response out of an SSE stream, skipping notifications and comments', async (t) => {
  const { url } = await stub(t, [
    (seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\r\n\r\n');
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
      // The response split across chunks and data lines.
      res.write(`data: {"jsonrpc":"2.0","id":${seen.body.id},\r\n`);
      setTimeout(() => res.end('data: "result":{"value":42}}\r\n\r\n'), 10);
    },
  ]);
  const result = await new McpClient({ url, token: 't' }).request('events/list');
  assert.equal(result.value, 42);
});

test('a stream that ends without the response is re-issued once with a new id', async (t) => {
  const { url, seen } = await stub(t, [
    (_seen, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(': nothing\n\n'),
    json({ second: true }),
  ]);
  const result = await new McpClient({ url, token: 't' }).request('events/subscribe');
  assert.equal(result.second, true);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.body.id, seen[1]!.body.id);
});

test('JSON-RPC errors become McpError; HTTP failures become TransportError', async (t) => {
  const { url } = await stub(t, [
    error(400, -32022, 'Unsupported protocol version', { supported: ['2025-11-25'], requested: '2026-07-28' }),
    (_seen, res) => res.writeHead(401).end(),
    (_seen, res) => res.writeHead(502).end('bad gateway'),
    json({ resultType: 'input_required' }),
  ]);
  const client = new McpClient({ url, token: 't' });
  await assert.rejects(client.request('x'), (err: unknown) => err instanceof McpError && err.code === -32022);
  await assert.rejects(client.request('x'), (err: unknown) => err instanceof TransportError && err.httpStatus === 401);
  await assert.rejects(client.request('x'), (err: unknown) => err instanceof TransportError && err.httpStatus === 502);
  await assert.rejects(client.request('x'), /unsupported resultType/);
});

test('discover requires 2026-07-28; Events may be advertised in either place', async (t) => {
  const { url } = await stub(t, [
    json({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { extensions: { 'io.modelcontextprotocol/events': {} } } }),
    json({ supportedVersions: ['2025-11-25'], capabilities: {} }),
  ]);
  const client = new McpClient({ url, token: 't' });
  assert.equal(supportsEvents(await client.discover()), true);
  await assert.rejects(client.discover(), /does not support MCP 2026-07-28/);

  assert.equal(supportsEvents({ events: {} }), true, 'design sketch / OpenAI guide');
  assert.equal(supportsEvents({ extensions: { 'io.modelcontextprotocol/events': {} } }), true, 'SEP-3415');
  assert.equal(supportsEvents({ tools: {} }), false);
  assert.equal(supportsEvents({ extensions: {} }), false);
});

test('events/list follows nextCursor', async (t) => {
  const { url, seen } = await stub(t, [
    json({ events: [{ name: 'a', delivery: ['webhook'] }], nextCursor: 'page2' }),
    json({ events: [{ name: 'b', delivery: ['poll'], description: 'd' }] }),
  ]);
  const events = await listEvents(new McpClient({ url, token: 't' }));
  assert.deepEqual(
    events.map((e) => [e.name, e.delivery]),
    [
      ['a', ['webhook']],
      ['b', ['poll']],
    ],
  );
  assert.equal(seen[1]!.body.params.cursor, 'page2');
});

test('events/subscribe sends the webhook delivery and parses the grant', async (t) => {
  const { url, seen } = await stub(t, [
    json({ resultType: 'complete', id: 'sub_1', refreshBefore: '2026-10-06T12:00:00Z', cursor: 'c9', truncated: true, deliveryStatus: { active: false } }),
    json({ id: 'sub_1', refreshBefore: null }),
  ]);
  const client = new McpClient({ url, token: 't' });
  const grant = await subscribe(client, { name: 'e', arguments: { a: 1 }, url: 'https://h/hooks/x', secret: 'whsec_x', cursor: null });
  assert.deepEqual(grant, {
    id: 'sub_1',
    refreshBefore: Date.parse('2026-10-06T12:00:00Z'),
    cursor: 'c9',
    truncated: true,
    deliveryStatus: { active: false },
  });
  assert.deepEqual(seen[0]!.body.params.delivery, { mode: 'webhook', url: 'https://h/hooks/x', secret: 'whsec_x' });
  assert.equal(seen[0]!.body.params.cursor, null);
  assert.equal('ttlMs' in seen[0]!.body.params, false, 'server default TTL');

  const minimal = await subscribe(client, { name: 'e', arguments: {}, url: 'u', secret: 's', cursor: 'c9' });
  assert.deepEqual(minimal, { id: 'sub_1', refreshBefore: null, cursor: null, truncated: false, deliveryStatus: undefined });
});

test('error names cover both numberings; NotFound on unsubscribe counts as success', async (t) => {
  for (const code of [-32011, -32023]) assert.equal(errorName(new McpError(code, '')), 'NotFound');
  for (const code of [-32015, -32027]) assert.equal(errorName(new McpError(code, '')), 'CallbackEndpointError');
  assert.equal(
    describeError(new McpError(-32027, 'verification failed', { reason: 'challenge_failed' })),
    'CallbackEndpointError -32027 (challenge_failed): verification failed',
  );

  const { url, seen } = await stub(t, [
    error(200, -32023, 'Not found', { kind: 'subscription' }),
    error(200, -32012, 'Forbidden'),
  ]);
  const client = new McpClient({ url, token: 't' });
  await unsubscribe(client, { name: 'e', arguments: {}, url: 'https://h/hooks/x' });
  assert.deepEqual(seen[0]!.body.params.delivery, { mode: 'webhook', url: 'https://h/hooks/x' });
  await assert.rejects(unsubscribe(client, { name: 'e', arguments: {}, url: 'u' }), (err: unknown) => errorName(err) === 'Forbidden');
});
