// An MCP Events server written from OpenAI's "MCP Events" guide for ChatGPT
// (docs/spec/openai-mcp-events-2026-10-06.md, kept local only), as literally as it allows. It is an
// interop target for evdock's client, written from a different document than the SEP-3415 mock.
//
// Where the guide is silent it follows the 2026-07-28 base protocol snapshot (docs/spec/mcp-2026-07-28/)
// and the events draft the guide cites (lines 18, 344). Where they disagree the guide wins, marked
// "Guide over spec". "Line N" means line N of the guide.
//
// Test fixture, not shipped: imports nothing from src/.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type AddressInfo, type LookupFunction } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { Webhook } from 'standardwebhooks';

export interface OpenAiServerOptions {
  token: string; // static bearer token; principal = token
  storePath: string; // JSON file for persistent subscription storage
  defaultTtlMs: number; // lifetime granted when ttlMs is omitted or null; also the most ever granted
  maxAttempts: number; // delivery attempts incl. the first
  baseDelayMs: number; // backoff base: retry k waits baseDelayMs * 2^(k-1)
  allowInsecureCallbacks?: boolean; // TEST ONLY: accept http:// and loopback callbacks (the guide requires HTTPS and blocks private/local addresses); default false
  host?: string;
  port?: number; // default 127.0.0.1, port 0
  minTtlMs?: number; // floor for a requested ttlMs (line 275); default min(1000, defaultTtlMs)
  now?: () => number; // clock for expiry and the verification cache; tests override it
}

export interface OpenAiServer {
  url: string; // MCP endpoint, e.g. http://127.0.0.1:PORT/mcp
  emit(name: string, data: Record<string, unknown>): { eventId: string }; // deliver to matching subscriptions
  idle(): Promise<void>; // resolves once every delivery, retries included, has finished
  close(): Promise<void>; // stop HTTP and timers (store stays on disk)
}

const PROTOCOL_VERSION = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const VERIFIED_FOR_MS = 60 * 60 * 1000; // line 172: cache verification "for a bounded period"
const VERIFY_TIMEOUT_MS = 10_000; // same as the guide's delivery timeout

// The guide's example definition (lines 65-91), verbatim.
const COMMENT_CREATED = {
  name: 'comment.created',
  description: 'A new review comment was added to the specified document.',
  delivery: ['webhook'],
  inputSchema: {
    type: 'object',
    properties: {
      document_id: {
        type: 'string',
        description: 'ID of the document to monitor for new review comments.',
      },
    },
    required: ['document_id'],
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      document_id: { type: 'string' },
      comment_id: { type: 'string' },
      text: { type: 'string' },
      url: { type: 'string' },
    },
    required: ['document_id', 'comment_id', 'text', 'url'],
    additionalProperties: false,
  },
};

interface Subscription {
  id: string;
  principal: string;
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  expiresAt: number;
}

interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: null;
}

type WebhookFetch = (url: string, init: RequestInit) => Promise<Response>;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly httpStatus = 200, // method-level errors ride a 200; transport-level ones set 400 or 404
  ) {
    super(message);
  }
}

const invalidParams = (detail: string) => new RpcError(-32602, `Invalid params: ${detail}`);
const headerMismatch = (detail: string) => new RpcError(-32020, `Header mismatch: ${detail}`, undefined, 400);

// The guide only numbers -32015 (line 172), which is the draft's numbering, so the other event errors use the
// draft's codes too (design sketch: -32011 NotFound, -32014 Unsupported). Guide over spec: SEP-3415 renumbers
// them to -32023..-32027, and the base protocol says new implementations SHOULD NOT use -32000..-32019.
const notFoundEvent = () => new RpcError(-32011, 'NotFound', { kind: 'event' });
const callbackError = (reason: string) => new RpcError(-32015, 'CallbackEndpointError', { reason });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Line 151: canonical JSON, so key order does not create a different subscription.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Line 134: deterministic over principal, callback URL, event name and arguments.
function subscriptionId(principal: string, url: string, name: string, args: unknown): string {
  const digest = createHash('sha256').update(canonical([principal, url, name, args])).digest('hex');
  return `sub_${digest.slice(0, 32)}`;
}

// Constant time regardless of length: compare digests.
function sameString(a: string, b: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

// Line 130 plus the inputSchema above.
function checkArguments(args: unknown): Record<string, unknown> {
  if (!isObject(args)) throw invalidParams('arguments must be an object');
  if (typeof args.document_id !== 'string') throw invalidParams('arguments.document_id must be a string');
  const extra = Object.keys(args).find((k) => k !== 'document_id');
  if (extra !== undefined) throw invalidParams(`unexpected argument ${JSON.stringify(extra)}`);
  return args;
}

// Line 130: whsec_ plus base64 that decodes to 24-64 bytes.
function checkSecret(secret: unknown): string {
  const b64 = typeof secret === 'string' && secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : '';
  const wellFormed = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64);
  const bytes = wellFormed ? Buffer.from(b64, 'base64').length : 0;
  if (bytes < 24 || bytes > 64) throw invalidParams('delivery.secret must be whsec_ followed by base64 of 24-64 bytes');
  return secret as string;
}

// Line 174: HTTPS only. The address check happens per connection, in webhookFetch.
function checkCallbackUrl(url: unknown, insecure: boolean): string {
  if (typeof url !== 'string' || !URL.canParse(url)) throw invalidParams('delivery.url must be an absolute URL');
  const { protocol } = new URL(url);
  if (protocol !== 'https:' && !(insecure && protocol === 'http:')) throw invalidParams('delivery.url must be https');
  return url;
}

// Line 174: block private, local and other non-public addresses (IANA special-purpose registries).
// IPv6 counts as public only inside global unicast 2000::/3, minus its special blocks; that also
// excludes ::1, fc00::/7, fe80::/10 and v4-mapped addresses.
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !NON_PUBLIC.check(address, 'ipv4');
  return GLOBAL_UNICAST_V6.check(address, 'ipv6') && !NON_PUBLIC.check(address, 'ipv6');
}

// Runs at connection time and the socket connects to the address it returns, so the validated
// address is the one used, while TLS still verifies the original hostname (line 174).
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const all = typeof address === 'string' ? [address] : address.map((a) => a.address);
    const blocked = all.find((a) => !isPublicAddress(a));
    if (blocked !== undefined) {
      const error = Object.assign(new Error(`callback resolves to non-public ${blocked}`), { code: 'EBLOCKED' });
      return callback(error, address, family);
    }
    callback(null, address, family);
  });
};

// Line 221: "a webhookFetch function with the same interface as fetch that validates callback
// addresses on each connection and blocks redirects". Global fetch cannot pin a validated address
// without undici, so this is fetch's interface over node:http(s), one fresh connection per request.
function makeWebhookFetch(insecure: boolean, closing: AbortSignal): WebhookFetch {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (!insecure) {
        if (target.protocol !== 'https:') return reject(new TypeError('callback URL must be https'));
        // IP literals never reach the lookup hook.
        const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
        if (isIP(host) && !isPublicAddress(host)) return reject(new TypeError(`callback address ${host} is not public`));
      }
      const options: RequestOptions = {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        signal: AbortSignal.any(init.signal ? [init.signal, closing] : [closing]),
        agent: false,
        ...(insecure ? {} : { lookup: publicOnlyLookup }),
      };
      const onResponse = (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          // Never followed, whatever init.redirect says (line 174: "do not follow redirects").
          if (status >= 300 && status < 400) return reject(new TypeError(`redirect blocked (${status})`));
          const noBody = status === 204 || status === 205 || status === 304;
          resolve(new Response(noBody ? null : Buffer.concat(chunks).toString('utf8'), { status }));
        });
      };
      const req =
        target.protocol === 'https:' ? httpsRequest(target, options, onResponse) : httpRequest(target, options, onResponse);
      req.on('error', reject);
      req.end(typeof init.body === 'string' ? init.body : undefined);
    });
}

// The guide's "Send a signed event with Node.js" sample (lines 226-251), same logic with types:
// serialize once, sign exactly those bytes with the official library, send exactly those bytes.
async function sendEvent(
  subscription: Pick<Subscription, 'id' | 'url' | 'secret'>,
  event: EventOccurrence,
  webhookFetch: WebhookFetch,
): Promise<{ accepted: boolean; status: number }> {
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body, 'utf8') > 256 * 1024) {
    throw new Error('Event payload exceeds 256 KiB');
  }

  const signedAt = new Date();
  const signer = new Webhook(subscription.secret);
  const response = await webhookFetch(subscription.url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': event.eventId,
      'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
      'webhook-signature': signer.sign(event.eventId, signedAt, body),
      'X-MCP-Subscription-Id': subscription.id,
    },
    body,
  });

  return { accepted: response.ok, status: response.status };
}

// lastError categories from the draft; the guide names challenge_failed and timeout (line 172).
function failureReason(err: unknown): string {
  const { name, code } = err as { name?: string; code?: string };
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (/^(ERR_TLS|ERR_SSL|ERR_OSSL|EPROTO|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(code ?? '')) return 'tls_error';
  return 'connection_refused'; // also an address we refused to connect to
}

function loadStore(path: string): Map<string, Subscription> {
  if (!existsSync(path)) return new Map();
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { subscriptions: Subscription[] };
  return new Map(stored.subscriptions.map((s) => [s.id, s]));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startOpenAiServer(options: OpenAiServerOptions): Promise<OpenAiServer> {
  const now = options.now ?? Date.now;
  const insecure = options.allowInsecureCallbacks ?? false;
  const minTtlMs = options.minTtlMs ?? Math.min(1000, options.defaultTtlMs);
  const closing = new AbortController();
  const webhookFetch = makeWebhookFetch(insecure, closing.signal);
  // Line 269: retain subscriptions across restarts. Verification results stay in memory (SEP-3415): a stored
  // subscription exists only because it was verified, so it resumes delivery without a new challenge.
  const subscriptions = loadStore(options.storePath);
  const verifiedUntil = new Map<string, number>(); // `${principal} ${url}` -> expiry
  const inflight = new Set<Promise<void>>();

  function save(): void {
    for (const [id, s] of subscriptions) if (s.expiresAt <= now()) subscriptions.delete(id);
    const tmp = `${options.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ subscriptions: [...subscriptions.values()] }, null, 2));
    renameSync(tmp, options.storePath);
  }

  // Lines 275-277. ttlMs: null asks for no expiry; this server always grants a finite lifetime, which line 277 allows.
  function grantTtl(ttlMs: unknown): number {
    if (ttlMs === undefined || ttlMs === null) return options.defaultTtlMs;
    if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
      throw invalidParams('ttlMs must be a non-negative integer or null');
    }
    return Math.max(minTtlMs, Math.min(ttlMs, options.defaultTtlMs));
  }

  // Lines 153-172: a signed challenge, echoed in a 2xx body, compared in constant time, cached per
  // (principal, url). Any reachable response without the echo is challenge_failed (SEP-3415).
  async function verifyCallback(principal: string, sub: Pick<Subscription, 'id' | 'url' | 'secret'>): Promise<void> {
    const cacheKey = `${principal} ${sub.url}`;
    if ((verifiedUntil.get(cacheKey) ?? 0) > now()) return;
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    const webhookId = `msg_verification_${randomBytes(12).toString('hex')}`;
    const signedAt = new Date();
    let response: Response;
    try {
      response = await webhookFetch(sub.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
          'webhook-signature': new Webhook(sub.secret).sign(webhookId, signedAt, body),
          'X-MCP-Subscription-Id': sub.id,
        },
        body,
      });
    } catch (err) {
      throw callbackError(failureReason(err));
    }
    let echoed: unknown;
    try {
      echoed = response.ok ? (JSON.parse(await response.text()) as { challenge?: unknown }).challenge : undefined;
    } catch {
      echoed = undefined;
    }
    if (typeof echoed !== 'string' || !sameString(echoed, challenge)) throw callbackError('challenge_failed');
    verifiedUntil.set(cacheKey, now() + VERIFIED_FOR_MS);
  }

  // Lines 103-151. Guide over spec: the result is exactly the guide's (no resultType); cursor is
  // always null and truncated false, since comment.created has no replay (lines 149, 281).
  async function subscribe(params: Record<string, unknown>): Promise<unknown> {
    if (typeof params.name !== 'string') throw invalidParams('name must be a string');
    if (params.name !== COMMENT_CREATED.name) throw notFoundEvent();
    const args = checkArguments(params.arguments);
    const delivery = params.delivery;
    if (!isObject(delivery)) throw invalidParams('delivery must be an object');
    if (delivery.mode !== 'webhook') throw new RpcError(-32014, 'Unsupported', { feature: 'deliveryMode', value: delivery.mode });
    const url = checkCallbackUrl(delivery.url, insecure);
    const secret = checkSecret(delivery.secret);
    if (params.cursor !== undefined && params.cursor !== null && typeof params.cursor !== 'string') {
      throw invalidParams('cursor must be a string or null');
    }
    const ttl = grantTtl(params.ttlMs);
    // Line 129: the single static-token principal may watch any document.
    const principal = options.token;
    const id = subscriptionId(principal, url, params.name, args);
    await verifyCallback(principal, { id, url, secret });
    // Same identity: an update (line 151), new secret and expiry (lines 273, 279). The guide also asks to
    // dual-sign during a rotation window (line 279); not done, since sendEvent signs as the guide's sample does.
    const expiresAt = now() + ttl;
    subscriptions.set(id, { id, principal, name: params.name, arguments: args, url, secret, expiresAt });
    save();
    return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
  }

  // Lines 283-315. Guide over spec: no match is not NotFound but the same {}.
  function unsubscribe(params: Record<string, unknown>): unknown {
    const { name, arguments: args, delivery } = params;
    if (typeof name !== 'string' || !isObject(args) || !isObject(delivery) || typeof delivery.url !== 'string') {
      throw invalidParams('name, arguments and delivery.url are required');
    }
    if (subscriptions.delete(subscriptionId(options.token, delivery.url, name, args))) save();
    return {};
  }

  // Lines 99-101: one page, so no nextCursor, and no cursor of ours to accept. Guide over spec: no resultType.
  function listEvents(params: Record<string, unknown>): unknown {
    if (params.cursor !== undefined && params.cursor !== null) throw invalidParams('unknown cursor');
    return { events: [COMMENT_CREATED] };
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      // Lines 30-45, exactly. Guide over spec: events is a top-level capability, not
      // extensions["io.modelcontextprotocol/events"] (SEP-3415); no serverInfo in _meta.
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {}, events: {} } };
      case 'tools/list': // advertised above, so answered: no tools
        return { resultType: 'complete', tools: [] };
      case 'events/list':
        return listEvents(params);
      case 'events/subscribe':
        return subscribe(params);
      case 'events/unsubscribe':
        return unsubscribe(params);
      default:
        throw new RpcError(-32601, 'Method not found', undefined, 404);
    }
  }

  // streamable-http.mdx "Request Metadata" and basic-index.mdx "_meta".
  function checkRequestMetadata(req: IncomingMessage, method: string, params: unknown): Record<string, unknown> {
    const version = header(req, 'mcp-protocol-version');
    if (version === undefined) throw headerMismatch('MCP-Protocol-Version is required');
    if (version !== PROTOCOL_VERSION) {
      throw new RpcError(-32022, 'Unsupported protocol version', { supported: [PROTOCOL_VERSION], requested: version }, 400);
    }
    if (header(req, 'mcp-method') !== method) throw headerMismatch('Mcp-Method must match the body method');
    const meta = isObject(params) && isObject(params._meta) ? params._meta : undefined;
    if (meta === undefined || typeof meta[META_VERSION] !== 'string' || !isObject(meta[META_CAPABILITIES])) {
      throw new RpcError(-32602, `Invalid params: _meta must carry ${META_VERSION} and ${META_CAPABILITIES}`, undefined, 400);
    }
    if (meta[META_VERSION] !== version) throw headerMismatch(`MCP-Protocol-Version does not match _meta ${META_VERSION}`);
    return params as Record<string, unknown>;
  }

  function bearerOk(authorization: string | undefined): boolean {
    const match = /^Bearer (.+)$/i.exec(authorization ?? '');
    return match !== null && sameString(match[1]!, options.token);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const rpcError = (status: number, id: unknown, code: number, message: string, data?: unknown) =>
      json(status, { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

    if ((req.url ?? '').split('?')[0] !== '/mcp') return void res.writeHead(404).end();
    // Only POST since 2026-07-28; GET and DELETE get 405 (streamable-http.mdx, backward compatibility).
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    // MUST reject an invalid Origin with 403; this server serves no browser origin, so any Origin is invalid.
    if (req.headers.origin !== undefined) return void res.writeHead(403).end();
    if (!bearerOk(req.headers.authorization)) return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();

    let message: unknown;
    try {
      message = JSON.parse(await readBody(req));
    } catch {
      return rpcError(400, null, -32700, 'Parse error');
    }
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(400, isObject(message) ? (message.id ?? null) : null, -32600, 'Invalid Request');
    }
    if (!('id' in message)) return void res.writeHead(202).end(); // a notification
    const { id, method } = message;
    if (typeof id !== 'string' && !Number.isSafeInteger(id)) return rpcError(400, null, -32600, 'Invalid Request');

    try {
      const params = checkRequestMetadata(req, method, message.params);
      json(200, { jsonrpc: '2.0', id, result: await dispatch(method, params) });
    } catch (err) {
      if (err instanceof RpcError) return rpcError(err.httpStatus, id, err.code, err.message, err.data);
      rpcError(500, id, -32603, 'Internal error');
    }
  }

  // Lines 257-263: one event per request; retry transient failures with exponential backoff and bounded
  // attempts, same eventId, fresh timestamp and signature (sendEvent signs per call); never retry 410 or 413.
  // Every non-2xx other than those counts as transient. Unsubscribe, expiry and close stop retries too.
  async function deliver(id: string, event: EventOccurrence): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const sub = subscriptions.get(id);
      if (closing.signal.aborted || sub === undefined || sub.expiresAt <= now()) return;
      const outcome = await sendEvent(sub, event, webhookFetch).catch(() => undefined);
      if (outcome !== undefined && (outcome.accepted || outcome.status === 410 || outcome.status === 413)) return;
      if (attempt >= options.maxAttempts) return;
      await sleep(options.baseDelayMs * 2 ** (attempt - 1), undefined, { signal: closing.signal });
    }
  }

  // Lines 176-195. No replay, so cursor is null (lines 149, 281). Guide over spec: no gap or
  // terminated envelopes are ever sent (line 18).
  function emit(name: string, data: Record<string, unknown>): { eventId: string } {
    const event: EventOccurrence = { eventId: `evt_${randomUUID()}`, name, timestamp: new Date().toISOString(), data, cursor: null };
    // Same bytes for every subscription, so check the 256 KiB cap once, up front (line 261).
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > 256 * 1024) throw new Error('Event payload exceeds 256 KiB');
    for (const sub of subscriptions.values()) {
      // Line 99: filters are applied on the server, before delivery. deliver() skips expired ones.
      if (sub.name !== name || sub.arguments.document_id !== data.document_id) continue;
      const pending = deliver(sub.id, event).catch(() => {});
      inflight.add(pending);
      void pending.finally(() => inflight.delete(pending));
    }
    return { eventId: event.eventId };
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) await Promise.all(inflight);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  let closed: Promise<void> | undefined;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`,
    emit,
    idle,
    close: () =>
      (closed ??= (async () => {
        closing.abort();
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await stopped;
        await idle();
      })()),
  };
}
